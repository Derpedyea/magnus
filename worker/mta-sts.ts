import { isCloudflareMx, type Permission, type StepStatus } from "#shared";
import { z } from "zod";
import type { DomainContext, RunOptions } from "./connect";

// MTA-STS (RFC 8461) tells sending servers to deliver a domain's mail only over TLS, and only to the MX hosts its
// policy names. Email Routing's MX hosts are Cloudflare's, so Cloudflare publishes the policy and its id. A domain
// opts in by pointing `_mta-sts.<domain>` at that id and serving the policy at `mta-sts.<domain>`. The last step of
// turning a domain on (connect.ts) sets both up, and this Worker serves the policy.

export const POLICY_PATH = "/.well-known/mta-sts.txt";
/** The TXT record holding the id of Cloudflare's policy. A domain's `_mta-sts` CNAME points here. */
const POLICY_ID = "_mta-sts.mx.cloudflare.net";
const UPSTREAM = `https://mta-sts.mx.cloudflare.net${POLICY_PATH}`;

// ─── Serving the policy ──────────────────────────────────────────────────────────

/**
 * Cloudflare's policy, proxied (senders don't follow redirects), for `mta-sts.<domain>` while Magnus receives the
 * domain's mail and its MX records still point at Cloudflare. Otherwise there's no policy, which senders treat as
 * no MTA-STS once a cached one expires (a day). So a domain that moves its mail elsewhere isn't held to Cloudflare.
 */
export async function mtaStsPolicy(host: string, receives: (domain: string) => Promise<boolean>): Promise<Response> {
	const domain = host.toLowerCase().match(/^mta-sts\.(.+)$/)?.[1];
	if (!domain || !(await receives(domain)) || !(await mxIsCloudflare(domain))) return new Response("Not found", { status: 404 });
	const upstream = await fetch(UPSTREAM);
	// Never stand in a policy of our own: a wrong one turns mail away.
	if (!upstream.ok) return new Response(`Cloudflare's policy answered ${upstream.status}`, { status: 502 });
	return new Response(await upstream.text(), { headers: { "Content-Type": "text/plain" } });
}

const MX = 15;
const NXDOMAIN = 3;
const DnsAnswer = z.object({ Status: z.number(), Answer: z.array(z.object({ type: z.number(), data: z.string() })).default([]) });

/** What the domain's MX records say right now, over DNS-over-HTTPS since Workers have no resolver. */
async function mxIsCloudflare(domain: string): Promise<boolean> {
	const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { Accept: "application/dns-json" } });
	if (!res.ok) throw new Error(`MX lookup for ${domain} answered ${res.status}`);
	const { Status, Answer } = DnsAnswer.parse(await res.json());
	if (Status === NXDOMAIN) return false;
	if (Status !== 0) throw new Error(`MX lookup for ${domain} failed with DNS status ${Status}`);
	// Each answer is "<preference> <host>".
	const hosts = Answer.filter((a) => a.type === MX).map((a) => a.data.split(" ")[1] ?? "");
	return hosts.length > 0 && hosts.every(isCloudflareMx);
}

// ─── Setting it up (the connect step) ───────────────────────────────────────────

/** Only Cloudflare is touched, never the directory. */
type ZoneContext = Omit<DomainContext, "db">;

const DnsRecord = z.object({ id: z.string(), type: z.string(), name: z.string(), content: z.string(), proxied: z.boolean().default(false) });
const Route = z.object({ id: z.string(), pattern: z.string(), script: z.string().optional() });
/** Records that decide where requests for a name go; others (a verification TXT, say) can stay beside ours. */
const ADDRESS = new Set(["A", "AAAA", "CNAME"]);

/** Something another MTA-STS setup left that stops ours from working, and how to delete it. */
interface Blocker {
	label: string;
	need: Permission;
	path: string;
}

/**
 * The three parts: the `_mta-sts` CNAME to Cloudflare's policy id, a proxied `mta-sts.<domain>` for requests to
 * arrive on, and the route sending its policy path to this Worker. Plus whatever is in their way.
 */
async function parts(ctx: ZoneContext) {
	const records = (name: string) => ctx.cf.get(z.array(DnsRecord), "dns", `/zones/${ctx.zoneId}/dns_records?name=${name}&per_page=50`);
	const pattern = `mta-sts.${ctx.domain}${POLICY_PATH}`;
	const [ids, hosts, routes] = await Promise.all([
		records(`_mta-sts.${ctx.domain}`),
		records(`mta-sts.${ctx.domain}`),
		ctx.cf.get(z.array(Route), "routes", `/zones/${ctx.zoneId}/workers/routes`),
	]);
	// Proxied, the CNAME would hide Cloudflare's TXT record from senders.
	const ours = (r: z.infer<typeof DnsRecord>) => r.type === "CNAME" && !r.proxied && r.content.toLowerCase().replace(/\.$/, "") === POLICY_ID;
	const existing = routes.find((r) => r.pattern === pattern);
	const record = (r: z.infer<typeof DnsRecord>): Blocker => ({ label: `the ${r.type} record at ${r.name}`, need: "dns", path: `/zones/${ctx.zoneId}/dns_records/${r.id}` });
	return {
		pattern,
		id: ids.find(ours),
		host: hosts.find((r) => r.proxied),
		route: existing?.script === ctx.install.workerName ? existing : undefined,
		// Another policy (usually the old provider's, naming its MX hosts): its id, a host requests can't reach us on,
		// or a route sending the policy path to another Worker.
		inTheWay: [
			...ids.filter((r) => !ours(r)).map(record),
			...hosts.filter((r) => ADDRESS.has(r.type) && !r.proxied).map(record),
			...(existing && existing.script !== ctx.install.workerName
				? [{ label: `the Workers route ${existing.pattern}`, need: "routes" as const, path: `/zones/${ctx.zoneId}/workers/routes/${existing.id}` }]
				: []),
		],
	};
}

export async function mtaStsStatus(ctx: ZoneContext): Promise<StepStatus> {
	const { id, host, route, inTheWay } = await parts(ctx);
	if (inTheWay.length > 0) {
		const labels = inTheWay.map((b) => b.label).join(" and ");
		return { state: "failed", detail: `${ctx.domain} already has an MTA-STS policy. Delete ${labels} in Cloudflare, then check again.` };
	}
	return id && host && route ? { state: "done" } : { state: "todo" };
}

export async function publishMtaSts(ctx: ZoneContext, options: RunOptions, before: StepStatus): Promise<StepStatus> {
	const { pattern, id, host, route, inTheWay } = await parts(ctx);
	// Moving mail here (confirmed with the MX records) takes the old provider's policy with it: left in place, senders
	// that check it would refuse to deliver to Cloudflare. Anything else is the admin's to remove.
	if (inTheWay.length > 0 && !options.moveMail) return before;
	for (const blocker of inTheWay) await ctx.cf.delete(blocker.need, blocker.path);
	// Serve the policy before announcing it, so a sender that finds the id can always fetch the policy.
	// 100:: is Cloudflare's documented placeholder for a proxied host that only a Worker answers.
	if (!host) {
		await ctx.cf.post(z.unknown(), "dns", `/zones/${ctx.zoneId}/dns_records`, {
			type: "AAAA",
			name: `mta-sts.${ctx.domain}`,
			content: "100::",
			proxied: true,
			comment: "Magnus: serves the MTA-STS policy",
		});
	}
	if (!route) await ctx.cf.post(z.unknown(), "routes", `/zones/${ctx.zoneId}/workers/routes`, { pattern, script: ctx.install.workerName });
	if (!id) {
		await ctx.cf.post(z.unknown(), "dns", `/zones/${ctx.zoneId}/dns_records`, {
			type: "CNAME",
			name: `_mta-sts.${ctx.domain}`,
			content: POLICY_ID,
			proxied: false,
			comment: "Magnus: Cloudflare's MTA-STS policy id",
		});
	}
	return { state: "done" };
}
