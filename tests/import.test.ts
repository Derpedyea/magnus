import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, inbound, job, type Mailboxes } from "./runtime/fixture";
import { r2Keys } from "#shared";
import { z } from "zod";

const RECEIVED = Date.UTC(2021, 4, 2, 9, 30);
const Accepted = z.object({ id: z.string() });

/** A message as Proton's Export Tool writes it: its internal id in X-Pm-Internal-Id and appended to References. */
function eml(overrides: { id?: string; from?: string; to?: string; subject?: string; date?: string; inReplyTo?: string; internal?: string; auth?: string } = {}) {
	const { id = "<hello@outside.test>", from = "Sender <sender@outside.test>", to = "Old Me <old@proton.test>", subject = "Hello", internal = "AbC123==" } = overrides;
	return [
		`From: ${from}`, `To: ${to}`, "Delivered-To: alice@example.com", `Subject: ${subject}`, `Date: ${overrides.date ?? "Sun, 02 May 2021 09:00:00 +0000"}`,
		`X-Pm-Date: ${new Date(RECEIVED).toUTCString()}`, `Message-ID: ${id}`, `X-Pm-Internal-Id: ${internal}`,
		...(overrides.inReplyTo ? [`In-Reply-To: ${overrides.inReplyTo}`] : []),
		`References: ${overrides.inReplyTo ? `${overrides.inReplyTo} ` : ""}<${internal}@protonmail.internalid>`,
		`Authentication-Results: mx.proton.test; ${overrides.auth ?? "spf=pass; dkim=pass; dmarc=pass"}`,
		'Content-Type: multipart/mixed; boundary="parts"', "", "--parts", "Content-Type: text/html; charset=utf-8", "", "<p>Hi there</p>",
		"--parts", 'Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERg==",
		"--parts--", "",
	].join("\r\n");
}

describe("import", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	function upload(body: string, query = "labels=inbox,work&read=1&sent=0", mailboxId = ids.alice, session = cookie) {
		return f.worker.fetch(`https://magnus.test/api/mailboxes/${mailboxId}/import?${query}`, {
			method: "POST", headers: { Cookie: session, "Content-Type": "message/rfc822" }, body,
		});
	}
	/** Uploads and parses what it queued, as the inbound queue would. */
	async function importNow(body: string, query?: string) {
		const res = await upload(body, query);
		expect(res.status).toBe(202);
		const { id } = Accepted.parse(await res.json());
		const queued = (await f.control.state()).jobs.find((j) => j.ingestId === id);
		if (!queued) throw new Error("Nothing queued");
		await f.control.parse(queued);
		return { id, job: queued };
	}
	const alice = () => f.env.MAILBOX.getByName(ids.alice);

	it("refuses people outside the mailbox", async () => {
		expect((await upload(eml(), undefined, ids.alice, "")).status).toBe(401);
		expect((await upload(eml(), undefined, ids.bob)).status).toBe(404);
		expect((await upload(eml(), undefined, "guessed")).status).toBe(404);
		expect((await f.control.state()).jobs).toEqual([]);
	});

	it.each([
		["a file that isn't mail", "\u0089PNG\r\n\u001a\n\u0000\u0000binary", undefined, 422],
		["the outbox", eml(), "labels=outbox&read=1", 400],
		["a view's name", eml(), "labels=all&read=1", 400],
		["a label with a comma inside", eml(), "labels=a%2Cb%20c&read=1", 400],
		["no read state", eml(), "labels=inbox", 400],
	])("refuses %s without storing anything", async (_, body, query, status) => {
		expect((await upload(body, query)).status).toBe(status);
		expect((await f.control.state()).jobs).toEqual([]);
		expect((await f.env.MAIL.list()).objects).toEqual([]);
	});

	it("refuses a message over the inbound limit before reading it", async () => {
		const res = await upload("x".repeat(25 * 1024 * 1024 + 1));
		expect(res.status).toBe(413);
		expect((await f.env.MAIL.list()).objects).toEqual([]);
	});

	it("queues the original with its placement and the envelope its headers give, then files it as it was there", async () => {
		const { id, job: queued } = await importNow(eml({ auth: "spf=fail; dkim=fail; dmarc=fail" }));
		expect(queued).toMatchObject({
			rawKey: r2Keys.imported(ids.alice, id), mailboxId: ids.alice, envelopeFrom: "sender@outside.test", envelopeTo: "alice@example.com",
			subaddress: null, receivedAt: RECEIVED, imported: { labels: ["inbox", "work"], read: true, sent: false },
		});
		expect(await f.env.MAIL.head(queued.rawKey)).toMatchObject({ customMetadata: { mailboxes: ids.alice } });

		const stored = await alice().getMessage(id);
		// Verdicts in the file aren't ours to show or triage by.
		expect(stored?.message).toMatchObject({ direction: "in", isRead: true, auth: null, labels: expect.arrayContaining(["inbox", "work"]) });
		expect(stored?.message.labels).toHaveLength(2);
		const db = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await db.exec("SELECT refs FROM messages")).toEqual([{ refs: "[]" }]);
		expect(await alice().listThreads({ label: "inbox", limit: 50, addresses: ["alice@example.com"] })).toMatchObject([{ subject: "Hello", unreadCount: 0 }]);
	});

	it("files mail from one of the mailbox's addresses as sent when the export doesn't say, and learns who it went to", async () => {
		const { id, job: queued } = await importNow(eml({ from: "Alice <alice@example.com>", to: "Pal <pal@outside.test>" }), "read=1");
		expect(queued).toMatchObject({ envelopeTo: "alice@example.com", imported: { labels: ["sent"], sent: true } });
		expect((await alice().getMessage(id))?.message).toMatchObject({ direction: "out", labels: ["sent"] });
		expect(await alice().contacts(10)).toEqual([expect.objectContaining({ address: "pal@outside.test", sent: 1 })]);
	});

	it("is the same message when the same file is imported again", async () => {
		const first = await importNow(eml());
		const objects = (await f.env.MAIL.list()).objects.map((o) => o.key).sort();
		const again = await importNow(eml());
		expect(again.id).toBe(first.id);
		expect(await alice().listThreads({ label: "all", limit: 50 })).toMatchObject([{ messageCount: 1 }]);
		expect((await f.env.MAIL.list()).objects.map((o) => o.key).sort()).toEqual(objects);
	});

	it("leaves mail already here as it is, and keeps nothing of the imported copy", async () => {
		const here = inbound(ids.alice, "live-1");
		await alice().ingest({ ...here, messageIdHeader: "<hello@outside.test>", labels: ["inbox"] });
		await alice().modifyThreads({ threadIds: (await alice().listThreads({ label: "inbox", limit: 50 })).map((t) => t.id), remove: ["inbox"] });
		await importNow(eml(), "labels=trash&read=0");
		expect((await alice().getMessage("live-1"))?.message).toMatchObject({ labels: [], isRead: false });
		expect(await alice().listThreads({ label: "all", limit: 50 })).toMatchObject([{ messageCount: 1 }]);
		expect((await f.env.MAIL.list()).objects).toEqual([]);
	});

	it("threads a reply imported before the message it answers", async () => {
		const reply = await importNow(eml({ id: "<reply@outside.test>", subject: "Re: Plans", date: "Mon, 03 May 2021 09:00:00 +0000", inReplyTo: "<plans@outside.test>", internal: "reply==" }));
		const original = await importNow(eml({ id: "<plans@outside.test>", subject: "Plans", internal: "plans==" }));
		const threads = await alice().listThreads({ label: "inbox", limit: 50 });
		// Titled by the message that started it, as if they'd come in order.
		expect(threads).toMatchObject([{ messageCount: 2, subject: "Plans" }]);
		expect((await alice().getMessage(original.id))?.message.threadId).toBe((await alice().getMessage(reply.id))?.message.threadId);
	});

	it("doesn't guess a reply's conversation from its subject, since what it answers can still be on its way", async () => {
		// An earlier "Plans" conversation the same sender is in.
		await importNow(eml({ id: "<plans-1@outside.test>", subject: "Plans", date: "Sat, 01 May 2021 09:00:00 +0000", internal: "p1==" }));
		const reply = await importNow(eml({ id: "<reply-2@outside.test>", subject: "Re: Plans", inReplyTo: "<plans-2@outside.test>", internal: "r2==" }));
		const original = await importNow(eml({ id: "<plans-2@outside.test>", subject: "Plans", internal: "p2==" }));
		expect(await alice().listThreads({ label: "inbox", limit: 50 })).toMatchObject([{ messageCount: 2 }, { messageCount: 1 }]);
		expect((await alice().getMessage(reply.id))?.message.threadId).toBe((await alice().getMessage(original.id))?.message.threadId);
	});

	it("doesn't let live mail claim a Message-ID it names, or rename a thread by its date", async () => {
		const live = (id: string, subject: string, date: number, refs: string[] = []) =>
			alice().ingest({ ...inbound(ids.alice, id), messageIdHeader: `<${id}@outside.test>`, subject, date, inReplyTo: refs, references: refs });
		// A stranger names a GitHub thread's id before GitHub's own mail for it arrives.
		await live("bait", "Click here", RECEIVED, ["<pull-9@outside.test>"]);
		await live("pull-9", "Fix the build", RECEIVED + 1000);
		expect(await alice().listThreads({ label: "inbox", limit: 50 })).toMatchObject([{ messageCount: 1 }, { messageCount: 1 }]);
		// A reply dated before the thread it answers.
		await live("reply", "URGENT: wire transfer", RECEIVED - 1000, ["<pull-9@outside.test>"]);
		expect(await alice().listThreads({ label: "inbox", limit: 50 })).toMatchObject([{ subject: "Fix the build", messageCount: 2 }, { subject: "Click here" }]);
	});

	it("doesn't let imported spam claim the Message-IDs it names", async () => {
		await importNow(eml({ id: "<bait@outside.test>", subject: "Click here", inReplyTo: "<plans@outside.test>", internal: "bait==" }), "labels=spam&read=1&sent=0");
		await importNow(eml({ id: "<plans@outside.test>", subject: "Plans", internal: "plans==" }));
		expect(await alice().listThreads({ label: "all", limit: 50 })).toMatchObject([{ messageCount: 1 }]);
	});

	it("keeps a message's files when it's imported again while the copy it replaced is still being cleaned up", async () => {
		await alice().ingest({ ...inbound(ids.alice, "live-1"), messageIdHeader: "<hello@outside.test>" });
		// R2 refuses to delete, so the dropped copy's files stay queued for deletion.
		const res = await upload(eml());
		const { id } = Accepted.parse(await res.json());
		// Every try, until reset(): cleanup alarms also fire on their own here.
		await f.control.failNext("delete", r2Keys.message(ids.alice, id), 100);
		await f.control.parse((await f.control.state()).jobs[0]!);
		await alice().modifyThreads({ threadIds: (await alice().listThreads({ label: "inbox", limit: 50 })).map((t) => t.id), add: ["trash"] });
		await alice().deleteTrash({});
		await f.control.reset();
		await importNow(eml());
		await alice().drain();
		expect(await f.env.MAIL.head(r2Keys.html(ids.alice, id))).not.toBeNull();
		expect(await f.env.MAIL.head(r2Keys.imported(ids.alice, id))).not.toBeNull();
	});

	it("keeps a date from the future out of when it was received, so deleting it cleans up now", async () => {
		const { job: queued } = await importNow(eml().replace(/Date: .*\r\n/, "Date: Thu, 01 Jan 2099 00:00:00 +0000\r\n").replace(/X-Pm-Date: .*\r\n/, ""));
		expect(queued.receivedAt).toBeLessThanOrEqual(Date.now());
	});

	it("keeps how many ids an imported message can claim in bounds", async () => {
		const refs = Array.from({ length: 2000 }, (_, i) => `<ref-${i}@outside.test>`).join(" ");
		await importNow(eml({ inReplyTo: `${refs} ${refs}` }));
		const db = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		const [row] = await db.exec("SELECT count(*) AS n FROM thread_refs");
		expect(Number(row?.n)).toBeLessThanOrEqual(65);
	});

	it("doesn't take the reference Proton adds to each message for a reply", async () => {
		// Same sender and subject: a reply with nothing to match would fall back to joining the other.
		await importNow(eml({ id: "<digest-1@outside.test>", subject: "Weekly digest", internal: "one==" }));
		await importNow(eml({ id: "<digest-2@outside.test>", subject: "Weekly digest", internal: "two==" }));
		expect(await alice().listThreads({ label: "inbox", limit: 50 })).toMatchObject([{ messageCount: 1 }, { messageCount: 1 }]);
	});

	it("keeps an import's placement when it's retried from Failed", async () => {
		const res = await upload(eml(), "labels=work&read=1&sent=0");
		const { id } = Accepted.parse(await res.json());
		const [queued] = (await f.control.state()).jobs;
		await f.control.failNext("get", queued!.rawKey);
		await f.control.consume([queued], 10);
		expect(await alice().listFailed({})).toMatchObject([{ id, to: "alice@example.com" }]);
		await f.control.reset();
		await alice().retryFailed(id);
		const [retried] = (await f.control.state()).jobs;
		expect(retried).toEqual(queued);
		await f.control.parse(retried!);
		expect((await alice().getMessage(id))?.message).toMatchObject({ labels: ["work"], isRead: true });
	});

	it("retries failed mail with where its latest import put it", async () => {
		const first = { ...job(ids.alice, "again-1"), imported: { labels: ["inbox"], read: false, sent: false } };
		await alice().recordFailed(first, "Unreadable");
		await alice().recordFailed({ ...first, imported: { labels: ["work"], read: true, sent: false } }, "Unreadable");
		await f.control.reset();
		await alice().retryFailed("again-1");
		expect((await f.control.state()).jobs).toMatchObject([{ imported: { labels: ["work"], read: true } }]);
	});

	it("lists imported mail that names no address of ours, or none at all, under Failed", async () => {
		const input = { ...job(ids.alice, "nowhere-1"), envelopeTo: "", imported: { labels: [], read: true, sent: false } };
		await alice().recordFailed(input, "Unreadable");
		expect(await alice().listFailed({})).toMatchObject([{ id: "nowhere-1", to: "" }]);
	});
});
