import { WorkerEntrypoint } from "cloudflare:workers";
import { type AddressFilter, type InboundJob, type MailCategory, type SendInput } from "#shared";
import { z } from "zod";
import { app } from "../../worker/api";
import { auth, signInWithoutCode } from "../../worker/auth";
import { email, queue } from "../../worker/mail/inbound";
import { DEEP_MODEL, type Models, QUICK_MODEL } from "../../worker/mail/checks";
import { ingest } from "../../worker/mail/ingest";
import { Mailbox as ProductionMailbox } from "../../worker/mailbox/mailbox";
import { cleanDraftFiles } from "../../worker/drafts";
import { forgetExpiredDevices } from "../../worker/push";
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
// R2 deletes under these prefixes never finish, so a test can restart the Worker mid-delete as a crash would.
let stalls: string[] = [];
let hook: Hook | null = null;
let pushes: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
let pushStatus = 201;
// A push service answering with a body that never ends, as any endpoint someone registers could.
let pushEndless = false;

/** What the stand-in models answer: Clef's probability of spam, and Luna's category. "fail" throws; "garbage" is off-schema. */
type ModelAnswers = { quick: number | "fail" | "garbage"; deep: MailCategory | "fail" | "echo" };
let answers: ModelAnswers = { quick: 0, deep: "personal" };
/** Each model call, its inputs as JSON. */
let modelCalls: { model: string; inputs: string }[] = [];

// Answer in each provider's shape, so the parsing is what production runs.
const models: Models = {
	async run(model, inputs) {
		modelCalls.push({ model, inputs: JSON.stringify(inputs) });
		if (model === QUICK_MODEL) {
			if (answers.quick === "fail") throw new Error("Injected model failure");
			if (answers.quick === "garbage") return { answers: { category: { type: "choice", choice: "spam" } } };
			const probabilities = { personal: 1 - answers.quick, transactional: 0, newsletter: 0, spam: answers.quick, phishing: 0 };
			return { model: "clef", answers: { category: { type: "choice", choice: "personal", probabilities, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } };
		}
		throw new Error(`Unexpected model ${model}`);
	},
	gateway: (id) => ({
		async run(request) {
			modelCalls.push({ model: DEEP_MODEL, inputs: JSON.stringify({ id, request }) });
			if (answers.deep === "fail") return new Response("Injected model failure", { status: 502 });
			// A model answering off-schema by repeating the mail back.
			if (answers.deep === "echo") return Response.json({ choices: [{ message: { role: "assistant", content: `Sure: ${JSON.stringify(request.query)}` } }] });
			return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({ category: answers.deep }) } }] });
		},
	}),
};

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

// Every push service, as far as ingest can tell: requests are recorded and answered with pushStatus. Restored on every
// exit.
async function withPushService<T>(run: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;
	Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		pushes.push({ url: request.url, headers: Object.fromEntries(request.headers), body: new Uint8Array(await request.arrayBuffer()) });
		const endless = new ReadableStream({ start: (controller) => controller.enqueue(new TextEncoder().encode("x".repeat(1000))) });
		return new Response(pushEndless ? endless : null, { status: pushStatus });
	});
	try {
		return await run();
	} finally {
		Reflect.set(globalThis, "fetch", original);
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
	checkFailures: z.number().optional(),
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
				if (stalls.some((prefix) => [keys].flat().some((key) => key.startsWith(prefix)))) return new Promise<void>(() => {});
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
	override recordFailed(job: InboundJob, error: string | null) { return atTestTime(() => super.recordFailed(job, error)); }
	override retryFailed(id: string) { return atTestTime(() => super.retryFailed(id)); }
	override listFailed(query: AddressFilter) { return atTestTime(() => super.listFailed(query)); }

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
	/** A sign-in code, as if emailed, for signing in through the API. */
	async code(address: string) {
		const a = await auth(new Request("https://magnus.test/api/auth/sign-in/email-otp"));
		return a.api.createVerificationOTP({ body: { email: address, type: "sign-in" } });
	}
	forgetExpiredDevices() { return forgetExpiredDevices(this.env.DIRECTORY, Date.now()); }
	parse(job: InboundJob) { return withPushService(() => ingest(controlled(this.env), job, models)); }
	setModels(next: Partial<ModelAnswers>) { answers = { ...answers, ...next }; }
	cleanDrafts() { return cleanDraftFiles(controlled(this.env), now); }
	setNow(value: number) { now = value; }
	setSendErrors(codes: string[]) { sendErrors = codes; }
	setPushStatus(status: number, endless = false) { pushStatus = status; pushEndless = endless; }
	pushes() { return pushes; }
	failNext(operation: Operation, prefix = "", count = 1) { failures.push({ operation, prefix, remaining: count }); }
	stallDeletes(prefix: string) { stalls.push(prefix); }
	afterIO(action: Hook) { hook = action; }
	state() {
		return { jobs, modelCalls, sends: sends.map((message) => ({
			from: message.from, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.text, html: message.html,
			attachments: message.attachments?.map((a) => ({
				filename: a.filename, type: a.type, disposition: a.disposition, contentId: a.contentId,
				content: typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content),
			})),
		})) };
	}
	reset() { now = NOW; jobs = []; sends = []; sendErrors = []; failures = []; stalls = []; hook = null; pushes = []; pushStatus = 201; pushEndless = false; answers = { quick: 0, deep: "personal" }; modelCalls = []; }

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
		}, controlled(this.env), models);
		return { acks, retries };
	}
}
