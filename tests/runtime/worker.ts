import { WorkerEntrypoint } from "cloudflare:workers";
import { type InboundJob, type SendInput } from "#shared";
import { z } from "zod";
import { app } from "../../worker/api";
import { signInWithoutCode } from "../../worker/auth";
import { email, queue } from "../../worker/mail/inbound";
import { ingest } from "../../worker/mail/ingest";
import { Mailbox as ProductionMailbox } from "../../worker/mailbox/mailbox";
import { NOW } from "./clock";

export { Vault } from "../../worker/vault";

type Operation = "get" | "put" | "delete" | "directory" | "queue";
type Hook = { operation: "get" | "put"; prefix: string; mailboxId: string; cancelMessageId?: string };
type Failure = { operation: Operation; prefix: string; remaining: number };

let now = NOW;
let jobs: InboundJob[] = [];
let sends: EmailMessageBuilder[] = [];
let sendErrors: string[] = [];
let failures: Failure[] = [];
let hook: Hook | null = null;

// Future alarms cannot fire on wall time; only drain() runs them. Restore the clock on every exit.
async function atTestTime<T>(run: () => Promise<T>): Promise<T> {
	const original = Date.now;
	Date.now = () => now;
	try {
		return await run();
	} finally {
		Date.now = original;
	}
}

function fail(operation: Operation, keys: string | string[] = ""): void {
	const match = failures.find((f) => f.operation === operation && f.remaining > 0 && [keys].flat().some((key) => key.startsWith(f.prefix)));
	if (match) {
		match.remaining--;
		throw new Error(`Injected ${operation} failure`);
	}
}

async function afterIO(env: Env, operation: "get" | "put", key: string): Promise<void> {
	if (!hook || hook.operation !== operation || !key.startsWith(hook.prefix)) return;
	const action = hook;
	hook = null;
	if (action.cancelMessageId) await env.MAILBOX.getByName(action.mailboxId).cancelSend(action.cancelMessageId);
	else await env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(action.mailboxId).run();
}

const JobSchema = z.object({
	v: z.literal(1), ingestId: z.string(), rawKey: z.string(), rawSize: z.number(), mailboxId: z.string(),
	envelopeFrom: z.string(), envelopeTo: z.string(), subaddress: z.string().nullable(), receivedAt: z.number(),
}) satisfies z.ZodType<InboundJob>;

// Real storage throughout. Only the provider, queue handoff, and explicit failure/race points are controlled.
function controlled(env: Env): Env {
	const MAIL = new Proxy(env.MAIL, {
		get(target, property) {
			if (property === "get") return async (...args: Parameters<R2Bucket["get"]>) => {
				fail("get", args[0]);
				const result = await target.get(...args);
				await afterIO(env, "get", args[0]);
				return result;
			};
			if (property === "put") return async (...args: Parameters<R2Bucket["put"]>) => {
				fail("put", args[0]);
				const result = await target.put(...args);
				await afterIO(env, "put", args[0]);
				return result;
			};
			if (property === "delete") return async (keys: string | string[]) => {
				fail("delete", keys);
				return target.delete(keys);
			};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const DIRECTORY = new Proxy(env.DIRECTORY, {
		get(target, property) {
			if (property === "prepare") return (sql: string) => {
				fail("directory", sql);
				return target.prepare(sql);
			};
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const INBOUND: Queue = {
		async sendBatch(batch) {
			fail("queue");
			jobs.push(...Array.from(batch, ({ body }) => JobSchema.parse(body)));
			return { metadata: { metrics: { backlogCount: jobs.length, backlogBytes: 0 } } };
		},
		async send(body) { return this.sendBatch([{ body }]); },
		async metrics() { return { backlogCount: jobs.length, backlogBytes: 0 }; },
	};
	const EMAIL: SendEmail = {
		async send(message: EmailMessage | EmailMessageBuilder) {
			if (!("subject" in message)) throw new Error("Expected a composed message");
			sends.push(message);
			const code = sendErrors.shift();
			if (code) throw Object.assign(new Error("Provider refused"), { code });
			return { messageId: `provider-${sends.length}@example.net` };
		},
	};
	return { ...env, MAIL, DIRECTORY, INBOUND, EMAIL };
}

export class Mailbox extends ProductionMailbox {
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, controlled(env)); }

	override enqueueSend(input: SendInput) { return atTestTime(() => super.enqueueSend(input)); }

	async drain() {
		await this.ctx.storage.deleteAlarm();
		await atTestTime(() => super.alarm());
	}

	alarmAt() { return this.ctx.storage.getAlarm(); }
}

export type TestEnv = Omit<Env, "MAILBOX"> & { MAILBOX: DurableObjectNamespace<Mailbox> };

export default class TestWorker extends WorkerEntrypoint<TestEnv> {
	override async fetch(request: Request) { return app.fetch(request, controlled(this.env), this.ctx); }
	override async email(message: ForwardableEmailMessage) { await atTestTime(() => email(message, controlled(this.env))); }
	login(address: string) { return signInWithoutCode(new Request("https://magnus.test/api/auth/sign-in/email-otp"), address); }
	parse(job: InboundJob) { return ingest(controlled(this.env), job); }
	setNow(value: number) { now = value; }
	setSendErrors(codes: string[]) { sendErrors = codes; }
	failNext(operation: Operation, prefix = "", count = 1) { failures.push({ operation, prefix, remaining: count }); }
	afterIO(action: Hook) { hook = action; }
	state() {
		return { jobs, sends: sends.map((message) => ({
			from: message.from, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.text, html: message.html,
			attachments: message.attachments?.map((a) => ({
				filename: a.filename, type: a.type, disposition: a.disposition, contentId: a.contentId,
				content: typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content),
			})),
		})) };
	}
	reset() { now = NOW; jobs = []; sends = []; sendErrors = []; failures = []; hook = null; }

	async consume(bodies: unknown[], attempts = 1) {
		const acks: string[] = [];
		const retries: { id: string; delaySeconds?: number }[] = [];
		const messages = bodies.map((body, i): Message => ({
			id: String(i), body, attempts, timestamp: new Date(NOW),
			ack() { acks.push(String(i)); },
			retry(options) { retries.push({ id: String(i), ...options }); },
		}));
		await queue({
			queue: "test-inbound", messages,
			metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } },
			ackAll() { throw new Error("Must acknowledge individually"); },
			retryAll() { throw new Error("Must retry individually"); },
		}, controlled(this.env));
		return { acks, retries };
	}
}
