import { z } from "zod";
import { DraftSchema, SaveDraftSchema, type Draft, type DraftWrite, type SavedDraft } from "#shared/drafts";

const JournalEntry = z.object({
	id: z.uuid(), revision: z.number().int().nonnegative(), updatedAt: z.number(), content: DraftSchema,
	state: z.enum(["active", "sending"]), dirty: z.boolean(), request: SaveDraftSchema.optional(), removing: z.boolean(),
});
const Journal = z.array(JournalEntry);
type PendingDraft = z.infer<typeof JournalEntry>;
export type DraftStatus = "pending" | "saving" | "saved" | "error" | "conflict" | "discarding" | "sending";
export type DraftEntry = PendingDraft & { status: DraftStatus; error?: string };

interface DraftIO {
	read: () => string | null;
	write: (journal: string) => void;
	save: (id: string, write: DraftWrite, signal: AbortSignal) => Promise<SavedDraft>;
	discard: (id: string, revision: number, signal: AbortSignal) => Promise<void>;
	uuid: () => string;
	now: () => number;
	after: (delay: number, run: () => void) => () => void;
	classify: (error: unknown) => { message: string; conflict: boolean; retry: boolean };
	changed: (entries: DraftEntry[]) => void;
	synced: () => void;
	discarded: (id: string) => void;
}

/**
 * One account's journal and serial save queue. It outlives composers; every change is journaled before I/O.
 * Lost responses replay the same request, newer edits follow it, and unmount/sign-out abort only this session.
 */
export class DraftSync {
	private readonly drafts = new Map<string, DraftEntry>();
	private readonly timers = new Map<string, () => void>();
	private readonly tasks = new Map<string, Promise<void>>();
	private readonly finished = new Set<string>();
	private session: AbortController | undefined;
	private generation = 0;

	constructor(private readonly io: DraftIO) {
		const journal = io.read();
		if (journal) for (const entry of Journal.parse(JSON.parse(journal))) {
			this.drafts.set(entry.id, { ...entry, status: entry.state === "sending" ? "sending" : "pending" });
		}
	}

	start() {
		this.session = new AbortController();
		this.generation++;
		this.publish();
		for (const entry of this.drafts.values()) if (entry.state === "active") this.schedule(entry.id, 0);
	}

	stop() {
		this.generation++;
		this.session?.abort();
		this.session = undefined;
		for (const cancel of this.timers.values()) cancel();
		this.timers.clear();
		this.tasks.clear();
	}

	get(id: string) { return this.drafts.get(id); }

	adopt(saved: SavedDraft) {
		this.finished.delete(saved.id);
		const existing = this.get(saved.id);
		if (existing && (existing.dirty || existing.request || existing.removing)) return existing;
		const entry: DraftEntry = { ...saved, dirty: false, removing: false, status: saved.state === "sending" ? "sending" : "saved" };
		this.drafts.set(saved.id, entry);
		this.publish();
		return entry;
	}

	update(id: string, content: Draft) {
		if (this.finished.has(id)) return;
		content = DraftSchema.parse(content);
		const previous = this.get(id);
		if (previous?.state === "sending" || previous?.removing) return;
		if (previous && equal(previous.content, content)) return;
		const entry: DraftEntry = {
			id, content, revision: previous?.revision ?? 0, updatedAt: this.io.now(), state: "active", dirty: true,
			request: previous?.request, removing: false, status: previous?.status === "conflict" ? "conflict" : "pending",
			error: previous?.status === "conflict" ? previous.error : undefined,
		};
		this.drafts.set(id, entry);
		this.persist();
		if (entry.status !== "conflict") this.schedule(id, 500);
	}

	async flush(id: string) {
		this.cancelTimer(id);
		await this.run(id);
		const entry = this.get(id);
		if (!entry || entry.dirty || entry.request || entry.status === "error" || entry.status === "conflict") {
			throw new Error(entry?.error ?? "Draft has not been saved");
		}
		return entry;
	}

	async flushAll() {
		for (const entry of this.drafts.values()) if (entry.state === "active") {
			if (entry.removing) await this.discard(entry.id);
			else await this.flush(entry.id);
		}
	}

	async discard(id: string) {
		const entry = this.get(id);
		if (!entry) { this.finished.add(id); return; }
		if (entry.state === "sending") throw new Error("Check this send before discarding its draft");
		if (!entry.removing) await this.flush(id);
		const saved = this.get(id);
		if (!saved) return;
		saved.removing = true;
		saved.status = "discarding";
		this.persist();
		await this.run(id);
		const remaining = this.get(id);
		if (remaining) throw new Error(remaining.error ?? "Draft has not been discarded");
	}

	lock(id: string) {
		const entry = this.get(id);
		if (!entry) throw new Error("Draft has not been saved");
		entry.state = "sending";
		entry.status = "sending";
		this.persist();
	}

	sent(id: string) {
		this.finished.add(id);
		this.cancelTimer(id);
		this.drafts.delete(id);
		this.persist();
		this.io.synced();
	}

	/** A confirmed read can release an interrupted send that never reached the server's claim. */
	confirm(saved: SavedDraft) {
		const entry = this.get(saved.id);
		if (!entry || entry.dirty || entry.request) return;
		this.drafts.set(saved.id, { ...saved, dirty: false, removing: false, status: saved.state === "sending" ? "sending" : "saved" });
		this.persist();
	}

	copy(id: string) {
		const entry = this.get(id);
		if (!entry) throw new Error("Draft is no longer available");
		const nextId = this.io.uuid();
		this.update(nextId, entry.content);
		this.sent(id);
		return nextId;
	}

	private cancelTimer(id: string) { this.timers.get(id)?.(); this.timers.delete(id); }
	private schedule(id: string, delay: number) {
		this.cancelTimer(id);
		if (!this.session) return;
		this.timers.set(id, this.io.after(delay, () => { this.timers.delete(id); void this.run(id); }));
	}
	private publish() { this.io.changed([...this.drafts.values()].map((entry) => ({ ...entry }))); }
	private persist() {
		try {
			this.io.write(JSON.stringify([...this.drafts.values()].filter((e) => e.dirty || e.request || e.removing || e.state === "sending")));
		} catch (error) {
			for (const entry of this.drafts.values()) if (entry.dirty || entry.request) {
				entry.status = "error";
				entry.error = `Couldn't keep a recovery copy: ${this.io.classify(error).message}`;
			}
			this.publish();
			throw error;
		}
		this.publish();
	}

	private async run(id: string): Promise<void> {
		const current = this.tasks.get(id);
		if (current) { await current; if (this.get(id)?.dirty && this.get(id)?.status !== "error" && this.get(id)?.status !== "conflict") await this.run(id); return; }
		const signal = this.session?.signal;
		if (!signal) return;
		const generation = this.generation;
		const task = this.drain(id, signal, generation);
		this.tasks.set(id, task);
		await task;
		if (generation === this.generation) this.tasks.delete(id);
	}

	private async drain(id: string, signal: AbortSignal, generation: number) {
		while (generation === this.generation && !signal.aborted) {
			const entry = this.get(id);
			if (!entry || entry.status === "conflict" || entry.state === "sending" || (!entry.dirty && !entry.request && !entry.removing)) return;
			try {
				if (entry.removing) {
					await this.io.discard(id, entry.revision, signal);
					if (generation !== this.generation || signal.aborted) return;
					this.drafts.delete(id);
					this.finished.add(id);
					this.persist();
					this.io.discarded(id);
					this.io.synced();
					return;
				}
				entry.request ??= { revision: entry.revision, changeId: this.io.uuid(), content: entry.content };
				entry.status = "saving";
				entry.error = undefined;
				this.persist();
				const saved = await this.io.save(id, entry.request, signal);
				if (generation !== this.generation || signal.aborted) return;
				const latest = this.get(id);
				if (!latest) return;
				latest.revision = saved.revision;
				latest.updatedAt = saved.updatedAt;
				latest.request = undefined;
				latest.dirty = !equal(latest.content, saved.content);
				latest.status = latest.dirty ? "pending" : "saved";
				this.persist();
				this.io.synced();
			} catch (error) {
				if (generation !== this.generation || signal.aborted) return;
				const failure = this.io.classify(error);
				const latest = this.get(id);
				if (!latest) return;
				latest.status = failure.conflict ? "conflict" : "error";
				latest.error = failure.message;
				this.publish();
				if (failure.retry) this.schedule(id, 5000);
				return;
			}
		}
	}
}

const equal = (left: Draft, right: Draft) => JSON.stringify(left) === JSON.stringify(right);
