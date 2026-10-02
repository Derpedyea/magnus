import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, type Mailboxes, NOW, sendInput } from "./runtime/fixture";
import { r2Keys, type SendAttachmentRef } from "#shared";

describe("send alarm", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });
	const mailbox = () => f.env.MAILBOX.getByName(ids.alice);
	const storage = () => f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
	async function upload(): Promise<SendAttachmentRef> {
		const ref = { r2Key: r2Keys.upload(ids.alice, "file"), filename: "receipt.pdf", contentType: "application/pdf", size: 4 };
		await f.env.MAIL.put(ref.r2Key, "%PDF");
		return ref;
	}

	it("waits for the scheduled time, records the handoff, and doesn't resend on another alarm", async () => {
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { delayMs: 10_000 }));
		expect(queued?.sendAt).toBe(NOW + 10_000);
		expect(await mailbox().alarmAt()).toBe(NOW + 10_000);
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await (await storage()).exec("SELECT attempts FROM outbox")).toEqual([{ attempts: 0 }]);
		await f.control.setNow(NOW + 10_000);
		await mailbox().drain();
		expect((await f.control.state()).sends).toMatchObject([{ from: { email: "alice@example.com", name: "Alice" }, to: ["recipient@outside.test"], subject: "Hello", text: "Hello world" }]);
		expect(await (await storage()).exec("SELECT delivery_status, provider_message_id, message_id_header FROM messages")).toEqual([
			{ delivery_status: "sent", provider_message_id: "provider-1@example.net", message_id_header: "<provider-1@example.net>" },
		]);
		expect(await (await storage()).exec("SELECT label FROM message_labels")).toEqual([{ label: "sent" }]);
		expect(await (await storage()).exec("SELECT recipient, status FROM deliveries")).toEqual([{ recipient: "recipient@outside.test", status: "sent" }]);
		expect(await mailbox().alarmAt()).toBeNull();
		expect(await mailbox().cancelSend(queued!.id)).toBe(false);
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
	});

	it.each(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED"])("backs off %s and stops after eight attempts", async (code) => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		await f.control.setSendErrors(Array.from({ length: 8 }, () => code));
		let at = NOW;
		for (let attempt = 1; attempt <= 8; attempt++) {
			await f.control.setNow(at);
			await mailbox().drain();
			const db = await storage();
			if (attempt < 8) {
				at += Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);
				expect(await db.exec("SELECT attempts, send_at FROM outbox")).toEqual([{ attempts: attempt, send_at: at }]);
				expect(await mailbox().alarmAt()).toBe(at);
				expect(await db.exec("SELECT delivery_status FROM messages")).toEqual([{ delivery_status: "queued" }]);
			} else {
				expect(await db.exec("SELECT * FROM outbox")).toEqual([]);
				expect(await db.exec("SELECT delivery_status FROM messages")).toEqual([{ delivery_status: "failed" }]);
				expect(await mailbox().alarmAt()).toBeNull();
			}
		}
		expect((await f.control.state()).sends).toHaveLength(8);
	});

	it.each(["E_INVALID_EMAIL", "E_UNKNOWN"])("fails permanently on %s while letting the next message send", async (code) => {
		const first = await mailbox().enqueueSend(sendInput(ids.alice));
		const second = await mailbox().enqueueSend(sendInput(ids.alice, { subject: "Second" }));
		await f.control.setSendErrors([code]);
		await mailbox().drain();
		expect(await (await storage()).exec("SELECT id, delivery_status FROM messages ORDER BY rowid")).toEqual([
			{ id: first!.id, delivery_status: "failed" }, { id: second!.id, delivery_status: "sent" },
		]);
		expect((await f.control.state()).sends).toHaveLength(2);
		expect(await (await storage()).exec("SELECT * FROM outbox")).toEqual([]);
	});

	it("copies uploads before sending, sends from the permanent copy, and removes the upload", async () => {
		const ref = await upload();
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		await mailbox().drain();
		const blobs = await mailbox().getMessageBlobs(queued!.id);
		const key = blobs!.attachments[0]!.r2Key;
		expect(key).toBe(r2Keys.attachment(ids.alice, queued!.id, blobs!.attachments[0]!.id));
		expect(await (await f.env.MAIL.get(key))?.text()).toBe("%PDF");
		expect(await f.env.MAIL.head(ref.r2Key)).toBeNull();
		expect((await f.control.state()).sends).toMatchObject([{ attachments: [{ filename: ref.filename, type: ref.contentType, disposition: "attachment", content: "%PDF" }] }]);
	});

	it("keeps an upload another queued message still needs, then deletes it after both copies are kept", async () => {
		const ref = await upload();
		await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		const second = await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref], delayMs: 60_000 }));
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
		expect(await f.env.MAIL.head(ref.r2Key)).not.toBeNull();
		await f.control.setNow(NOW + 60_000);
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(2);
		expect((await mailbox().getMessage(second!.id))?.message.delivery?.status).toBe("sent");
		expect(await f.env.MAIL.head(ref.r2Key)).toBeNull();
		expect(await (await storage()).exec("SELECT * FROM trash")).toEqual([]);
	});

	it.each(["put", "get"] as const)("retries storage %s failures without losing permanent copies or sending early", async (operation) => {
		const ref = await upload();
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		await f.control.failNext(operation, r2Keys.mailbox(ids.alice));
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await (await storage()).exec("SELECT delivery_status, delivery_detail FROM messages")).toMatchObject([{ delivery_status: "queued", delivery_detail: expect.stringContaining("E_STORAGE") }]);
		if (operation === "get") await f.env.MAIL.delete(ref.r2Key); // A retry must use the copy already kept.
		await f.control.setNow(NOW + 30_000);
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(1);
		expect((await mailbox().getMessage(queued!.id))?.message.delivery?.status).toBe("sent");
	});

	it("fails a missing attachment instead of sending an incomplete message", async () => {
		const ref = await upload();
		await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		await f.env.MAIL.delete(ref.r2Key);
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await (await storage()).exec("SELECT delivery_status, delivery_detail FROM messages")).toMatchObject([{ delivery_status: "failed", delivery_detail: expect.stringContaining("E_ATTACHMENT_MISSING") }]);
		expect(await mailbox().alarmAt()).toBeNull();
	});

	it("keeps linked uploads without attaching them to the provider request", async () => {
		const ref = await upload();
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { links: [ref] }));
		await mailbox().drain();
		expect((await f.control.state()).sends[0]?.attachments).toBeUndefined();
		expect((await f.control.state()).sends[0]?.text).toContain(`https://magnus.test/f/${ids.alice}/`);
		const file = (await mailbox().getMessageBlobs(queued!.id))!.attachments[0]!;
		expect(file.link?.shared).toBe(true);
		expect(await f.env.MAIL.head(file.r2Key)).not.toBeNull();
		expect(await f.env.MAIL.head(ref.r2Key)).toBeNull();
	});

	it("delivers local-only sends without contacting the provider", async () => {
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { to: [{ address: "alice+receipts@example.com" }], localOnly: true, localRecipients: [{ address: "alice+receipts@example.com", labels: ["inbox", "receipts"] }] }));
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect((await mailbox().getMessage(queued!.id))?.message).toMatchObject({ isRead: false, labels: expect.arrayContaining(["inbox", "receipts", "sent"]) });
		expect(await (await storage()).exec("SELECT delivery_status FROM messages")).toEqual([{ delivery_status: "delivered" }]);
	});

	it("undo before the alarm removes the queued message but preserves uploads for the reopened draft", async () => {
		const ref = await upload();
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		expect(await mailbox().cancelSend(queued!.id)).toBe(true);
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await mailbox().getMessage(queued!.id)).toBeNull();
		expect(await f.env.MAIL.head(ref.r2Key)).not.toBeNull();
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
	});

	it.each(["put", "get"] as const)("honors undo during attachment %s and cleans copies made after cancellation", async (operation) => {
		const ref = await upload();
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		await f.control.afterIO({ operation, prefix: r2Keys.mailbox(ids.alice), mailboxId: ids.alice, cancelMessageId: queued!.id });
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await mailbox().getMessage(queued!.id)).toBeNull();
		expect(await f.env.MAIL.head(ref.r2Key)).not.toBeNull();
		expect((await f.env.MAIL.list({ prefix: r2Keys.mailbox(ids.alice) })).objects).toEqual([]);
	});

	it("fails a send interrupted after handoff instead of risking a duplicate after restart", async () => {
		await mailbox().enqueueSend(sendInput(ids.alice));
		await (await storage()).exec("UPDATE messages SET delivery_status = 'sending'");
		await f.restart();
		await mailbox().drain();
		expect((await f.control.state()).sends).toEqual([]);
		expect(await (await storage()).exec("SELECT delivery_status, delivery_detail FROM messages")).toMatchObject([{ delivery_status: "failed", delivery_detail: expect.stringContaining("Interrupted mid-send") }]);
		expect(await (await storage()).exec("SELECT * FROM outbox")).toEqual([]);
	});

	it("retries failed undo cleanup from durable trash on the next alarm", async () => {
		const queued = await mailbox().enqueueSend(sendInput(ids.alice));
		await f.control.failNext("delete", r2Keys.mailbox(ids.alice));
		await mailbox().cancelSend(queued!.id);
		expect(await (await storage()).exec("SELECT * FROM trash")).toEqual([{ r2_key: r2Keys.html(ids.alice, queued!.id) }]);
		expect(await mailbox().alarmAt()).not.toBeNull();
		await f.control.setNow(NOW + 60_000);
		await mailbox().drain();
		expect(await (await storage()).exec("SELECT * FROM trash")).toEqual([]);
		expect(await mailbox().alarmAt()).toBeNull();
	});

	it("persists failed post-send upload cleanup, retries it after restart, and never sends twice", async () => {
		const ref = await upload();
		await mailbox().enqueueSend(sendInput(ids.alice, { attachments: [ref] }));
		await f.control.failNext("delete", ref.r2Key);
		await mailbox().drain();
		expect(await (await storage()).exec("SELECT * FROM trash")).toEqual([{ r2_key: ref.r2Key }]);
		expect(await mailbox().alarmAt()).toBe(NOW + 60_000);
		expect((await f.control.state()).sends).toHaveLength(1);
		await f.restart();
		await f.control.setNow(NOW + 60_000);
		await mailbox().drain();
		expect(await f.env.MAIL.head(ref.r2Key)).toBeNull();
		expect(await (await storage()).exec("SELECT * FROM trash")).toEqual([]);
		expect((await f.control.state()).sends).toEqual([]);
	});
});
