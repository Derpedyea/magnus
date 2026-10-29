import { WorkerEntrypoint } from "cloudflare:workers";
import { type AddressFilter, type InboundJob, type MailCategory, type MailCheck, type SendInput, ulid } from "#shared";
import { z } from "zod";
import { app } from "../../worker/api";
import { links } from "../../worker/links";
import { restoreMailbox } from "../../worker/restore";
import { auth, signInWithoutCode } from "../../worker/auth";
import { email, queue } from "../../worker/mail/inbound";
import { DEEP_MODEL, type Models, QUICK_MODEL } from "../../worker/mail/checks";
import { ingest } from "../../worker/mail/ingest";
import { RULES_MODEL } from "../../worker/mail/rules";
import { Mailbox as ProductionMailbox } from "../../worker/mailbox/mailbox";
import { type Exporter, ProtonImport as ProductionProtonImport } from "../../worker/proton-import";
import type { ExporterState, ProtonImportJob } from "#shared/proton-export";
import { cleanDraftFiles } from "../../worker/drafts";
import { setDomainFlag } from "../../worker/directory";
import { cleanHeld } from "../../worker/held";
import { forgetExpiredDevices } from "../../worker/push";
import { deleteMailboxObjects, deletePerson } from "../../worker/removals";
import { NOW } from "./clock";

export { Vault } from "../../worker/vault";

type Operation = "get" | "put" | "delete" | "directory" | "queue";
/** After the I/O: Undo that send, hide the mailbox as removing its person does, or by default delete the mailbox. */
type Hook = { operation: "get" | "put"; prefix: string; mailboxId: string; cancelMessageId?: string; hide?: true };
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

/** One answer of the mail agent's model: what it says, and the tools it calls. */
export type AgentStep = { content?: string; calls?: { name: string; args: unknown }[] };
/**
 * What the stand-in models answer: Clef's probability of spam, Luna's category, whether every rule's AI condition
 * matches, and the mail agent's answers in turn (then "Done."). "fail" throws; "garbage" is off-schema.
 */
type ModelAnswers = { quick: number | Record<MailCategory, number> | "fail" | "garbage"; deep: MailCategory | "fail" | "echo"; rules: boolean | "fail" | "garbage"; agent: AgentStep[] };
const ANSWERS: ModelAnswers = { quick: 0, deep: "personal", rules: true, agent: [] };
let answers = ANSWERS;
/** Each model call, its inputs as JSON. */
let modelCalls: { model: string; inputs: string }[] = [];

// Answer in each provider's shape, so the parsing is what production runs.
const models: Models = {
	async run(model, inputs) {
		modelCalls.push({ model, inputs: JSON.stringify(inputs) });
		if (model === QUICK_MODEL) {
			if (answers.quick === "fail") throw new Error("Injected model failure");
			if (answers.quick === "garbage") return { answers: { category: { type: "choice", choice: "spam" } } };
			const probabilities = typeof answers.quick === "number"
				? { personal: 1 - answers.quick, transactional: 0, newsletter: 0, outreach: 0, spam: answers.quick, phishing: 0 }
				: answers.quick;
			return { model: "clef", answers: { category: { type: "choice", choice: "personal", probabilities, confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 0 } };
		}
		if (model === RULES_MODEL && "tools" in inputs) {
			const [step = { content: "Done." }, ...rest] = answers.agent;
			answers = { ...answers, agent: rest };
			const calls = step.calls?.map((c, i) => ({ id: `call-${modelCalls.length}-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
			return { choices: [{ message: { role: "assistant", content: step.content ?? "", ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }] };
		}
		if (model === RULES_MODEL) {
			if (answers.rules === "fail") throw new Error("Injected model failure");
			if (answers.rules === "garbage") return { choices: [{ message: { role: "assistant", content: "Yes to all of them" } }] };
			const { conditions } = z.object({ conditions: z.array(z.unknown()) }).parse(JSON.parse(z.object({ messages: z.array(z.object({ content: z.string() })) }).parse(inputs).messages[1]!.content));
			const content = JSON.stringify({ answers: conditions.map((_, i) => ({ rule: i + 1, match: answers.rules, reason: `Answer ${i + 1}` })) });
			return { choices: [{ message: { role: "assistant", content } }] };
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

// Have I Been Pwned's password range API, which knows just this one (sign-in.test.ts). Nothing reaches the real one.
const BREACHED_PASSWORD = "password password password";
const realFetch = globalThis.fetch;
Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
	if (new URL(new Request(input, init).url).hostname !== "api.pwnedpasswords.com") return realFetch(input, init);
	const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(BREACHED_PASSWORD)));
	return new Response(`${Array.from(sha1, (b) => b.toString(16).padStart(2, "0")).join("").slice(5).toUpperCase()}:3\r\n`);
});

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
	else if (action.hide) await env.DIRECTORY.prepare("UPDATE mailboxes SET removed_with = 'removed' WHERE id = ?1").bind(action.mailboxId).run();
	else await env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(action.mailboxId).run();
}

const JobSchema = z.object({
	v: z.literal(1), ingestId: z.string(), rawKey: z.string(), rawSize: z.number(), mailboxId: z.string(),
	envelopeFrom: z.string(), envelopeTo: z.string(), subaddress: z.string().nullable(), receivedAt: z.number(),
	checkFailures: z.number().optional(),
	ruleFailures: z.number().optional(),
	check: z.custom<MailCheck | null>().optional(),
	imported: z.object({ labels: z.array(z.string()), paths: z.array(z.string()).optional(), read: z.boolean(), sent: z.boolean(), addresses: z.array(z.string()) }).optional(),
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
	// The fixture has no AI binding: the API's mail agent (worker/agent.ts) gets the stand-in.
	return { ...env, MAIL, DIRECTORY, INBOUND, EMAIL, AI: models as unknown as Ai };
}

/**
 * Restores armed per mailbox, taken up when its object next starts, as Cloudflare's are. Local development has no
 * point-in-time recovery, so a restore here goes back only to just before it was prepared: all that changes is what
 * prepareRestore() and armRestore() wrote, the mark that tells the states apart and the hold on sends. Whether
 * restart() reaches the object is up to the test; one that doesn't leaves the restore armed for the next start.
 */
const armed = new Map<string, string>();
let restartsReach = true;
const restored: string[] = [];
/** A mailbox whose next holding() answer comes as a restore of it has just named itself and rewound it. */
let restoreAsAnswering: string | null = null;
/** The next restore armed fails to say so, as if the object shut down just after arming it. */
let armThenFail = false;
/** A mailbox whose restore loses its hold on it once finishRestore() is done, to another restore. */
let loseHold: string | null = null;

export class Mailbox extends ProductionMailbox {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, controlled(env));
		const bookmark = ctx.id.name === undefined ? undefined : armed.get(ctx.id.name);
		if (ctx.id.name === undefined || bookmark === undefined) return;
		armed.delete(ctx.id.name);
		ctx.storage.sql.exec(`DELETE FROM _meta WHERE key LIKE 'restore_pending:%' OR key = 'restore_fence'`);
		restored.push(bookmark);
	}

	protected override pointInTime() {
		const name = this.ctx.id.name ?? "";
		// Shaped like Cloudflare's, and like them, later ones sort after earlier ones.
		const bookmark = (ms: number) => {
			const hex = ms.toString(16).padStart(16, "0");
			return `${hex.slice(0, 8)}-${hex.slice(8)}-00000000-0`;
		};
		return {
			getBookmarkForTime: async (at: number | Date) => bookmark(Number(at)),
			getCurrentBookmark: async () => bookmark(Date.now()),
			onNextSessionRestoreBookmark: async (target: string) => {
				armed.set(name, target);
				// Armed, then the object shuts down before answering, as Cloudflare says it can at any time.
				if (armThenFail) {
					armThenFail = false;
					throw new Error("Durable Object reset because its code was updated");
				}
				return bookmark(Date.now());
			},
		};
	}

	override async restart() { if (restartsReach) await super.restart(); }
	override async finishRestore(restoreId: string, until: number) {
		const applied = await super.finishRestore(restoreId, until);
		if (loseHold === this.ctx.id.name) {
			loseHold = null;
			await this.env.DIRECTORY.prepare("UPDATE mailboxes SET restoring = 'other' WHERE id = ?1").bind(this.ctx.id.name).run();
		}
		return applied;
	}
	/** Restarts the object, as Cloudflare can at any time. Its caller's call fails. */
	abortNow() { this.ctx.abort("Restarted by the test"); }

	override async holding(messageIds: string[]) {
		if (restoreAsAnswering === this.ctx.id.name) {
			restoreAsAnswering = null;
			await this.env.DIRECTORY.prepare("UPDATE mailboxes SET restore_id = ?2 WHERE id = ?1").bind(this.ctx.id.name, ulid()).run();
		}
		return super.holding(messageIds);
	}

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

/**
 * The Proton export tool's container, as its wrapper answers (container/proton-export/server.ts): tests set what it
 * says and holds, and read back what it was asked.
 */
type FakeExport = {
	running: boolean;
	/** The container never comes up. */
	startFails: boolean;
	state: ExporterState;
	/** labels.json, once the tool has written it. */
	labels: string | null;
	/** Exported messages by Proton id: the .eml and its .metadata.json. `size` overrides the length the wrapper reports. */
	messages: Map<string, { eml: string; metadata: string; size?: number }>;
	/** Deletes that fail before one succeeds, as a crash between filing and deleting would leave it. */
	deleteFailures: number;
	/** Message details whose body fails partway, as a dropped connection would. */
	bodyFailures: number;
	/** Requests for paths ending in these wait until releaseExport(), so a test can act while one is on its way. */
	hold: string[];
	/** Paths that never answer, unless the request is given up on. */
	hang: string[];
	/** No container can be had at all, as in local dev without PROTON_EXPORTER_URL. */
	unavailable: boolean;
	requests: { method: string; path: string; body: string }[];
	destroyed: number;
};

function freshExport(): FakeExport {
	return {
		running: false, startFails: false, labels: null, messages: new Map(), deleteFailures: 0, bodyFailures: 0, hold: [], hang: [], unavailable: false, requests: [], destroyed: 0,
		state: { phase: "idle", prompt: 0, error: null, verifyUrl: null, percent: 0, ready: 0, unexported: 0 },
	};
}
let exported = freshExport();

function sized(body: string, type: string, size = new TextEncoder().encode(body).byteLength): Response {
	return new Response(body, { headers: { "Content-Type": type, "Content-Length": String(size) } });
}

const fakeExporter: Exporter = {
	get running() { return exported.running; },
	async start() {
		if (exported.startFails) throw new Error("Injected container start failure");
		exported.running = true;
	},
	async destroy() { exported.running = false; exported.destroyed++; },
	async fetch(path, init) {
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? init.body : "";
		exported.requests.push({ method, path, body });
		if (exported.hang.some((p) => path.startsWith(p))) {
			return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
		}
		const state = () => Response.json({ ...exported.state, ready: exported.messages.size });
		const message = /^\/messages\/([^/]+)(?:\/(eml|metadata))?$/.exec(path);
		if (path === "/state") return state();
		if (path === "/start") {
			exported.state = { ...exported.state, phase: "signing-in" };
			return state();
		}
		if (path === "/answer") {
			const answer = z.object({ prompt: z.number(), value: z.string() }).parse(JSON.parse(body));
			const asking = ["needs-code", "needs-mailbox-password", "needs-verification"].includes(exported.state.phase);
			if (!asking || answer.prompt !== exported.state.prompt) return Response.json({ error: "Stale" }, { status: 409 });
			exported.state = { ...exported.state, phase: "signing-in", error: null, verifyUrl: null };
			return state();
		}
		if (path === "/stop") {
			if (exported.state.phase !== "idle") exported.state = { ...exported.state, phase: "stopped" };
			return state();
		}
		if (path === "/labels") return exported.labels === null ? Response.json({ error: "Not found" }, { status: 404 }) : sized(exported.labels, "application/json");
		if (path.startsWith("/messages?")) return Response.json({ ids: [...exported.messages.keys()].slice(0, Number(new URL(path, "http://c").searchParams.get("limit"))) });
		if (message?.[1]) {
			const id = decodeURIComponent(message[1]);
			const found = exported.messages.get(id);
			if (!found) return Response.json({ error: "Not found" }, { status: 404 });
			if (method === "DELETE") {
				if (exported.deleteFailures > 0) {
					exported.deleteFailures--;
					return Response.json({ error: "Injected delete failure" }, { status: 500 });
				}
				exported.messages.delete(id);
				return new Response(null, { status: 204 });
			}
			// Polled rather than a promise: workerd never resumes a promise settled from another request's context.
			while (exported.hold.some((suffix) => path.endsWith(suffix))) await scheduler.wait(5);
			if (message[2] === "metadata" && exported.bodyFailures > 0) {
				exported.bodyFailures--;
				const broken = new ReadableStream({ start: (controller) => controller.error(new Error("Injected body failure")) });
				return new Response(broken, { headers: { "Content-Type": "application/json", "Content-Length": String(found.metadata.length) } });
			}
			return message[2] === "eml" ? sized(found.eml, "message/rfc822", found.size) : sized(found.metadata, "application/json");
		}
		return Response.json({ error: "Not found" }, { status: 404 });
	},
};

export class ProtonImport extends ProductionProtonImport {
	// A wrapper that hangs is given up on in a blink rather than seconds.
	protected override readonly limits = { control: 50, file: 50 };
	constructor(ctx: DurableObjectState, env: Env) { super(ctx, controlled(env)); }
	protected override exporter(): Exporter | null { return exported.unavailable ? null : fakeExporter; }

	override start(input: Parameters<ProductionProtonImport["start"]>[0]) { return atTestTime(() => super.start(input)); }
	override answer(userId: string, jobId: string, answer: Parameters<ProductionProtonImport["answer"]>[2]) { return atTestTime(() => super.answer(userId, jobId, answer)); }
	override cancel(userId: string, jobId: string) { return atTestTime(() => super.cancel(userId, jobId)); }

	async drain() {
		await this.ctx.storage.deleteAlarm();
		await atTestTime(() => super.alarm());
	}

	alarmAt() { return this.ctx.storage.getAlarm(); }
}

export type TestEnv = Omit<Env, "MAILBOX" | "PROTON_IMPORT"> & { MAILBOX: DurableObjectNamespace<Mailbox>; PROTON_IMPORT: DurableObjectNamespace<ProtonImport> };
export type { ProtonImportJob };

export default class TestWorker extends WorkerEntrypoint<TestEnv> {
	// Routed as worker/index.ts routes them.
	override async fetch(request: Request) { return (new URL(request.url).pathname.startsWith("/f/") ? links : app).fetch(request, controlled(this.env), this.ctx); }
	override async email(message: ForwardableEmailMessage) { await atTestTime(() => email(message, controlled(this.env))); }
	login(address: string) { return signInWithoutCode(new Request("https://magnus.test/api/auth/sign-in/email-otp"), address); }
	/** A sign-in code, as if emailed, for signing in through the API. */
	async code(address: string) {
		const a = await auth(new Request("https://magnus.test/api/auth/sign-in/email-otp"));
		return a.api.createVerificationOTP({ body: { email: address, type: "sign-in" } });
	}
	forgetExpiredDevices() { return forgetExpiredDevices(this.env.DIRECTORY, Date.now()); }
	/** Deletes someone for good, leaving their mail to deleteMailboxObjects(), as the hourly cron would. */
	deletePerson(userId: string, archiveId: string, admin: { userId: string; sessionId: string }) { return deletePerson(controlled(this.env).DIRECTORY, userId, archiveId, admin); }
	deleteMailboxObjects() { return atTestTime(() => deleteMailboxObjects(controlled(this.env))); }
	parse(job: InboundJob) { return withPushService(() => ingest(controlled(this.env), job, models)); }
	setModels(next: Partial<ModelAnswers>) { answers = { ...answers, ...next }; }
	cleanDrafts() { return cleanDraftFiles(controlled(this.env), now); }
	/** As connect.ts turns a domain's receiving on or off, at test time. */
	setReceiving(domain: string, on: boolean) { return atTestTime(() => setDomainFlag(this.env.DIRECTORY, domain, "receiving", on)); }
	/** The hourly cron's held-mail pass. */
	cleanHeld() { return cleanHeld(controlled(this.env), now); }
	setNow(value: number) { now = value; }
	/** Changes what the Proton export container says and holds. */
	setExport(change: {
		running?: boolean; startFails?: boolean; state?: Partial<ExporterState>; labels?: string | null; deleteFailures?: number; bodyFailures?: number;
		hold?: string[]; hang?: string[]; unavailable?: boolean;
	}) {
		const { state, ...rest } = change;
		exported = { ...exported, ...rest, state: { ...exported.state, ...state } };
	}
	releaseExport() { exported.hold = []; }
	exportMessage(id: string, eml: string, metadata: string, size?: number) { exported.messages.set(id, { eml, metadata, ...(size === undefined ? {} : { size }) }); }
	exportState() { return { ...exported, messages: [...exported.messages.keys()] }; }
	setSendErrors(codes: string[]) { sendErrors = codes; }
	setPushStatus(status: number, endless = false) { pushStatus = status; pushEndless = endless; }
	pushes() { return pushes; }
	failNext(operation: Operation, prefix = "", count = 1) { failures.push({ operation, prefix, remaining: count }); }
	stallDeletes(prefix: string) { stalls.push(prefix); }
	afterIO(action: Hook) { hook = action; }
	/** A restore as the admin route makes it, by `admin`, checked when it claims the mailbox. */
	restoreMailbox(mailboxId: string, at: number, admin: { userId: string; sessionId: string }) { return restoreMailbox(controlled(this.env), mailboxId, { at, bookmark: null }, admin); }
	/** Makes restart() not reach the object, so restores stay armed till it next starts. */
	setRestartsReach(reach: boolean) { restartsReach = reach; }
	/** Names a restore of this mailbox, and rewinds it, just before it next answers holding(). */
	restoreAsItAnswers(mailboxId: string) { restoreAsAnswering = mailboxId; }
	/** Makes the next arming of a restore take, then fail to answer. */
	armThenFail() { armThenFail = true; }
	/** Hands this mailbox's hold to another restore once the current one has finished rewinding it. */
	loseHoldAfterFinish(mailboxId: string) { loseHold = mailboxId; }
	/** The bookmarks restored, in order. */
	restored() { return restored; }
	state() {
		return { jobs, modelCalls, sends: sends.map((message) => ({
			from: message.from, to: message.to, cc: message.cc, bcc: message.bcc, subject: message.subject, text: message.text, html: message.html,
			attachments: message.attachments?.map((a) => ({
				filename: a.filename, type: a.type, disposition: a.disposition, contentId: a.contentId,
				content: typeof a.content === "string" ? a.content : new TextDecoder().decode(a.content),
			})),
		})) };
	}
	reset() { armed.clear(); armThenFail = false; restartsReach = true; restoreAsAnswering = null; loseHold = null; restored.length = 0; exported = freshExport(); now = NOW; jobs = []; sends = []; sendErrors = []; failures = []; stalls = []; hook = null; pushes = []; pushStatus = 201; pushEndless = false; answers = ANSWERS; modelCalls = []; }

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
