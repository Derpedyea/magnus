// A request's I/O is cancelled when its client hangs up, and its replies never come. What an isolate keeps for later
// requests must never wait on those: most cases leave a first call waiting on a reply that never comes, then check the
// next call finishes on its own. The rest cover what's kept otherwise: failures aren't, and nothing waits on a check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64Url } from "#shared";

const env = vi.hoisted(() => ({}));
vi.mock("cloudflare:workers", () => ({ env, waitUntil: () => {} }));

/** A reply that never comes. */
const never = () => new Promise(() => {});

/** D1, answering each query with `reply(sql)`: its rows, or a promise of them. */
function d1(reply) {
	const result = async (sql) => ({ results: await reply(sql), success: true, meta: { changes: 0, last_row_id: 0 } });
	const statement = (sql) => ({
		bind: () => statement(sql),
		all: () => result(sql),
		run: () => result(sql),
		raw: async () => (await reply(sql)).map((row) => Object.values(row)),
		first: async () => (await reply(sql))[0] ?? null,
	});
	// `exec` too: it's how Better Auth tells a D1 binding apart.
	return { prepare: statement, batch: (statements) => Promise.all(statements.map((s) => s.all())), exec: never };
}

beforeEach(() => {
	// Every case starts on a fresh isolate, with nothing kept from the last.
	vi.resetModules();
	for (const key of Object.keys(env)) delete env[key];
});
afterEach(() => vi.unstubAllGlobals());

describe("migrate", () => {
	it("runs again for a request that comes after one whose replies never came", async () => {
		const { migrate } = await import("./migrate");
		void migrate(d1(never));
		await migrate(d1(() => []));
		// Kept once it finished: no query again.
		await migrate(d1(never));
	});

	it("tries again after a failure", async () => {
		const { migrate } = await import("./migrate");
		await expect(migrate(d1(() => { throw new Error("D1 unavailable"); }))).rejects.toThrow("D1 unavailable");
		await migrate(d1(() => []));
	});
});

describe("auth", () => {
	const request = () => new Request("https://mail.example.com/api/auth/sign-in/email-otp");
	/** Answers the session secret with `secret`, and everything else with `rest`. */
	const directory = (secret, rest = never) => d1((sql) => (sql.includes("auth_secret") ? secret() : rest()));

	it("reads the secret itself when another request's read never got its reply", async () => {
		const { auth } = await import("./auth");
		env.DIRECTORY = directory(never);
		void auth(request());
		env.DIRECTORY = directory(() => [{ value: "secret" }]);
		await auth(request());
	});

	it("answers without waiting on a check of the database", async () => {
		const { auth } = await import("./auth");
		env.DIRECTORY = directory(() => [{ value: "secret" }]);
		const instance = await auth(request());
		expect(await instance.api.getSession({ headers: new Headers() })).toBeNull();
	});

	it("queries for a request after one whose query never got its reply", async () => {
		const { auth } = await import("./auth");
		let asked = () => {};
		const firstAsked = new Promise((resolve) => { asked = resolve; });
		let queries = 0;
		env.DIRECTORY = directory(() => [{ value: "secret" }], () => {
			if (++queries > 1) return [];
			asked();
			return never();
		});
		const body = { email: "alice@example.com", otp: "000000" };
		void (await auth(request())).api.signInEmailOTP({ body });
		await firstAsked;
		// No code is on file, so it's refused: what matters is that it got an answer.
		await expect((await auth(request())).api.signInEmailOTP({ body })).rejects.toMatchObject({ statusCode: 400 });
	});
});

describe("notifyNewMail", () => {
	it("signs its pushes when another push's token never came", async () => {
		const { keyPair, notifyNewMail, rawKey } = await import("./push");
		const browser = await keyPair({ name: "ECDH", namedCurve: "P-256" }, ["deriveBits"]);
		const device = { endpoint: "https://push.example.net/abc", origin: "https://mail.example.com", p256dh: toBase64Url(await rawKey(browser.publicKey)), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))) };
		const signing = await keyPair({ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"]);
		const vapid = JSON.stringify({ publicKey: toBase64Url(await rawKey(signing.publicKey)), privateKey: await crypto.subtle.exportKey("jwk", signing.privateKey) });
		/** The device and the install's keys; the stored push token answers with `token`. */
		const directory = (token) => d1((sql) => (sql.includes("push_subscriptions") ? [device] : sql.includes("'vapid'") ? [{ value: vapid }] : token()));
		const fetch = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		const message = { id: "m1", from: { address: "sender@outside.test" }, subject: "Hello", text: "Hello world" };

		let asked = () => {};
		const tokenAsked = new Promise((resolve) => { asked = resolve; });
		void notifyNewMail({ DIRECTORY: directory(() => { asked(); return never(); }) }, "mbx", "thread", message);
		await tokenAsked;
		const stored = { header: "vapid t=stored, k=key", until: Date.now() + 3_600_000 };
		await notifyNewMail({ DIRECTORY: directory(() => [{ value: JSON.stringify(stored) }]) }, "mbx", "thread", message);
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]?.[1]?.headers.Authorization).toBe(stored.header);
	});
});
