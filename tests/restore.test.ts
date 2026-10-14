import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { r2Keys, ulid, ulidTime } from "#shared";
import { claimDraft } from "../worker/drafts";
import { asQueued, fixture, type Fixture, inbound, type Mailboxes, NOW, sendInput } from "./runtime/fixture";

const ORIGIN = "https://magnus.test";
const DAY = 24 * 3600_000;
const TOKEN = "restore-link-token-abc";
const RAW = "From: sender@outside.test\r\n\r\nHi";
const LEASE_MS = 10 * 60_000;
const HELD = "Not sent: the mailbox was restored to before it went out, so it may have gone already. Send it again only if it didn't.";

// Local development has no point-in-time recovery: the test Mailbox stands in for Cloudflare's (tests/runtime/worker.ts),
// and its reset and restart are real.
describe("restoring a mailbox", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });
	const mailbox = () => f.env.MAILBOX.getByName(ids.alice);
	const storage = () => f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
	const hourAgo = () => new Date(Date.now() - 3600_000).toISOString();
	const restore = async (at: string, id = ids.alice, user: "admin" | "alice" = "admin") =>
		f.worker.fetch(`${ORIGIN}/api/admin/mailboxes/${id}/restore`, {
			method: "POST", headers: { Cookie: await f.login(user), Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ at }),
		});
	const restoreId = (id: string) => f.env.DIRECTORY.prepare("UPDATE mailboxes SET restore_id = ?2 WHERE id = ?1").bind(ids.alice, id).run();
	const delivery = async () => (await storage()).exec("SELECT delivery_status, delivery_detail FROM messages WHERE delivery_status IS NOT NULL ORDER BY id");
	const latestRestore = async () => z.object({ restore_id: z.string() }).parse(await f.env.DIRECTORY.prepare("SELECT restore_id FROM mailboxes WHERE id = ?1").bind(ids.alice).first()).restore_id;

	it("waits till nothing is waiting to send, which a restore would take away unsent, then restarts the mailbox into it", async () => {
		const later = asQueued(await mailbox().enqueueSend(sendInput(ids.alice, { subject: "Later", cc: [{ address: "cc@outside.test" }], delayMs: 3600_000 })));
		const refused = await restore(hourAgo());
		expect(refused.status).toBe(409);
		expect(await refused.json()).toMatchObject({ waiting: [{ subject: "Later", recipients: ["recipient@outside.test", "cc@outside.test"], sendAt: new Date(NOW + 3600_000).toISOString() }] });
		expect(await f.control.restored()).toEqual([]);

		expect(await mailbox().cancelSend(later.id)).toBe(true);
		const response = await restore(hourAgo());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ held: 0, linksStopped: 0, replayed: 0, unknown: 0, undo: { at: expect.any(String), bookmark: expect.any(String) } });
		expect(await f.control.restored()).toHaveLength(1);
		// What's sent after it goes as usual.
		await mailbox().enqueueSend(sendInput(ids.alice));
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	it("holds the outbox of a restored state even when its alarm runs before the restore is finished", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		await restoreId("restore-1");
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await delivery()).toEqual([{ delivery_status: "failed", delivery_detail: HELD }]);
	});

	it("sends nothing while the directory can't say whether the mailbox was restored, and asks again in a minute", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		await restoreId("restore-1");
		await f.control.failNext("directory", "SELECT * FROM mailboxes WHERE id = ?1");
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await mailbox().alarmAt()).toBe(NOW + 60_000);
		await mailbox().drain();
		expect(await delivery()).toEqual([{ delivery_status: "failed", delivery_detail: HELD }]);
	});

	it("applies a restore before queueing a send, so the new one goes", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice, { subject: "Brought back" }));
		// Restored to while another restore held sends, which this one lifts.
		await (await storage()).exec(`INSERT INTO _meta (key, value) VALUES ('restore_fence', '${NOW + 3600_000}')`);
		await restoreId("restore-1");
		await mailbox().enqueueSend(sendInput(ids.alice, { subject: "New" }));
		await mailbox().drain();
		expect((await f.control.state()).sends.map((s) => s.subject)).toEqual(["New"]);
		expect(await (await storage()).exec("SELECT subject, delivery_status FROM messages ORDER BY subject")).toEqual([
			{ subject: "Brought back", delivery_status: "failed" },
			{ subject: "New", delivery_status: "sent" },
		]);
	});

	it("goes on sending from the state before a restore until the mailbox restarts into it", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		await (await storage()).exec("INSERT INTO _meta (key, value) VALUES ('restore_pending:restore-1', '1')");
		await restoreId("restore-1");
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	it("refuses sends from when it begins, so none is lost to it, till it finishes or its hold runs out", async () => {
		// On the restore's clock, as the hold is.
		await f.control.setNow(Date.now());
		await f.control.setSendErrors(["E_REFUSED"]);
		const failed = asQueued(await mailbox().enqueueSend(sendInput(ids.alice)));
		await mailbox().drain();
		// It doesn't restart into the restore, so the restore fails and is armed for the next start.
		await f.control.setRestoresTake(false);
		expect((await restore(hourAgo())).status).toBe(500);
		const send = async () => f.worker.fetch(`${ORIGIN}/api/mailboxes/${ids.alice}/send`, {
			method: "POST", headers: { Cookie: await f.login("alice"), Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ from: "alice@example.com", to: [{ address: "friend@outside.test" }], subject: "Hi", text: "Hi", delaySeconds: 0 }),
		});
		const refused = await send();
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: expect.stringContaining("being restored") });
		expect(await mailbox().retrySend(failed.id, [], "alice")).toBe("restoring");

		await f.control.setNow(Date.now() + LEASE_MS + 1000);
		expect((await send()).status).toBe(202);
		await f.control.setSendErrors([]);
		await mailbox().drain();
		// Tried again, it finishes.
		await f.control.setRestoresTake(true);
		expect((await restore(hourAgo())).status).toBe(200);
	});

	it("stops every file the mailbox shares by link, before serving one", async () => {
		const message = inbound(ids.alice);
		const key = r2Keys.attachment(ids.alice, message.id, "file");
		await f.env.MAIL.put(key, "%PDF");
		await mailbox().ingest({ ...message, attachments: [{
			id: "file", filename: "receipt.pdf", contentType: "application/pdf", size: 4, contentId: null, inline: false, r2Key: key, link: { token: TOKEN, shared: true },
		}] });
		const link = () => f.worker.fetch(`${ORIGIN}/f/${ids.alice}/${TOKEN}/receipt.pdf`);
		expect((await link()).status).toBe(200);
		// Named by the directory, not yet finished: the link asks first.
		await restoreId(ulid(Date.now() - 60_000));
		expect((await link()).status).toBe(410);
		await f.env.DIRECTORY.prepare("UPDATE mailboxes SET restore_id = NULL WHERE id = ?1").bind(ids.alice).run();
		await (await storage()).exec("UPDATE attachments SET link_stopped = 0");
		expect(await (await restore(hourAgo())).json()).toMatchObject({ linksStopped: 1 });
		expect((await link()).status).toBe(410);
	});

	it("leaves alone a state that's from before an attempt which failed before rewinding, though a retry has begun", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		const meta = await storage();
		await meta.exec("INSERT INTO _meta (key, value) VALUES ('restore_pending:attempt-1', '1')");
		await meta.exec("INSERT INTO _meta (key, value) VALUES ('restore_pending:attempt-2', '1')");
		await restoreId("attempt-1");
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	it("applies a restore that rewound but didn't finish before trying another", async () => {
		// Rewound by attempt 1 (no mark of it), which failed before applying; attempt 2 then fails before rewinding.
		await mailbox().enqueueSend(sendInput(ids.alice));
		await restoreId("attempt-1");
		await f.control.setRestoresTake(false);
		expect((await restore(hourAgo())).status).toBe(500);
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await delivery()).toEqual([{ delivery_status: "failed", delivery_detail: HELD }]);
	});

	it("sends a draft a restore put back as a new send, not the one it failed", async () => {
		const id = crypto.randomUUID();
		const cookie = await f.login("alice");
		const content = { mailboxId: ids.alice, from: "alice@example.com", to: [{ address: "friend@outside.test" }], cc: [], bcc: [], subject: "Again", text: "Hi", attachments: [] };
		const save = (revision: number) => f.worker.fetch(`${ORIGIN}/api/drafts/${id}`, {
			method: "PUT", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ revision, changeId: crypto.randomUUID(), content }),
		});
		const send = (revision: number) => f.worker.fetch(`${ORIGIN}/api/mailboxes/${ids.alice}/send`, {
			method: "POST", headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({ from: content.from, to: content.to, subject: content.subject, text: content.text, delaySeconds: 60, draft: { id, revision } }),
		});
		expect((await save(0)).status).toBe(200);
		const first = z.object({ id: z.string() }).parse(await (await send(1)).json());
		expect(first.id).toBe(`draft-${id}-1`);
		await f.control.setNow(NOW + 60_000);
		await mailbox().drain();
		// Caught mid-send by a restore: D1 says it's sending, and the draft is a draft again.
		await f.env.DIRECTORY.prepare("UPDATE drafts SET state = 'sending', send_id = ?2, content = ?3 WHERE id = ?1").bind(id, first.id, JSON.stringify(content)).run();
		expect((await restore(hourAgo())).status).toBe(200);
		const again = z.object({ id: z.string() }).parse(await (await send(2)).json());
		expect(again.id).toBe(`draft-${id}-2`);
		expect(await (await storage()).exec("SELECT id, delivery_status FROM messages ORDER BY id")).toEqual([
			{ id: first.id, delivery_status: "sent" },
			{ id: again.id, delivery_status: "queued" },
		]);
	});

	it("turns a draft caught mid-send back into a draft, so retrying its send can't send it again", async () => {
		await f.env.DIRECTORY.prepare(
			"INSERT INTO drafts (id, user_id, mailbox_id, content, revision, change_id, updated_at, state, send_id) VALUES ('d1', 'alice', ?1, '{}', 3, 'c', 1, 'sending', 'draft-d1')",
		).bind(ids.alice).run();
		expect((await restore(hourAgo())).status).toBe(200);
		expect(await f.env.DIRECTORY.prepare("SELECT state, revision, send_id FROM drafts WHERE id = 'd1'").first()).toEqual({ state: "active", revision: 4, send_id: null });
		expect(await claimDraft(f.env.DIRECTORY, "alice", "d1", 3, "draft-d1")).toBeNull();
	});

	it("answers with the way back when it fails after rewinding", async () => {
		const at = Date.now() - 3600_000;
		const id = ulid(at + 1000);
		await f.env.MAIL.put(r2Keys.raw(id, at + 1000), RAW, { customMetadata: { envelopeFrom: "sender@outside.test", envelopeTo: "alice@example.com", mailboxes: ids.alice } });
		await f.control.failNext("queue");
		const response = await restore(new Date(at).toISOString());
		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: expect.stringContaining("Restore again"), undo: { at: expect.any(String), bookmark: expect.any(String) } });
		// And the mailbox is free for that.
		expect((await restore(new Date(at).toISOString())).status).toBe(200);
	});

	it("still answers with what it did when letting go of the mailbox fails, and the hold runs out", async () => {
		await f.control.failNext("directory", "UPDATE mailboxes SET restoring = NULL");
		const response = await restore(hourAgo());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ undo: { bookmark: expect.any(String) } });
		expect(await f.env.DIRECTORY.prepare("SELECT restoring_until > ?2 AS held FROM mailboxes WHERE id = ?1").bind(ids.alice, Date.now()).first()).toEqual({ held: 1 });
	});

	it("restores one at a time, and takes over from one that died", async () => {
		const hold = (until: number) => f.env.DIRECTORY.prepare("UPDATE mailboxes SET restoring = 'other', restoring_until = ?2 WHERE id = ?1").bind(ids.alice, until).run();
		await hold(Date.now() + 60_000);
		expect((await restore(hourAgo())).status).toBe(409);
		expect(await f.control.restored()).toEqual([]);
		await hold(Date.now() - 1);
		expect((await restore(hourAgo())).status).toBe(200);
		expect(await f.env.DIRECTORY.prepare("SELECT restoring FROM mailboxes WHERE id = ?1").bind(ids.alice).first()).toEqual({ restoring: null });
	});

	it("undoes a restore exactly, to the bookmark it answered with", async () => {
		const first = await (await restore(hourAgo())).json();
		const undo = z.object({ undo: z.object({ at: z.string(), bookmark: z.string() }) }).parse(first).undo;
		expect((await f.worker.fetch(`${ORIGIN}/api/admin/mailboxes/${ids.alice}/restore`, {
			method: "POST", headers: { Cookie: await f.login("admin"), Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(undo),
		})).status).toBe(200);
		expect((await f.control.restored()).at(-1)).toBe(undo.bookmark);
		expect((await f.worker.fetch(`${ORIGIN}/api/admin/mailboxes/${ids.alice}/restore`, {
			method: "POST", headers: { Cookie: await f.login("admin"), Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify({ at: undo.at, bookmark: "not-one" }),
		})).status).toBe(400);
	});

	it("leaves the mailbox alone when the directory is put back to before a later restore of it", async () => {
		expect((await restore(hourAgo())).status).toBe(200);
		const first = await latestRestore();
		expect((await restore(hourAgo())).status).toBe(200);
		await mailbox().enqueueSend(sendInput(ids.alice, { delayMs: 10_000 }));
		// D1 Time Travel to between the two names the first again.
		await restoreId(first);
		await f.control.setNow(NOW + 10_000);
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	const bob = () => f.env.MAILBOX.getByName(ids.bob);
	it.each([
		{
			other: "let its copy go",
			setup: async (id: string, rawKey: string, at: number) => {
				await bob().holding([]);
				await (await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.bob })).exec(`INSERT INTO deleted_messages (id, raw_key, received_at) VALUES ('${id}', '${rawKey}', ${at})`);
			},
			letGo: async () => { await bob().drain(); },
		},
		{
			other: "is deleted",
			setup: async (id: string, rawKey: string, at: number) => {
				await bob().ingest({ ...inbound(ids.bob, id), rawKey, receivedAt: at, htmlKey: null });
				// Gone from the directory first, as the purge does.
				await f.env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(ids.bob).run();
			},
			letGo: async () => { await bob().destroy().then(() => undefined, () => undefined); },
		},
	])("keeps the originals it takes mail in again from, though another mailbox they were for $other", async ({ setup, letGo }) => {
		// Other mailboxes' cleanup on the restore's clock.
		await f.control.setNow(Date.now());
		const at = Date.now() - 2 * DAY;
		const id = ulid(at + 1000);
		const rawKey = r2Keys.raw(id, at + 1000);
		await f.env.MAIL.put(rawKey, RAW, { customMetadata: { envelopeFrom: "sender@outside.test", envelopeTo: "family@example.com", mailboxes: `${ids.alice},${ids.bob}` } });
		await setup(id, rawKey, at + 1000);
		expect(await (await restore(new Date(at).toISOString())).json()).toMatchObject({ replayed: 1 });
		// Till Alice has it again, she doesn't hold it. Bob's cleanup comes back once she can have.
		await letGo();
		expect(await f.env.MAIL.head(rawKey)).not.toBeNull();
		expect(await bob().alarmAt()).toBe(ulidTime(await latestRestore()) + LEASE_MS + DAY);
		// Once she can have taken it in again (here she never did), it goes as usual.
		await restoreId(ulid(Date.now() - DAY - LEASE_MS - 1000));
		await letGo();
		expect(await f.env.MAIL.head(rawKey)).toBeNull();
	});

	it("queues again the mail this mailbox should have and doesn't, from the day before the moment restored to on", async () => {
		const since = Date.now() - 2 * DAY;
		const original = async (at: number, mailboxes?: string, to = "alice@example.com") => {
			const id = ulid(at);
			await f.env.MAIL.put(r2Keys.raw(id, at), RAW, {
				customMetadata: mailboxes === undefined ? {} : { envelopeFrom: "sender@outside.test", envelopeTo: to, mailboxes },
			});
			return id;
		};
		await original(since - DAY - 1000, ids.alice);
		// Received just before, but it may have been taken in after.
		const late = await original(since - 1000, ids.alice);
		const shared = await original(since + 1000, `${ids.alice},${ids.bob}`, "Family+News@example.com");
		await original(since + DAY, ids.bob);
		await original(since + 2000);
		const latest = await original(Date.now() - 1000, ids.alice);
		// One it has already, which isn't parsed again.
		const had = await original(since + 3000, ids.alice);
		const result = await mailbox().ingest({ ...inbound(ids.alice, had), receivedAt: since + 3000, htmlKey: null });
		expect("deleted" in result).toBe(false);

		const response = await restore(new Date(since).toISOString());
		expect(await response.json()).toMatchObject({ replayed: 3, unknown: 1 });
		expect((await f.control.state()).jobs.map((j) => j.ingestId)).toEqual([late, shared, latest]);
		expect((await f.control.state()).jobs.slice(1)).toEqual([
			{ v: 1, ingestId: shared, rawKey: r2Keys.raw(shared, since + 1000), rawSize: RAW.length, mailboxId: ids.alice, envelopeFrom: "sender@outside.test", envelopeTo: "Family+News@example.com", subaddress: "news", receivedAt: since + 1000 },
			{ v: 1, ingestId: latest, rawKey: r2Keys.raw(latest, Date.now() - 1000), rawSize: RAW.length, mailboxId: ids.alice, envelopeFrom: "sender@outside.test", envelopeTo: "alice@example.com", subaddress: null, receivedAt: expect.any(Number) },
		]);
	});

	it.each([
		["in the future", () => new Date(Date.now() + 3600_000).toISOString()],
		["over 30 days ago", () => new Date(Date.now() - 31 * DAY).toISOString()],
	])("refuses a time %s", async (_, at) => {
		expect((await restore(at())).status).toBe(400);
		expect(await f.control.restored()).toEqual([]);
	});

	it("finds no mailbox that isn't there, and lets only admins restore", async () => {
		expect((await restore(hourAgo(), "nobody")).status).toBe(404);
		expect((await restore(hourAgo(), ids.alice, "alice")).status).toBe(403);
		expect(await f.control.restored()).toEqual([]);
	});
});
