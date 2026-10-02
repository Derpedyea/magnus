import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, inbound, type Mailboxes } from "./runtime/fixture";
import { z } from "zod";
import { r2Keys } from "#shared";

describe("API permissions", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	let threadId: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
		const message = inbound(ids.bob);
		const key = r2Keys.attachment(ids.bob, message.id, "file");
		await f.env.MAIL.put(message.htmlKey!, "<p>Secret content</p>");
		await f.env.MAIL.put(message.rawKey, "From: sender@outside.test\r\n\r\nSecret content");
		await f.env.MAIL.put(key, "%PDF");
		({ threadId } = await f.env.MAILBOX.getByName(ids.bob).ingest({ ...message, attachments: [{
			id: "file", filename: "receipt.pdf", contentType: "application/pdf", size: 4, contentId: null, inline: false,
			r2Key: key, link: { token: "private-file", shared: true },
		}] }));
	});

	function request(path: string, method = "GET", body?: unknown, session = cookie) {
		return f.worker.fetch(`https://magnus.test/api${path}`, {
			method, headers: { Cookie: session, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	const compose = (from = "alice@example.com") => ({ from, to: [{ address: "friend@outside.test" }], subject: "Hi", text: "Hi" });

	it.each(["/me", "/threads", "/counts", "/contacts", "/mailboxes/guessed/threads/guessed"])("requires a session for %s", async (path) => {
		expect((await request(path, "GET", undefined, "")).status).toBe(401);
	});

	it.each([
		["GET", "/threads/THREAD", undefined],
		["GET", "/messages/inbound-1/body", undefined],
		["GET", "/messages/inbound-1/raw", undefined],
		["GET", "/messages/inbound-1/attachments/file/receipt.pdf", undefined],
		["PATCH", "/messages/inbound-1/attachments/file", { shared: false }],
		["POST", "/threads/modify", { threadIds: ["guessed"], add: ["trash"] }],
		["POST", "/threads/read", { threadIds: ["guessed"], read: true }],
		["POST", "/uploads", undefined],
		["POST", "/send", compose()],
		["POST", "/outbox/guessed/cancel", undefined],
		["POST", "/messages/guessed/retry", undefined],
		["GET", "/live", undefined],
	])("hides another user's mailbox on %s %s", async (method, path, body) => {
		const target = `/mailboxes/${ids.bob}${path.replace("THREAD", threadId)}`;
		if (method === "GET" && path.startsWith("/messages/")) {
			const allowed = await request(target, "GET", undefined, await f.login("bob"));
			expect(allowed.status).toBe(200);
			await allowed.text();
		}
		const response = await request(target, method, body);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Not found" });
	});

	it("lets the owner and shared mailbox members read, and checks membership again after revocation", async () => {
		const shared = await f.env.MAILBOX.getByName(ids.shared).ingest(inbound(ids.shared, "shared-message"));
		const bob = await f.login("bob");
		expect((await request(`/mailboxes/${ids.bob}/threads/${threadId}`, "GET", undefined, bob)).status).toBe(200);
		for (const session of [cookie, bob]) {
			const response = await request(`/mailboxes/${ids.shared}/threads/${shared.threadId}`, "GET", undefined, session);
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		await f.env.DIRECTORY.prepare("DELETE FROM mailbox_members WHERE user_id = 'alice' AND mailbox_id = ?1").bind(ids.shared).run();
		expect((await request(`/mailboxes/${ids.shared}/threads/${shared.threadId}`)).status).toBe(404);
	});

	it("doesn't give admins access to mailboxes they haven't joined", async () => {
		expect((await request(`/mailboxes/${ids.bob}/threads/${threadId}`, "GET", undefined, await f.login("admin"))).status).toBe(404);
	});

	it("scopes every aggregate view to memberships, including a forged address filter", async () => {
		const own = await f.env.MAILBOX.getByName(ids.alice).ingest(inbound(ids.alice, "own-message"));
		const threads = await request("/threads");
		expect(await threads.json()).toMatchObject({ threads: [{ id: own.threadId, mailboxId: ids.alice }], next: null });
		expect(await (await request("/search?q=Secret")).json()).toMatchObject({ threads: [{ id: own.threadId, mailboxId: ids.alice }] });
		expect(await (await request("/threads?in=bob@example.com")).json()).toEqual({ threads: [], next: null });
		expect(await (await request("/search?q=Secret&in=bob@example.com")).json()).toEqual({ threads: [], next: null });
		expect(await (await request("/counts")).json()).toMatchObject({ labels: [{ label: "inbox", threads: 1, unread: 1 }] });
		// Bob's unique correspondent must never appear in Alice's suggestions.
		await f.env.MAILBOX.getByName(ids.bob).ingest({ ...inbound(ids.bob, "private-contact"), from: { address: "private@outside.test" } });
		expect(await (await request("/contacts")).json()).toEqual({ contacts: [{ address: "sender@outside.test" }] });
		expect(await (await request("/me")).json()).toMatchObject({ mailboxes: [{ id: ids.alice }, { id: ids.shared }] });
	});

	it.each(["bob@example.com", "readonly@example.com", "disabled@example.com", "alice@receive.test"])("refuses sending as %s", async (from) => {
		expect((await request(`/mailboxes/${ids.alice}/send`, "POST", compose(from))).status).toBe(403);
		const storage = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await storage.exec("SELECT * FROM outbox")).toEqual([]);
	});

	it("requires the identity to route to the chosen mailbox, even when the user owns it elsewhere", async () => {
		expect((await request(`/mailboxes/${ids.shared}/send`, "POST", compose())).status).toBe(403);
	});

	it("allows normalized own identities and independently grants a group alias to each mailbox", async () => {
		expect((await request(`/mailboxes/${ids.alice}/send`, "POST", compose("Alice@Example.com"))).status).toBe(202);
		expect((await request(`/mailboxes/${ids.alice}/send`, "POST", compose("family@example.com"))).status).toBe(202);
		await f.env.DIRECTORY.prepare("UPDATE address_routes SET can_send = 0 WHERE address = 'family@example.com' AND mailbox_id = ?1").bind(ids.bob).run();
		expect((await request(`/mailboxes/${ids.bob}/send`, "POST", compose("family@example.com"), await f.login("bob"))).status).toBe(403);
		expect((await request(`/mailboxes/${ids.alice}/send`, "POST", compose("family@example.com"))).status).toBe(202);
	});

	it("rejects attachments from another mailbox without queuing a send", async () => {
		const response = await request(`/mailboxes/${ids.alice}/send`, "POST", { ...compose(), attachments: [{ r2Key: `uploads/${ids.bob}/stolen`, filename: "secret.pdf", contentType: "application/pdf", size: 4 }] });
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "Unknown attachment" });
	});

	it.each(["SELECT 1 AS ok FROM mailbox_members", "SELECT a.address, a.display_name"])("fails closed when the permission query fails: %s", async (query) => {
		await f.control.failNext("directory", query);
		expect((await request(`/mailboxes/${ids.alice}/send`, "POST", compose())).status).toBe(500);
		expect((await f.control.state()).sends).toEqual([]);
	});

	it("rechecks send permission on retry after it was revoked", async () => {
		const queued = z.object({ id: z.string() }).parse(await (await request(`/mailboxes/${ids.alice}/send`, "POST", { ...compose(), delaySeconds: 0 })).json());
		await f.control.setSendErrors(["E_INVALID_EMAIL"]);
		await f.env.MAILBOX.getByName(ids.alice).drain();
		await f.env.DIRECTORY.prepare("UPDATE address_routes SET can_send = 0 WHERE mailbox_id = ?1").bind(ids.alice).run();
		expect((await request(`/mailboxes/${ids.alice}/messages/${queued.id}/retry`, "POST")).status).toBe(403);
	});

	it.each(["bob@example.com", "readonly@example.com", "disabled@example.com", "alice@receive.test"])("refuses a signature for an identity the user can't send as: %s", async (address) => {
		expect((await request("/signatures", "PUT", { address, text: "Forged" })).status).toBe(403);
		expect((await f.env.DIRECTORY.prepare("SELECT * FROM signatures").all()).results).toEqual([]);
	});

	it("keeps signatures on a group alias private to each user", async () => {
		expect((await request("/signatures", "PUT", { address: "Family@Example.com", text: "Alice" })).status).toBe(200);
		expect((await request("/signatures", "PUT", { address: "family@example.com", text: "Bob" }, await f.login("bob"))).status).toBe(200);
		expect((await f.env.DIRECTORY.prepare("SELECT user_id, text FROM signatures ORDER BY user_id").all()).results).toEqual([{ user_id: "alice", text: "Alice" }, { user_id: "bob", text: "Bob" }]);
	});

	it("checks current admin status after a cached admin session is demoted", async () => {
		const admin = await f.login("admin");
		expect((await request("/admin/directory", "GET", undefined, cookie)).status).toBe(403);
		expect((await request("/admin/directory", "GET", undefined, admin)).status).toBe(200);
		await f.env.DIRECTORY.prepare("UPDATE auth_users SET role = 'user' WHERE id = 'admin'").run();
		expect((await request("/admin/directory", "GET", undefined, admin)).status).toBe(403);
	});

	it("rejects cross-origin authenticated requests", async () => {
		const response = await f.worker.fetch("https://magnus.test/api/threads", { headers: { Cookie: cookie, Origin: "https://attacker.test" } });
		expect(response.status).toBe(403);
	});
});
