import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { toBase64Url } from "#shared";
import { keyPair, rawKey } from "../worker/push";
import { fixture, type Fixture, job, type Mailboxes, MIME } from "./runtime/fixture";

const ecdh = { name: "ECDH", namedCurve: "P-256" };

/** A browser: the subscription it hands the app, and the private half it reads pushes with. */
async function browser(name: string, service = "https://push.example.net") {
	const pair = await keyPair(ecdh, ["deriveBits"]);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	const subscription = { endpoint: `${service}/${name}`, keys: { p256dh: toBase64Url(await rawKey(pair.publicKey)), auth: toBase64Url(auth) } };
	return { pair, auth, subscription };
}
type Browser = Awaited<ReturnType<typeof browser>>;

/** RFC 8291 from the browser's side, written apart from the Worker's encryption. */
async function read(to: Browser, body: Uint8Array): Promise<unknown> {
	const salt = body.slice(0, 16);
	const keyLength = body[20] ?? 0;
	const senderKey = body.slice(21, 21 + keyLength);
	const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: ArrayBuffer, info: string | Uint8Array<ArrayBuffer>, bytes: number) =>
		crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt, info: typeof info === "string" ? new Uint8Array(new TextEncoder().encode(info)) : info },
			await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]),
			bytes * 8,
		);
	const agreement = { name: "ECDH", public: await crypto.subtle.importKey("raw", senderKey, ecdh, false, []) };
	const shared = await crypto.subtle.deriveBits(agreement, to.pair.privateKey, 256);
	const receiverKey = await rawKey(to.pair.publicKey);
	const info = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...receiverKey, ...senderKey]);
	const ikm = await hkdf(to.auth, shared, info, 32);
	const key = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16), "AES-GCM", false, ["decrypt"]);
	const iv = new Uint8Array(await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12));
	const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body.slice(21 + keyLength)));
	expect(record.at(-1)).toBe(2);
	return JSON.parse(new TextDecoder().decode(record.slice(0, -1)));
}

describe("push notifications", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });

	const push = (session: string, method: "GET" | "PUT" | "DELETE", body?: unknown) =>
		f.worker.fetch("https://magnus.test/api/push", {
			method, headers: { Cookie: session, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
	const Registered = z.object({ publicKey: z.string(), endpoint: z.string().nullable() });
	const registered = async (session: string) => Registered.parse(await (await push(session, "GET")).json());
	const rows = async () => (await f.env.DIRECTORY.prepare("SELECT endpoint, session_id FROM push_subscriptions ORDER BY endpoint").all<{ endpoint: string; session_id: string }>()).results;

	/** New inbound mail to a mailbox, with its own Message-ID so it isn't taken for a copy of earlier mail. */
	async function deliver(mailboxId: string, id: string, raw = MIME, subaddress: string | null = null) {
		const input = { ...job(mailboxId, id), subaddress };
		await f.env.MAIL.put(input.rawKey, raw.replace("<receipt@outside.test>", `<${id}@outside.test>`), { customMetadata: { mailboxes: mailboxId } });
		const before = (await f.control.pushes()).length;
		await f.control.parse(input);
		return (await f.control.pushes()).slice(before);
	}

	it("keeps one browser per session, moves a shared browser to whoever turns it on, and forgets it when the session ends", async () => {
		expect((await push("", "GET")).status).toBe(401);
		const alice = await f.login("alice");
		const [a, b] = [await browser("a"), await browser("b")];
		expect(await registered(alice)).toEqual({ publicKey: expect.stringMatching(/^B[\w-]{86}$/), endpoint: null });

		expect((await push(alice, "PUT", { ...a.subscription, endpoint: "http://push.example.net/a" })).status).toBe(400);
		for (const auth of ["AAAA", "AAAAA"]) expect((await push(alice, "PUT", { ...a.subscription, keys: { ...a.subscription.keys, auth } })).status).toBe(400);
		expect((await push(alice, "PUT", a.subscription)).status).toBe(204);
		expect((await registered(alice)).endpoint).toBe(a.subscription.endpoint);
		// The browser's subscription changed: the old one goes.
		expect((await push(alice, "PUT", b.subscription)).status).toBe(204);
		expect((await rows()).map((r) => r.endpoint)).toEqual([b.subscription.endpoint]);

		// Bob signs in on the same browser and turns it on.
		const bob = await f.login("bob");
		expect((await push(bob, "PUT", b.subscription)).status).toBe(204);
		expect((await registered(alice)).endpoint).toBeNull();
		expect((await registered(bob)).endpoint).toBe(b.subscription.endpoint);
		expect((await push(bob, "DELETE")).status).toBe(204);
		expect(await rows()).toEqual([]);

		expect((await push(alice, "PUT", a.subscription)).status).toBe(204);
		const signOut = await f.worker.fetch("https://magnus.test/api/auth/sign-out", { method: "POST", headers: { Cookie: alice, Origin: "https://magnus.test", "Content-Type": "application/json" }, body: "{}" });
		expect(signOut.status).toBe(200);
		expect(await rows()).toEqual([]);
	});

	it("ends the session someone signs in over, so that browser stops getting its mail, but not a renewed one", async () => {
		const a = await browser("a");
		const alice = await f.login("alice");
		await push(alice, "PUT", a.subscription);
		const headers = { Cookie: alice, Origin: "https://magnus.test", "Content-Type": "application/json" };

		// Renewed: Better Auth sets the same session's cookie again once a day of its 30 has passed.
		await f.env.DIRECTORY.prepare("UPDATE auth_sessions SET expiresAt = ?1").bind(new Date(Date.now() + 86_400_000).toISOString()).run();
		const renewed = await f.worker.fetch("https://magnus.test/api/auth/get-session?disableCookieCache=true", { headers });
		expect(renewed.headers.getSetCookie().some((cookie) => cookie.includes("session_token="))).toBe(true);
		expect(await rows()).toHaveLength(1);

		// Bob signs in on the same browser, over Alice's session.
		const signIn = await f.worker.fetch("https://magnus.test/api/auth/sign-in/email-otp", {
			method: "POST", headers, body: JSON.stringify({ email: "bob@login.test", otp: await f.control.code("bob@login.test") }),
		});
		expect(signIn.status).toBe(200);
		expect(await rows()).toEqual([]);
		expect(await deliver(ids.alice, "after-switch")).toEqual([]);
	});

	it("keeps an admin's session, and their browser, while they impersonate someone, so they can stop", async () => {
		const a = await browser("a");
		const admin = await f.login("admin");
		await push(admin, "PUT", a.subscription);
		const post = (path: string, cookie: string) => f.worker.fetch(`https://magnus.test/api/auth${path}`, {
			method: "POST", headers: { Cookie: cookie, Origin: "https://magnus.test", "Content-Type": "application/json" }, body: JSON.stringify({ userId: "alice" }),
		});
		const started = await post("/admin/impersonate-user", admin);
		expect(started.status).toBe(200);
		expect(await rows()).toHaveLength(1);
		const impersonating = started.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "").filter((cookie) => !cookie.endsWith("=")).join("; ");
		expect((await post("/admin/stop-impersonating", impersonating)).status).toBe(200);
		expect(await rows()).toHaveLength(1);
	});

	it("signs one VAPID token for pushes to several devices at once, on a push service it hasn't signed for yet", async () => {
		const service = `https://push-${crypto.randomUUID()}.example.net`;
		const [a, b] = [await browser("a", service), await browser("b", service)];
		await push(await f.login("alice"), "PUT", a.subscription);
		await push(await f.login("bob"), "PUT", b.subscription);
		const sent = await deliver(ids.shared, "cold");
		expect(sent).toHaveLength(2);
		expect(new Set(sent.map((p) => p.headers.authorization)).size).toBe(1);
	});

	it("keeps using a VAPID token after the Worker restarts in a new isolate", async () => {
		const a = await browser("a");
		await push(await f.login("alice"), "PUT", a.subscription);
		const [before] = await deliver(ids.alice, "before-restart");
		await f.restart();
		const [after] = await deliver(ids.alice, "after-restart");
		expect(after?.headers.authorization).toBe(before?.headers.authorization);
	});

	it("forgets browsers whose session expired unused", async () => {
		const [a, b] = [await browser("a"), await browser("b")];
		await push(await f.login("alice"), "PUT", a.subscription);
		await push(await f.login("bob"), "PUT", b.subscription);
		await f.env.DIRECTORY.prepare("UPDATE auth_sessions SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE userId = 'alice'").run();
		await f.control.forgetExpiredDevices();
		expect((await rows()).map((r) => r.endpoint)).toEqual([b.subscription.endpoint]);
	});

	it("notifies each member's browser about new inbox mail, encrypted to it, once", async () => {
		const [a, b] = [await browser("a"), await browser("b")];
		await push(await f.login("alice"), "PUT", a.subscription);
		await push(await f.login("bob"), "PUT", b.subscription);
		const { publicKey } = await registered(await f.login("alice"));

		const sent = await deliver(ids.alice, "mail-1");
		expect(sent.map((p) => p.url)).toEqual([a.subscription.endpoint]);
		expect(sent[0]?.headers).toMatchObject({ ttl: "86400", urgency: "high", "content-encoding": "aes128gcm", authorization: expect.stringMatching(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${publicKey}$`)) });
		const [thread] = await f.env.MAILBOX.getByName(ids.alice).listThreads({ label: "inbox", limit: 1 });
		expect(await read(a, sent[0]!.body)).toEqual({ title: "Sender", body: "Receipt\nYour receipt", tag: "mail-1", url: `/inbox/${ids.alice}/${thread?.id}` });

		// A retried job finds the mail delivered.
		await f.control.parse(job(ids.alice, "mail-1"));
		expect(await f.control.pushes()).toHaveLength(1);

		// A shared mailbox tells everyone in it.
		const shared = await deliver(ids.shared, "mail-2");
		expect(shared.map((p) => p.url).sort()).toEqual([a.subscription.endpoint, b.subscription.endpoint]);
		// One VAPID token for the push service, not one per push: Apple refuses tokens refreshed more than hourly.
		expect(new Set([...sent, ...shared].map((p) => p.headers.authorization)).size).toBe(1);
		expect(await read(b, shared.find((p) => p.url === b.subscription.endpoint)!.body)).toMatchObject({ tag: "mail-2" });
	});

	it("skips spam, suspended people, sessions that ended or are impersonated, and former members, and drops browsers the push service has", async () => {
		const a = await browser("a");
		const alice = await f.login("alice");
		await push(alice, "PUT", a.subscription);
		const session = (await rows())[0]?.session_id;
		expect(session).toBeDefined();
		const db = f.env.DIRECTORY;

		expect(await deliver(ids.alice, "spam", MIME.replace("dmarc=pass", "dmarc=fail"))).toEqual([]);
		// Even to alice+inbox@, whose tag adds the inbox label.
		expect(await deliver(ids.alice, "spam-tagged", MIME.replace("dmarc=pass", "dmarc=fail"), "inbox")).toEqual([]);
		await db.prepare("UPDATE auth_users SET banned = 1 WHERE id = 'alice'").run();
		expect(await deliver(ids.alice, "suspended")).toEqual([]);
		await db.prepare("UPDATE auth_users SET banned = 0 WHERE id = 'alice'").run();
		await db.prepare("UPDATE auth_sessions SET expiresAt = '2000-01-01T00:00:00.000Z' WHERE id = ?1").bind(session).run();
		expect(await deliver(ids.alice, "expired")).toEqual([]);
		await db.prepare("UPDATE auth_sessions SET expiresAt = '2999-01-01T00:00:00.000Z', impersonatedBy = 'admin' WHERE id = ?1").bind(session).run();
		expect(await deliver(ids.alice, "impersonated")).toEqual([]);
		expect((await push(alice, "PUT", a.subscription)).status).toBe(401);
		await db.prepare("UPDATE auth_sessions SET impersonatedBy = NULL WHERE id = ?1").bind(session).run();
		await db.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ?1 AND user_id = 'alice'").bind(ids.shared).run();
		expect(await deliver(ids.shared, "former")).toEqual([]);

		// A refusal is logged from the start of its answer, even one that never ends, and the browser is kept.
		await f.control.setPushStatus(500, true);
		expect(await deliver(ids.alice, "refused")).toHaveLength(1);
		expect(await rows()).toHaveLength(1);

		await f.control.setPushStatus(410);
		expect(await deliver(ids.alice, "gone")).toHaveLength(1);
		expect(await rows()).toEqual([]);
		expect(await f.env.MAILBOX.getByName(ids.alice).holding(["gone"])).toEqual(["gone"]);
	});
});
