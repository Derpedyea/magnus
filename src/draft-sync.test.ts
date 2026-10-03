import { describe, expect, it, vi } from "vitest";
import type { Draft, DraftWrite, SavedDraft } from "#shared/drafts";
import { DraftSync } from "./draft-sync";

const draft: Draft = { mailboxId: "mbx", from: "me@example.com", to: [], cc: [], bcc: [], subject: "Saturday", text: "See you then", attachments: [] };
const id = "00000000-0000-4000-8000-000000000001";
class Conflict extends Error {}

function deferred<T>() {
	let resolve: (value: T) => void = () => { throw new Error("Promise was not initialized"); };
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function harness(initialJournal: string | null = null) {
	let journal = initialJournal;
	let serial = 10;
	const server = new Map<string, SavedDraft>();
	const timers = new Map<number, () => void>();
	const save = vi.fn(async (key: string, write: DraftWrite, _signal: AbortSignal): Promise<SavedDraft> => {
		const previous = server.get(key);
		if (previous?.changeId === write.changeId) return previous;
		if ((previous?.revision ?? 0) !== write.revision) throw new Conflict("Changed on another device");
		const saved: SavedDraft = { id: key, content: write.content, revision: write.revision + 1, changeId: write.changeId, updatedAt: 1000, state: "active" };
		server.set(key, saved);
		return saved;
	});
	const discard = vi.fn(async (key: string, _revision: number, _signal: AbortSignal) => { server.delete(key); });
	const write = vi.fn((value: string) => { journal = value; });
	const options = {
		read: () => journal, write, save, discard,
		uuid: () => `00000000-0000-4000-8000-${String(serial++).padStart(12, "0")}`,
		now: () => 1000,
		after: (_delay: number, callback: () => void) => { const timer = serial++; timers.set(timer, callback); return () => { timers.delete(timer); }; },
		classify: (error: unknown) => ({ message: error instanceof Error ? error.message : "Failed", conflict: error instanceof Conflict, retry: !(error instanceof Conflict) }),
		changed: vi.fn(), synced: vi.fn(), discarded: vi.fn(),
	};
	const sync = new DraftSync(options);
	sync.start();
	return { sync, server, save, discard, write, timers, options, journal: () => journal };
}

describe("account draft queue", () => {
	it("journals edits synchronously, then saves and clears the recovery copy after acknowledgement", async () => {
		const h = harness();
		h.sync.update(id, draft);
		expect(h.journal()).toContain("Saturday");
		expect(h.save).not.toHaveBeenCalled();
		await h.sync.flush(id);
		expect(h.server.get(id)?.content).toEqual(draft);
		expect(h.sync.get(id)?.status).toBe("saved");
		expect(h.journal()).toBe("[]");
	});

	it("coalesces edits before a save starts", async () => {
		const h = harness();
		h.sync.update(id, draft);
		h.sync.update(id, { ...draft, subject: "Latest" });
		await h.sync.flush(id);
		expect(h.save).toHaveBeenCalledTimes(1);
		expect(h.server.get(id)?.content.subject).toBe("Latest");
	});

	it("serializes newer edits behind an in-flight save", async () => {
		const h = harness();
		const first = deferred<SavedDraft>();
		h.save.mockImplementationOnce(() => first.promise);
		h.sync.update(id, draft);
		const flushing = h.sync.flush(id);
		const request = h.save.mock.calls[0]?.[1];
		if (!request) throw new Error("Save did not start");
		h.sync.update(id, { ...draft, text: "Newer edit" });
		const saved: SavedDraft = { id, content: draft, revision: 1, changeId: request.changeId, updatedAt: 1000, state: "active" };
		h.server.set(id, saved);
		first.resolve(saved);
		await flushing;
		expect(h.save).toHaveBeenCalledTimes(2);
		expect(h.save.mock.calls[1]?.[1].revision).toBe(1);
		expect(h.server.get(id)?.content.text).toBe("Newer edit");
		expect(h.sync.get(id)?.status).toBe("saved");
	});

	it("replays exactly the same write after an acknowledgement is lost, including after a crash", async () => {
		const h = harness();
		const commit = h.save.getMockImplementation();
		if (!commit) throw new Error("Missing I/O");
		h.save.mockImplementationOnce(async (...args) => { await commit(...args); throw new Error("Response lost"); });
		h.sync.update(id, draft);
		await expect(h.sync.flush(id)).rejects.toThrow("Response lost");
		const first = h.save.mock.calls[0]?.[1];
		h.sync.stop();
		const recovered = new DraftSync(h.options);
		recovered.start();
		await recovered.flush(id);
		expect(h.save.mock.calls[1]?.[1]).toEqual(first);
		expect(h.server.get(id)?.revision).toBe(1);
		expect(recovered.get(id)?.status).toBe("saved");
	});

	it("shows failures as unsaved and schedules a retry while retaining the journal", async () => {
		const h = harness();
		h.save.mockRejectedValueOnce(new Error("Offline"));
		h.sync.update(id, draft);
		await expect(h.sync.flush(id)).rejects.toThrow("Offline");
		expect(h.sync.get(id)?.status).toBe("error");
		expect(h.journal()).toContain("Saturday");
		expect(h.timers.size).toBe(1);
		await h.sync.flush(id);
		expect(h.sync.get(id)?.status).toBe("saved");
	});

	it("keeps both devices' versions on a conflict and saves local edits under a new id", async () => {
		const h = harness();
		h.server.set(id, { id, content: { ...draft, subject: "Other device" }, revision: 1, changeId: h.options.uuid(), updatedAt: 1000, state: "active" });
		h.sync.update(id, draft);
		await expect(h.sync.flush(id)).rejects.toThrow("Changed on another device");
		expect(h.sync.get(id)?.status).toBe("conflict");
		expect(h.timers.size).toBe(0);
		const copy = h.sync.copy(id);
		await h.sync.flush(copy);
		expect(h.server.get(id)?.content.subject).toBe("Other device");
		expect(h.server.get(copy)?.content.subject).toBe("Saturday");
	});

	it("discards only after the current save completes and cannot be revived by unmount cleanup", async () => {
		const h = harness();
		h.sync.update(id, draft);
		await h.sync.discard(id);
		expect(h.discard.mock.calls[0]?.[1]).toBe(1);
		h.sync.update(id, draft);
		expect(h.sync.get(id)).toBeUndefined();
		expect(h.server.has(id)).toBe(false);
		expect(h.journal()).toBe("[]");
	});

	it("retries a failed discard after restart before allowing an account flush to finish", async () => {
		const h = harness();
		h.sync.update(id, draft);
		h.discard.mockRejectedValueOnce(new Error("Delete failed"));
		await expect(h.sync.discard(id)).rejects.toThrow("Delete failed");
		expect(h.journal()).toContain('"removing":true');
		h.sync.stop();
		const recovered = new DraftSync(h.options);
		recovered.start();
		await recovered.flushAll();
		expect(h.discard).toHaveBeenCalledTimes(2);
		expect(recovered.get(id)).toBeUndefined();
		expect(h.journal()).toBe("[]");
		expect(h.options.discarded).toHaveBeenCalledWith(id);
	});

	it("aborts on session end and ignores late completions", async () => {
		const h = harness();
		const response = deferred<SavedDraft>();
		h.save.mockImplementationOnce(() => response.promise);
		h.sync.update(id, draft);
		const flushing = h.sync.flush(id);
		const call = h.save.mock.calls[0];
		if (!call) throw new Error("Save did not start");
		h.sync.stop();
		expect(call[2].aborted).toBe(true);
		response.resolve({ id, content: draft, revision: 1, changeId: call[1].changeId, updatedAt: 1000, state: "active" });
		await expect(flushing).rejects.toThrow();
		expect(h.sync.get(id)?.revision).toBe(0);
		expect(h.journal()).toContain("Saturday");
	});

	it("keeps an interrupted send frozen under the same id on restart", async () => {
		const h = harness();
		h.sync.update(id, draft);
		await h.sync.flush(id);
		h.sync.lock(id);
		h.sync.stop();
		const recovered = new DraftSync(h.options);
		recovered.start();
		recovered.update(id, { ...draft, text: "Changed" });
		await recovered.flush(id);
		expect(recovered.get(id)?.state).toBe("sending");
		expect(recovered.get(id)?.content).toEqual(draft);
		expect(h.save).toHaveBeenCalledTimes(1);
	});

	it("consumes a sent draft before late editor callbacks arrive", async () => {
		const h = harness();
		h.sync.update(id, draft);
		await h.sync.flush(id);
		h.sync.sent(id);
		h.sync.update(id, draft);
		expect(h.sync.get(id)).toBeUndefined();
		expect(h.journal()).toBe("[]");
	});

	it("fails closed when recovery storage is corrupt or unavailable", async () => {
		const h = harness();
		h.write.mockImplementationOnce(() => { throw new Error("Storage full"); });
		expect(() => h.sync.update(id, draft)).toThrow("Storage full");
		expect(h.sync.get(id)?.status).toBe("error");
		expect(h.save).not.toHaveBeenCalled();
		expect(() => harness("broken JSON")).toThrow();
	});

	it("retains partial recipients, reply context, and attachments through recovery", async () => {
		const h = harness();
		const content: Draft = { ...draft, to: [{ address: "not finished" }], recipientInputs: { to: "unfinished input", cc: "", bcc: "" }, cc: [{ address: "cc@example.com" }], bcc: [{ address: "secret@example.com" }], replyToMessageId: "message", attachments: [{ r2Key: "m/mbx/draft-files/user/file", filename: "notes.txt", contentType: "text/plain", size: 3 }] };
		h.sync.update(id, content);
		h.sync.stop();
		const recovered = new DraftSync(h.options);
		recovered.start();
		await recovered.flush(id);
		expect(h.server.get(id)?.content).toEqual(content);
	});
});
