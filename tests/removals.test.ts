import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LIVE_RECHECK, r2Keys, REMOVAL_DAYS } from "#shared";
import { addAddress, createMailbox, setSignature } from "../worker/directory";
import { discardDraft, saveDraft } from "../worker/drafts";
import { fixture, type Fixture, inbound, type Mailboxes, MIME, NOW, sendInput } from "./runtime/fixture";

const ORIGIN = "https://magnus.test";
const REMOVAL_MS = REMOVAL_DAYS * 24 * 3600_000;
const TOKEN = "removal-link-token-abc";

describe("removing a person", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let threadId: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		await f.env.DIRECTORY.prepare("DELETE FROM auth_rate_limits").run();
		// Dated the way Better Auth dates people, so a session cookie's cache answers for it as it would in production.
		await f.env.DIRECTORY.prepare("UPDATE auth_users SET createdAt = ?1, updatedAt = ?1").bind(new Date().toISOString()).run();
		// A letter in Alice's own mailbox, with a file she shares by link.
		const message = inbound(ids.alice);
		const key = r2Keys.attachment(ids.alice, message.id, "file");
		await f.env.MAIL.put(message.htmlKey!, "<p>Secret content</p>");
		await f.env.MAIL.put(key, "%PDF");
		const result = await f.env.MAILBOX.getByName(ids.alice).ingest({ ...message, attachments: [{
			id: "file", filename: "receipt.pdf", contentType: "application/pdf", size: 4, contentId: null, inline: false, r2Key: key, link: { token: TOKEN, shared: true },
		}] });
		if ("deleted" in result) throw new Error("Fixture message was deleted");
		threadId = result.threadId;
	});

	function call(path: string, cookie = "", method = "GET", body?: unknown) {
		return f.worker.fetch(`${ORIGIN}${path}`, {
			method, headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
	const remove = async (id = "alice") => call(`/api/admin/people/${id}`, await f.login("admin"), "DELETE");
	const restore = async (id = "alice") => call(`/api/admin/people/${id}/restore`, await f.login("admin"), "POST");
	const accept = (to: string) => f.worker.email({ from: "sender@outside.test", to, raw: MIME });
	const signIn = async () => call("/api/auth/sign-in/email-otp", "", "POST", { email: "alice@login.test", otp: await f.control.code("alice@login.test") });
	const mailboxIdsOf = async (cookie: string) => z.object({ mailboxes: z.array(z.object({ id: z.string() })) }).parse(await (await call("/api/me", cookie)).json()).mailboxes.map((m) => m.id);
	const removedAt = (at: number) => f.env.DIRECTORY.prepare("UPDATE removed_people SET removed_at = ?1").bind(at).run();
	const exists = async (sql: string, ...bindings: unknown[]) => (await f.env.DIRECTORY.prepare(sql).bind(...bindings).first()) !== null;

	it("shuts them out and stops their mail at once, but deletes nothing", async () => {
		const cookie = await f.login("alice");
		await f.env.DIRECTORY.prepare("UPDATE domains SET catch_all_mailbox_id = ?1 WHERE name = 'example.com'").bind(ids.alice).run();
		expect((await call(`/f/${ids.alice}/${TOKEN}/receipt.pdf`)).status).toBe(200);
		expect((await remove()).status).toBe(204);

		// The session is gone from D1. Its cookie still passes as signed in for a while, but reading mail asks D1.
		expect(await mailboxIdsOf(cookie)).toEqual([]);
		expect((await call(`/api/mailboxes/${ids.alice}/threads/${threadId}`, cookie)).status).toBe(404);
		expect(await exists("SELECT 1 FROM auth_sessions WHERE userId = 'alice'")).toBe(false);
		expect((await signIn()).status).toBe(403);
		expect((await call("/api/auth/admin/impersonate-user", await f.login("admin"), "POST", { userId: "alice" })).status).toBe(403);
		// Each was refused once its session was written, and the session went again.
		expect(await exists("SELECT 1 FROM auth_sessions WHERE userId = 'alice'")).toBe(false);

		// Refused: their own address, the catch-all that pointed at them, and their copy of a group's mail.
		expect(await accept("alice@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
		expect(await accept("nobody@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
		// Their address isn't left to a catch-all that delivers somewhere else, either.
		await f.env.DIRECTORY.prepare("UPDATE domains SET catch_all_mailbox_id = ?1 WHERE name = 'example.com'").bind(ids.bob).run();
		expect(await accept("alice@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
		await accept("family@example.com");
		expect((await f.control.state()).jobs.map((j) => j.mailboxId)).toEqual([ids.bob]);
		expect((await call(`/f/${ids.alice}/${TOKEN}/receipt.pdf`)).status).toBe(404);

		// The shared mailbox stays with Bob, and Alice's own is all still there.
		expect(await mailboxIdsOf(await f.login("bob"))).toContain(ids.shared);
		expect(await f.env.MAILBOX.getByName(ids.alice).getThread(threadId)).toMatchObject({ thread: { subject: "Secret letter" } });
		expect(await f.env.MAIL.head(r2Keys.attachment(ids.alice, "inbound-1", "file"))).not.toBeNull();
	});

	it("puts them back as they were when restored", async () => {
		await remove();
		await removedAt(Date.now() - 10 * 60_000);
		expect((await restore()).status).toBe(204);
		const signedIn = await signIn();
		expect(signedIn.status).toBe(200);
		const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect((await mailboxIdsOf(cookie)).sort()).toEqual([ids.alice, ids.shared].sort());
		expect((await call(`/api/mailboxes/${ids.alice}/threads/${threadId}`, cookie)).status).toBe(200);
		await accept("alice@example.com");
		expect((await f.control.state()).jobs.map((j) => j.mailboxId)).toEqual([ids.alice]);
		expect((await call(`/f/${ids.alice}/${TOKEN}/receipt.pdf`)).status).toBe(200);
		// Restoring again changes nothing.
		expect((await restore()).status).toBe(204);
		expect(await exists("SELECT 1 FROM mailbox_members WHERE user_id = 'alice' AND mailbox_id = ?1 AND role = 'member'", ids.shared)).toBe(true);
	});

	it("never lets a session the removal ended read mail again, even renewing its own cookie", async () => {
		const before = await f.login("alice");
		const content = { mailboxId: ids.alice, from: "alice@example.com", to: [], cc: [], bcc: [], subject: "Unsent", text: "Draft", attachments: [] };
		expect(await saveDraft(f.env.DIRECTORY, await f.reader("alice"), crypto.randomUUID(), { revision: 0, changeId: crypto.randomUUID(), content }, Date.now())).not.toBeNull();
		await remove();
		expect((await restore()).status).toBe(204);
		// Its cookie still passes as signed in, and asking who's signed in renews it from the cookie alone.
		const renewal = await call("/api/auth/get-session", before);
		expect(await renewal.json()).toMatchObject({ user: { id: "alice" } });
		const renewed = [before, ...renewal.headers.getSetCookie().map((c) => c.split(";")[0])].join("; ");
		for (const cookie of [before, renewed]) {
			expect(await mailboxIdsOf(cookie)).toEqual([]);
			expect((await call(`/api/mailboxes/${ids.alice}/threads/${threadId}`, cookie)).status).toBe(404);
			expect(await (await call("/api/drafts", cookie)).json()).toEqual({ drafts: [] });
		}
		// Signing in again gets it all back at once.
		const signedIn = await signIn();
		const cookie = signedIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect((await mailboxIdsOf(cookie)).sort()).toEqual([ids.alice, ids.shared].sort());
		expect((await (await call("/api/drafts", cookie)).json())).toMatchObject({ drafts: [{ content: { subject: "Unsent" } }] });
	});

	it("won't let a session the removal ended manage the account or use admin powers", async () => {
		await f.env.DIRECTORY.prepare("UPDATE auth_users SET role = 'admin' WHERE id = 'alice'").run();
		const before = await f.login("alice");
		await remove();
		await restore();
		for (const [path, body] of [
			["/api/auth/passkey/list-user-passkeys", undefined],
			["/api/auth/update-user", { name: "Mallory" }],
			["/api/auth/admin/set-role", { userId: "bob", role: "admin" }],
		] as const) {
			expect((await call(path, before, body === undefined ? "GET" : "POST", body)).status, path).toBe(401);
		}
		// Deleting someone at once, skipping their removal, isn't there at all, even for an admin who's still here; nor is
		// linking another account, which would sign in after the session that linked it ends.
		// (Better Auth answers a turned-off path in plain text, unlike its own errors.)
		for (const [path, user, body] of [["/api/auth/admin/remove-user", "admin", { userId: "bob" }], ["/api/auth/link-social", "bob", { provider: "google" }]] as const) {
			const response = await call(path, await f.login(user), "POST", body);
			expect([response.status, await response.text()], path).toEqual([404, "Not Found"]);
		}
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'bob'")).toBe(true);
		expect(await f.env.DIRECTORY.prepare("SELECT name FROM auth_users WHERE id = 'alice'").first()).toEqual({ name: "Alice" });
		expect(await f.env.DIRECTORY.prepare("SELECT role FROM auth_users WHERE id = 'bob'").first()).toEqual({ role: "user" });
	});

	it("saves or discards no draft, or signature, for a session that ended, though it was live when the request began", async () => {
		const before = await f.reader("alice");
		const content = { mailboxId: ids.alice, from: "alice@example.com", to: [], cc: [], bcc: [], subject: "Kept", text: "Draft", attachments: [] };
		const kept = await saveDraft(f.env.DIRECTORY, before, crypto.randomUUID(), { revision: 0, changeId: crypto.randomUUID(), content }, Date.now());
		if (!kept) throw new Error("Could not save fixture draft");
		await remove();
		await restore();
		expect(await saveDraft(f.env.DIRECTORY, before, crypto.randomUUID(), { revision: 0, changeId: crypto.randomUUID(), content: { ...content, subject: "Late" } }, Date.now())).toBeNull();
		expect(await discardDraft(f.env.DIRECTORY, before, kept.id, kept.revision)).toBe(false);
		await setSignature(f.env.DIRECTORY, before, "alice@example.com", "Mallory");
		expect(await exists("SELECT 1 FROM signatures WHERE user_id = 'alice'")).toBe(false);
		expect(await f.env.DIRECTORY.prepare("SELECT state, json_extract(content, '$.subject') AS subject FROM drafts WHERE user_id = 'alice'").all()).toMatchObject({
			results: [{ state: "active", subject: "Kept" }],
		});
	});

	it("lets an admin signed in as someone go back to their own session after that person is removed", async () => {
		const admin = await f.login("admin");
		const impersonating = await call("/api/auth/admin/impersonate-user", admin, "POST", { userId: "bob" });
		expect(impersonating.status).toBe(200);
		// The browser's cookies, those the response set replacing the admin's own.
		const jar = new Map([...admin.split("; "), ...impersonating.headers.getSetCookie().map((c) => c.split(";")[0] ?? "")].map((pair) => [pair.slice(0, pair.indexOf("=")), pair]));
		const asBob = [...jar.values()].join("; ");
		await f.env.DIRECTORY.prepare("DELETE FROM auth_sessions WHERE userId = 'bob'").run();
		expect((await call("/api/auth/admin/stop-impersonating", asBob, "POST", {})).status).toBe(200);
	});

	it("drops sign-in methods added after the removal when restoring, keeping every one from before", async () => {
		const passkey = (id: string, at: number) => f.env.DIRECTORY.prepare(
			"INSERT INTO auth_passkeys (id, publicKey, userId, credentialID, counter, deviceType, backedUp, createdAt) VALUES (?1, 'key', 'alice', ?1, 0, 'singleDevice', 0, ?2)",
		).bind(id, new Date(at).toISOString()).run();
		const account = (id: string, at: number) => f.env.DIRECTORY.prepare(
			"INSERT INTO auth_accounts (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?1, ?1, 'google', 'alice', ?2, ?2)",
		).bind(id, new Date(at).toISOString()).run();
		// One from moments before the removal stays too.
		await passkey("kept", Date.now() - 1000);
		await account("kept", Date.now() - 1000);
		// Restoring someone who isn't removed has nothing to compare against, and drops nothing.
		await restore();
		expect(await exists("SELECT 1 FROM auth_passkeys WHERE id = 'kept'")).toBe(true);
		await remove();
		// Finished just after the removal, by requests checked just before it.
		await passkey("planted", Date.now());
		await account("planted", Date.now());
		await restore();
		expect(await f.env.DIRECTORY.prepare("SELECT id FROM auth_passkeys").all()).toMatchObject({ results: [{ id: "kept" }] });
		expect(await f.env.DIRECTORY.prepare("SELECT id FROM auth_accounts WHERE userId = 'alice'").all()).toMatchObject({ results: [{ id: "kept" }] });
	});

	it("stops a suspended person's session reading mail at once, though its cookie still vouches for it", async () => {
		const cookie = await f.login("alice");
		expect((await call("/api/auth/admin/ban-user", await f.login("admin"), "POST", { userId: "alice" })).status).toBe(200);
		expect(await mailboxIdsOf(cookie)).toEqual([]);
		expect((await call(`/api/mailboxes/${ids.alice}/threads/${threadId}`, cookie)).status).toBe(404);
	});

	it("never hides or deletes a mailbox someone restored is in", async () => {
		// Alice and Bob share one: removing Alice leaves it to Bob, then removing Bob hides it with him.
		await remove("alice");
		await remove("bob");
		expect(await f.env.DIRECTORY.prepare("SELECT removed_with FROM mailboxes WHERE id = ?1").bind(ids.shared).first()).toEqual({ removed_with: "bob" });
		await restore("alice");
		expect(await f.env.DIRECTORY.prepare("SELECT removed_with FROM mailboxes WHERE id = ?1").bind(ids.shared).first()).toEqual({ removed_with: null });

		// Even one left hidden isn't deleted while someone's in it.
		await f.env.DIRECTORY.prepare("UPDATE mailboxes SET removed_with = 'bob' WHERE id = ?1").bind(ids.shared).run();
		await removedAt(NOW - REMOVAL_MS);
		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'bob'")).toBe(false);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.bob)).toBe(false);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.shared)).toBe(true);
		expect(await exists("SELECT 1 FROM mailbox_deletions WHERE mailbox_id = ?1", ids.shared)).toBe(false);
	});

	it("gives a removed person no new mailbox, address, or catch-all, even racing their removal", async () => {
		await remove();
		const admin = await f.login("admin");
		expect((await call("/api/admin/addresses", admin, "POST", { localPart: "new", domain: "example.com", mailboxIds: [ids.alice] })).status).toBe(400);
		expect((await call("/api/admin/domains/example.com", admin, "PATCH", { catchAllMailboxId: ids.alice })).status).toBe(400);
		// What a removal landing between the check and the write meets: the writes themselves refuse.
		const db = f.env.DIRECTORY;
		await expect(db.batch(addAddress(db, "late@example.com", null, [ids.alice]))).rejects.toThrow("NOT NULL");
		const mailbox = createMailbox(db, "alice", "Alice again");
		await expect(db.batch(mailbox.statements)).rejects.toThrow("NOT NULL");
		expect(await exists("SELECT 1 FROM addresses WHERE address = 'late@example.com'")).toBe(false);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", mailbox.id)).toBe(false);
	});

	it("keeps the first removal's date when removed again, and finds nobody who isn't there", async () => {
		await remove();
		await removedAt(NOW - 5);
		expect((await remove()).status).toBe(204);
		expect(await f.env.DIRECTORY.prepare("SELECT removed_at FROM removed_people").all()).toMatchObject({ results: [{ removed_at: NOW - 5 }] });
		expect((await remove("nobody")).status).toBe(404);
		expect((await restore("nobody")).status).toBe(404);
	});

	it("deletes them and their mail once the time is up, as removal used to at once", async () => {
		await remove();
		await removedAt(NOW - REMOVAL_MS + 1);
		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(true);

		await removedAt(NOW - REMOVAL_MS);
		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(false);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.alice)).toBe(false);
		// Addresses only they received go; a group's stays for Bob, and the shared mailbox stays with him.
		expect(await exists("SELECT 1 FROM addresses WHERE address = 'alice@example.com'")).toBe(false);
		expect(await f.env.DIRECTORY.prepare("SELECT mailbox_id FROM address_routes WHERE address = 'family@example.com'").all()).toMatchObject({ results: [{ mailbox_id: ids.bob }] });
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.shared)).toBe(true);
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
		expect(await exists("SELECT 1 FROM mailbox_deletions")).toBe(false);
		expect((await restore()).status).toBe(404);
	});

	it("waits to delete someone whose mailbox is being restored to an earlier time", async () => {
		await remove();
		await removedAt(NOW - REMOVAL_MS);
		await f.env.DIRECTORY.prepare("UPDATE mailboxes SET restoring = 'restore-1', restoring_until = ?2 WHERE id = ?1").bind(ids.alice, NOW + 60_000).run();
		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(true);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.alice)).toBe(true);
		await f.env.DIRECTORY.prepare("UPDATE mailboxes SET restoring = NULL, restoring_until = NULL WHERE id = ?1").bind(ids.alice).run();
		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(false);
	});

	it("tries a mailbox's deletion again next hour when it fails", async () => {
		await remove();
		await removedAt(NOW - REMOVAL_MS);
		await f.control.failNext("delete", r2Keys.mailbox(ids.alice));
		await expect(async () => f.control.purgeRemoved()).rejects.toThrow("1 mailbox deletions failed; retried next hour");
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(false);
		expect(await exists("SELECT 1 FROM mailbox_deletions WHERE mailbox_id = ?1", ids.alice)).toBe(true);
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).not.toEqual([]);

		await f.control.purgeRemoved();
		expect(await exists("SELECT 1 FROM mailbox_deletions")).toBe(false);
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
	});

	it.each([
		["restored", () => restore()],
		["removed again since", async () => { await restore(); await remove(); await removedAt(NOW - REMOVAL_MS + 1); }],
	])("leaves someone %s alone though the purge already picked them", async (_, since) => {
		await remove();
		await removedAt(NOW - REMOVAL_MS);
		await since();
		await f.control.purgePerson("alice");
		expect(await exists("SELECT 1 FROM auth_users WHERE id = 'alice'")).toBe(true);
		expect(await exists("SELECT 1 FROM mailboxes WHERE id = ?1", ids.alice)).toBe(true);
		expect(await exists("SELECT 1 FROM addresses WHERE address = 'alice@example.com'")).toBe(true);
		expect(await exists("SELECT 1 FROM mailbox_deletions")).toBe(false);
	});

	it("starts sending nothing once they're removed, even partway through a batch", async () => {
		const mailbox = f.env.MAILBOX.getByName(ids.alice);
		const ref = { r2Key: r2Keys.upload(ids.alice, "file"), filename: "receipt.pdf", contentType: "application/pdf", size: 4 };
		await f.env.MAIL.put(ref.r2Key, "%PDF");
		await mailbox.enqueueSend(sendInput(ids.alice, { attachments: [ref], subject: "First" }));
		await mailbox.enqueueSend(sendInput(ids.alice, { subject: "Second" }));
		// The removal lands while the first is copying its attachment: that one is on its way, the second hasn't started.
		await f.control.afterIO({ operation: "get", prefix: r2Keys.upload(ids.alice, ""), mailboxId: ids.alice, hide: true });
		await mailbox.drain();
		expect((await f.control.state()).sends.map((s) => s.subject)).toEqual(["First"]);
		const storage = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await storage.exec("SELECT subject, delivery_status FROM messages WHERE delivery_status IS NOT NULL ORDER BY subject")).toEqual([
			{ subject: "First", delivery_status: "sent" },
			{ subject: "Second", delivery_status: "failed" },
		]);
	});

	it("sends as usual from an alarm that runs before D1 is migrated, as one can after a deploy", async () => {
		await f.env.MAILBOX.getByName(ids.alice).enqueueSend(sendInput(ids.alice));
		await f.env.DIRECTORY.prepare("ALTER TABLE mailboxes DROP COLUMN removed_with").run();
		try {
			await f.env.MAILBOX.getByName(ids.alice).drain();
		} finally {
			await f.env.DIRECTORY.prepare("ALTER TABLE mailboxes ADD COLUMN removed_with TEXT").run();
		}
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	it("makes their open tabs check their sign-in at once, in mailboxes they shared too", async () => {
		const listen = async (mailboxId: string, cookie: string) => {
			const res = await f.worker.fetch(`${ORIGIN}/api/mailboxes/${mailboxId}/live`, { headers: { Cookie: cookie, Origin: ORIGIN, Upgrade: "websocket" } });
			if (!res.webSocket) throw new Error(`No socket: ${res.status}`);
			const heard: string[] = [];
			res.webSocket.addEventListener("message", (e) => heard.push(String(e.data)));
			res.webSocket.accept();
			return heard;
		};
		const alice = await f.login("alice");
		const own = await listen(ids.alice, alice);
		const shared = await listen(ids.shared, alice);
		await remove();
		await vi.waitFor(() => expect([own, shared]).toEqual([[LIVE_RECHECK], [LIVE_RECHECK]]));
		// Bob, still in the shared mailbox, reconnects; Alice's tab can't.
		await listen(ids.shared, await f.login("bob"));
		await expect(listen(ids.shared, alice)).rejects.toThrow("No socket: 404");
	});

	it("sends nothing they queued in a mailbox they shared, and what the others queued still goes", async () => {
		const mailbox = f.env.MAILBOX.getByName(ids.shared);
		await mailbox.enqueueSend(sendInput(ids.shared, { senderId: "alice", subject: "Alice's", delayMs: 10_000 }));
		await mailbox.enqueueSend(sendInput(ids.shared, { senderId: "bob", subject: "Bob's", delayMs: 10_000 }));
		await remove();
		await f.control.setNow(NOW + 10_000);
		// A directory that can't say sends nothing, and the outbox asks again in a minute.
		await f.control.failNext("directory", "SELECT 1 AS ok FROM mailbox_members WHERE user_id = ?1 AND mailbox_id = ?2");
		await mailbox.drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await mailbox.alarmAt()).toBe(NOW + 10_000 + 60_000);

		await mailbox.drain();
		expect((await f.control.state()).sends.map((s) => s.subject)).toEqual(["Bob's"]);
		const storage = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.shared });
		expect(await storage.exec("SELECT subject, delivery_detail FROM messages WHERE delivery_status = 'failed'")).toEqual([
			{ subject: "Alice's", delivery_detail: "Not sent: whoever sent it had left this mailbox when it was due." },
		]);
	});

	it("sends nothing of theirs that comes due while they're removed", async () => {
		const mailbox = f.env.MAILBOX.getByName(ids.alice);
		await mailbox.enqueueSend(sendInput(ids.alice, { delayMs: 10_000 }));
		await remove();
		await f.control.setNow(NOW + 10_000);
		// A directory that can't answer sends nothing, and the outbox asks again in a minute.
		await f.control.failNext("directory", "SELECT * FROM mailboxes WHERE id = ?1");
		await mailbox.drain();
		const storage = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await storage.exec("SELECT count(*) AS n FROM outbox")).toEqual([{ n: 1 }]);
		expect(await mailbox.alarmAt()).toBe(NOW + 10_000 + 60_000);

		await mailbox.drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await storage.exec("SELECT delivery_status, delivery_detail FROM messages WHERE delivery_status IS NOT NULL")).toEqual([
			{ delivery_status: "failed", delivery_detail: "Not sent: this mailbox was removed from Magnus when it was due." },
		]);
		expect(await storage.exec("SELECT count(*) AS n FROM outbox")).toEqual([{ n: 0 }]);
	});
});
