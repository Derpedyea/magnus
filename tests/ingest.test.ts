import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, job, type Mailboxes, MIME, NOW } from "./runtime/fixture";
import { r2Keys } from "#shared";

describe("ingest", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });
	async function store(raw = MIME, mailboxId = ids.alice) {
		const input = job(mailboxId);
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: `${ids.alice},${ids.bob}` } });
		return input;
	}

	it("parses MIME, stores separate bodies/files, and carries threading, addresses, auth, and +tag labels into SQLite", async () => {
		const input = { ...await store(), subaddress: "Receipts" };
		await f.control.parse(input);
		const stored = await f.env.MAILBOX.getByName(ids.alice).getMessage(input.ingestId);
		expect(stored?.message).toMatchObject({
			from: { address: "sender@outside.test", name: "Sender" }, to: [{ address: "alice@example.com", name: "Alice" }],
			cc: [{ address: "friend@outside.test", name: "Friend" }], replyTo: [{ address: "reply@outside.test", name: "Replies" }],
			subject: "Receipt", date: NOW, messageIdHeader: "<receipt@outside.test>", auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
			labels: expect.arrayContaining(["inbox", "receipts"]),
		});
		expect(stored?.blobs).toMatchObject({ rawKey: input.rawKey, htmlKey: r2Keys.html(ids.alice, input.ingestId), attachments: [
			{ id: `${input.ingestId}-1`, filename: "receipt.pdf", contentType: "application/pdf", size: 4, inline: false, contentId: null },
			{ id: `${input.ingestId}-2`, filename: "logo.png", contentType: "image/png", size: 3, inline: true, contentId: "logo" },
		] });
		expect(stored?.message.text?.trim()).toBe("Your receipt");
		const db = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await db.exec("SELECT in_reply_to, refs FROM messages")).toEqual([{ in_reply_to: '["<parent@outside.test>"]', refs: '["<root@outside.test>","<parent@outside.test>"]' }]);
		expect((await (await f.env.MAIL.get(r2Keys.html(ids.alice, input.ingestId)))?.text())?.trim()).toBe("<p>Your <b>receipt</b></p>");
		expect(await (await f.env.MAIL.get(r2Keys.attachment(ids.alice, input.ingestId, `${input.ingestId}-1`)))?.text()).toBe("%PDF");
	});

	it("replays the same job without duplicate messages or orphaned objects, and isolates fan-out copies", async () => {
		const input = await store();
		await f.control.parse(input);
		await f.control.parse(input);
		await f.control.parse({ ...input, mailboxId: ids.bob });
		const a = await f.env.MAILBOX.getByName(ids.alice).listThreads({ label: "inbox", limit: 50 });
		const b = await f.env.MAILBOX.getByName(ids.bob).listThreads({ label: "inbox", limit: 50 });
		expect(a).toMatchObject([{ messageCount: 1 }]);
		expect(b).toMatchObject([{ messageCount: 1 }]);
		expect((await f.env.MAIL.list()).objects).toHaveLength(7);
	});

	it.each(["get", "put", "directory"] as const)("propagates %s failures and a replay completes from the retained original", async (operation) => {
		const input = await store();
		await f.control.failNext(operation, operation === "put" ? r2Keys.attachment(ids.alice, input.ingestId, `${input.ingestId}-2`) : "");
		await expect(Promise.resolve().then(() => f.control.parse(input))).rejects.toMatchObject({ message: `Injected ${operation} failure` });
		expect(await f.env.MAIL.head(input.rawKey)).not.toBeNull();
		await f.control.parse(input);
		expect(await f.env.MAILBOX.getByName(ids.alice).holding([input.ingestId])).toEqual([input.ingestId]);
		expect((await f.env.MAIL.list()).objects).toHaveLength(4);
	});

	it.each([
		["spf=pass; dkim=pass; dmarc=fail", "spam"],
		["spf=fail; dkim=none; dmarc=none", "spam"],
		["spf=fail; dkim=pass; dmarc=none", "inbox"],
	])("classifies the stamped results %s as %s", async (verdicts, label) => {
		const input = await store(MIME.replace("spf=pass; dkim=pass; dmarc=pass", verdicts));
		await f.control.parse(input);
		expect((await f.env.MAILBOX.getByName(ids.alice).getMessage(input.ingestId))?.message.labels).toEqual([label]);
	});

	it("uses envelope/date fallbacks and searchable text for HTML-only mail without auth headers", async () => {
		const input = await store("Date: nonsense\r\nContent-Type: text/html\r\n\r\n<head><title>Ignore</title></head><p>Hello &amp; welcome</p><script>secret()</script>");
		await f.control.parse(input);
		expect((await f.env.MAILBOX.getByName(ids.alice).getMessage(input.ingestId))?.message).toMatchObject({
			from: { address: "sender@outside.test" }, subject: "(no subject)", date: NOW, text: "Hello & welcome", auth: null, labels: ["inbox"],
		});
	});

	it("acks a missing original without inventing a message", async () => {
		expect(await f.control.consume([job(ids.alice)])).toEqual({ acks: ["0"], retries: [] });
		expect(await f.env.MAILBOX.getByName(ids.alice).holding(["inbound-1"])).toEqual([]);
	});

	it("clears a deleted mailbox but preserves the original for a live fan-out recipient", async () => {
		const input = await store();
		await f.env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(ids.alice).run();
		await f.control.parse(input);
		expect(await f.env.MAIL.head(input.rawKey)).not.toBeNull();
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
		await f.control.parse({ ...input, mailboxId: ids.bob });
		expect(await f.env.MAILBOX.getByName(ids.bob).holding([input.ingestId])).toEqual([input.ingestId]);
	});

	it("clears files and the orphaned original if the mailbox is deleted during a write", async () => {
		const input = await store();
		await f.env.MAIL.put(input.rawKey, MIME, { customMetadata: { mailboxes: ids.alice } });
		await f.control.afterIO({ operation: "put", prefix: r2Keys.html(ids.alice, input.ingestId), mailboxId: ids.alice });
		await f.control.parse(input);
		expect((await f.env.MAIL.list()).objects).toEqual([]);
	});

	it("retries a failed deletion instead of dropping cleanup", async () => {
		const input = await store();
		await f.control.parse(input);
		await f.env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(ids.alice).run();
		await f.control.failNext("delete", r2Keys.mailbox(ids.alice));
		expect(await f.control.consume([input])).toEqual({ acks: [], retries: [{ id: "0", delaySeconds: 30 }] });
		expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
		expect(await f.env.MAIL.head(input.rawKey)).not.toBeNull();
	});
});
