import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { r2Keys } from "#shared";
import type { Draft, SavedDraft } from "#shared/drafts";
import { claimDraft, discardDraft, finishDraftSend, saveDraft } from "../worker/drafts";
import { fixture, type Fixture, type Mailboxes, NOW, sendInput } from "./runtime/fixture";

const DAY = 24 * 3600_000;

describe("shared draft files", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });
	const mailbox = () => f.env.MAILBOX.getByName(ids.alice);

	async function copies() {
		const file = { r2Key: r2Keys.draftFile(ids.alice, "alice", "file"), filename: "receipt.pdf", contentType: "application/pdf", size: 4 };
		await f.env.MAIL.put(file.r2Key, "%PDF");
		// Old enough for cleanup: retention must depend on references, not the upload's grace period.
		await f.env.DIRECTORY.prepare("INSERT INTO draft_files (r2_key, mailbox_id, user_id, created_at) VALUES (?1, ?2, 'alice', ?3)")
			.bind(file.r2Key, ids.alice, NOW - DAY - 1).run();
		const content: Draft = { mailboxId: ids.alice, from: "alice@example.com", to: [{ address: "recipient@outside.test" }], cc: [], bcc: [], subject: "Original", text: "Hello", attachments: [file] };
		async function save(subject: string) {
			const saved = await saveDraft(f.env.DIRECTORY, "alice", crypto.randomUUID(), { revision: 0, changeId: crypto.randomUUID(), content: { ...content, subject } }, NOW);
			if (!saved) throw new Error("Could not save fixture draft");
			return saved;
		}
		return { file, original: await save("Original"), copy: await save("Conflict copy") };
	}

	async function queue(draft: SavedDraft, mode: "attachments" | "links" = "attachments") {
		const id = `draft-${draft.id}`;
		const claim = await claimDraft(f.env.DIRECTORY, "alice", draft.id, draft.revision, id);
		if (!claim) throw new Error("Could not claim fixture draft");
		const queued = await mailbox().enqueueSend(sendInput(ids.alice, { id, subject: draft.content.subject, markdown: draft.content.text, [mode]: draft.content.attachments }));
		if (!queued) throw new Error("Could not queue fixture draft");
		await finishDraftSend(f.env.DIRECTORY, "alice", draft.id, queued);
		return queued;
	}

	it.each(["attachments", "links"] as const)("keeps a shared source after sending %s and reaps it only after both drafts are sent", async (mode) => {
		const { file, original, copy } = await copies();
		const first = await queue(original, mode);
		await mailbox().drain();
		expect(await (await f.env.MAIL.get(file.r2Key))?.text()).toBe("%PDF");
		await f.control.cleanDrafts();
		expect(await (await f.env.MAIL.get(file.r2Key))?.text()).toBe("%PDF");
		const second = await queue(copy, mode);
		await mailbox().drain();
		expect((await f.control.state()).sends).toHaveLength(2);
		for (const sent of [first, second]) {
			const detail = await mailbox().getMessage(sent.id);
			expect(detail?.message.delivery?.status).toBe("sent");
			const kept = detail?.blobs.attachments[0];
			if (!kept) throw new Error("Sent file was not retained");
			expect(kept.r2Key).toBe(r2Keys.attachment(ids.alice, sent.id, kept.id));
			expect(await (await f.env.MAIL.get(kept.r2Key))?.text()).toBe("%PDF");
		}
		await f.control.cleanDrafts();
		expect(await f.env.MAIL.head(file.r2Key)).toBeNull();
		expect(await f.env.DIRECTORY.prepare("SELECT r2_key FROM draft_files WHERE r2_key = ?1").bind(file.r2Key).first()).toBeNull();
	});

	it("keeps another draft's source when a failed send is permanently deleted", async () => {
		const { file, original, copy } = await copies();
		const queued = await queue(original);
		await f.control.failNext("get", file.r2Key, 8);
		let at = NOW;
		for (let attempt = 1; attempt <= 8; attempt++) {
			await f.control.setNow(at);
			await mailbox().drain();
			at += Math.min(30_000 * 2 ** (attempt - 1), 3_600_000);
		}
		expect((await mailbox().getMessage(queued.id))?.message.delivery?.status).toBe("failed");
		await mailbox().modifyThreads({ threadIds: [queued.threadId], add: ["trash"] });
		expect(await mailbox().deleteTrash({ threadId: queued.threadId })).toEqual({ blocked: false, deleted: 1 });
		await f.control.cleanDrafts();
		expect(await (await f.env.MAIL.get(file.r2Key))?.text()).toBe("%PDF");
		expect(await discardDraft(f.env.DIRECTORY, "alice", copy.id, copy.revision)).toBe(true);
		await f.control.cleanDrafts();
		expect(await f.env.MAIL.head(file.r2Key)).toBeNull();
	});

	it("retries a failed source cleanup after restart once the last draft is discarded", async () => {
		const { file, original, copy } = await copies();
		expect(await discardDraft(f.env.DIRECTORY, "alice", original.id, original.revision)).toBe(true);
		await f.control.cleanDrafts();
		expect(await f.env.MAIL.head(file.r2Key)).not.toBeNull();
		expect(await discardDraft(f.env.DIRECTORY, "alice", copy.id, copy.revision)).toBe(true);
		await f.control.failNext("delete", file.r2Key);
		await expect(async () => f.control.cleanDrafts()).rejects.toThrow("Injected delete failure");
		expect(await f.env.MAIL.head(file.r2Key)).not.toBeNull();
		expect(await f.env.DIRECTORY.prepare("SELECT deleting FROM draft_files WHERE r2_key = ?1").bind(file.r2Key).first()).toEqual({ deleting: 1 });
		await f.restart();
		await f.control.setNow(NOW);
		await f.control.cleanDrafts();
		expect(await f.env.MAIL.head(file.r2Key)).toBeNull();
		expect(await f.env.DIRECTORY.prepare("SELECT r2_key FROM draft_files WHERE r2_key = ?1").bind(file.r2Key).first()).toBeNull();
	});
});
