import { isCloudflareMx, mailHost, type StepId, type StepStatus } from "#shared";
import { z } from "zod";
import { type Cloudflare, mxRecords } from "./cloudflare";
import { setDomainFlag } from "./directory";
import type { Install } from "./settings";

// Turning a domain on in Cloudflare, one step at a time (shared/cloudflare.ts STEPS), so the page can show each
// one land. Every step checks before it acts, which makes it safe to repeat, and keeps the directory's
// receiving/sending flags in line with what Cloudflare reports.

export interface DomainContext {
	cf: Cloudflare;
	db: D1Database;
	install: Install;
	domain: string;
	zoneId: string;
}

export interface RunOptions {
	/** The domain gets mail elsewhere today, and the admin confirmed moving it (this replaces its MX records). */
	moveMail?: boolean;
}

const EVENTS = ["message.delivered", "message.deferred", "message.bounced", "message.failed", "message.rejected", "message.complained"];

const Routing = z.object({ enabled: z.boolean(), status: z.string().optional() });
const CatchAll = z.object({ enabled: z.boolean(), actions: z.array(z.object({ type: z.string(), value: z.array(z.string()).optional() })) });
const SendingDomain = z.object({ tag: z.string(), name: z.string(), enabled: z.boolean() });
const DnsStatus = z.object({ errors: z.array(z.object({ code: z.string() })).default([]) });
// The API reference names a consumer's Worker `script_name`, but the list endpoint answers with `script`.
const Queue = z.object({
	queue_id: z.string(),
	consumers: z.array(z.object({ script: z.string().optional(), script_name: z.string().optional() })).default([]),
	producers: z.array(z.object({ script: z.string().optional() })).default([]),
});
const Subscription = z.object({ source: z.object({ domain: z.string().optional() }) });

const done: StepStatus = { state: "done" };

async function routingStatus(ctx: DomainContext): Promise<StepStatus> {
	const routing = await ctx.cf.get(Routing, "zoneSettings", `/zones/${ctx.zoneId}/email/routing`);
	if (!routing.enabled) return { state: "todo" };
	if (routing.status === "ready") return done;
	return { state: "pending", detail: "Waiting for Cloudflare to publish the MX records." };
}

async function catchAllStatus(ctx: DomainContext): Promise<StepStatus> {
	const rule = await ctx.cf.get(CatchAll, "routingRules", `/zones/${ctx.zoneId}/email/routing/rules/catch_all`);
	const toUs = rule.enabled && rule.actions.some((a) => a.type === "worker" && a.value?.includes(ctx.install.workerName));
	return toUs ? done : { state: "todo" };
}

async function sendingDomain(ctx: DomainContext) {
	const domains = await ctx.cf.get(z.array(SendingDomain), "sending", `/zones/${ctx.zoneId}/email/sending/subdomains`);
	return domains.find((d) => d.name === ctx.domain && d.enabled) ?? null;
}

async function sendingStatus(ctx: DomainContext): Promise<StepStatus> {
	const sending = await sendingDomain(ctx);
	if (!sending) return { state: "todo" };
	const { errors } = await ctx.cf.get(DnsStatus, "sending", `/zones/${ctx.zoneId}/email/sending/subdomains/${sending.tag}/dns/status`);
	const [first] = errors;
	if (!first) return done;
	// Missing records are Cloudflare still publishing them; anything else is a record in the way.
	if (first.code.endsWith(".missing")) return { state: "pending", detail: "Waiting for Cloudflare to publish SPF and DKIM." };
	return { state: "failed", detail: `Cloudflare found a DNS problem (${first.code}). Open Email Sending for ${ctx.domain} in the dashboard to fix it.` };
}

/** The queue this Worker consumes but doesn't produce to: the one delivery events belong on. */
async function eventsQueue(ctx: DomainContext) {
	const queues = await ctx.cf.get(z.array(Queue), "queues", `/accounts/${ctx.install.accountId}/queues`);
	const name = ctx.install.workerName;
	return queues.find((q) => q.consumers.some((c) => (c.script ?? c.script_name) === name) && !q.producers.some((p) => p.script === name)) ?? null;
}

async function eventsStatus(ctx: DomainContext): Promise<StepStatus> {
	const queue = await eventsQueue(ctx);
	if (!queue) return { state: "failed", detail: "Couldn't find this Worker's delivery-events queue." };
	const subscriptions = await ctx.cf.get(z.array(Subscription), "queues", `/accounts/${ctx.install.accountId}/event_subscriptions/subscriptions?queue_id=${queue.queue_id}`);
	return subscriptions.some((s) => s.source.domain === ctx.domain) ? done : { state: "todo" };
}

const STATUS: Record<StepId, (ctx: DomainContext) => Promise<StepStatus>> = {
	routing: routingStatus,
	"catch-all": catchAllStatus,
	sending: sendingStatus,
	events: eventsStatus,
};

/** Every step's state, read-only apart from syncing the domain's flags. */
export async function domainStatus(ctx: DomainContext): Promise<Record<StepId, StepStatus>> {
	const [routing, catchAll, sending, events] = await Promise.all([routingStatus(ctx), catchAllStatus(ctx), sendingStatus(ctx), eventsStatus(ctx)]);
	await syncFlags(ctx, { receiving: routing.state === "done" && catchAll.state === "done", sending: sending.state === "done" });
	return { routing, "catch-all": catchAll, sending, events };
}

export async function runStep(ctx: DomainContext, step: StepId, options: RunOptions): Promise<StepStatus> {
	const before = await STATUS[step](ctx);
	const status = before.state === "done" ? before : await act(ctx, step, options, before);
	// Whether it just happened or was already so, the directory follows what Cloudflare says.
	if (step === "catch-all") await syncFlags(ctx, { receiving: status.state === "done" && (await routingStatus(ctx)).state === "done" });
	if (step === "sending") await syncFlags(ctx, { sending: status.state === "done" });
	return status;
}

async function act(ctx: DomainContext, step: StepId, options: RunOptions, before: StepStatus): Promise<StepStatus> {
	switch (step) {
		case "routing": {
			const foreign = (await mxRecords(ctx.cf, ctx.zoneId)).filter((r) => !isCloudflareMx(r.content));
			if (foreign.length > 0) {
				const host = mailHost(foreign.map((r) => r.content));
				const provider = host.kind === "other" ? host.provider : "another provider";
				if (!options.moveMail) return { state: "failed", detail: `${ctx.domain} gets mail at ${provider} today.`, needsMoveMail: true };
				// Email Routing can't share the apex with another provider's MX records.
				for (const record of foreign) await ctx.cf.delete("dns", `/zones/${ctx.zoneId}/dns_records/${record.id}`);
			}
			await ctx.cf.post(z.unknown(), "zoneSettings", `/zones/${ctx.zoneId}/email/routing/enable`, {});
			return routingStatus(ctx);
		}
		case "catch-all":
			await ctx.cf.put(z.unknown(), "routingRules", `/zones/${ctx.zoneId}/email/routing/rules/catch_all`, {
				name: "Magnus",
				enabled: true,
				matchers: [{ type: "all" }],
				actions: [{ type: "worker", value: [ctx.install.workerName] }],
			});
			return done;
		case "sending":
			await ctx.cf.post(z.unknown(), "sending", `/zones/${ctx.zoneId}/email/sending/subdomains`, { name: ctx.domain });
			return sendingStatus(ctx);
		case "events": {
			const queue = await eventsQueue(ctx);
			if (!queue) return before;
			await ctx.cf.post(z.unknown(), "queues", `/accounts/${ctx.install.accountId}/event_subscriptions/subscriptions`, {
				name: `Magnus ${ctx.domain}`,
				enabled: true,
				source: { type: "email.sending", zone_id: ctx.zoneId, domain: ctx.domain },
				destination: { type: "queues.queue", queue_id: queue.queue_id },
				events: EVENTS,
			});
			return done;
		}
	}
}

async function syncFlags(ctx: DomainContext, flags: { receiving?: boolean; sending?: boolean }): Promise<void> {
	if (flags.receiving !== undefined) await setDomainFlag(ctx.db, ctx.domain, "receiving", flags.receiving);
	if (flags.sending !== undefined) await setDomainFlag(ctx.db, ctx.domain, "sending", flags.sending);
}
