import type { Counts, ThreadSummary } from "./types";

/**
 * A view can span every mailbox the user belongs to, narrowed to some of their addresses.
 * The web API fans one request out to each Mailbox DO and merges the answers with these helpers.
 */
export interface MailboxQuery {
	mailboxId: string;
	/** Omitted = the whole mailbox; empty = none of the selected addresses route here. */
	addresses?: string[];
}

/** Selected addresses → one query per mailbox. No selection means everything, unfiltered. */
export function planScope(mailboxes: { id: string; addresses: string[] }[], selected: string[]): MailboxQuery[] {
	if (selected.length === 0) return mailboxes.map((m) => ({ mailboxId: m.id }));
	const wanted = new Set(selected);
	return mailboxes.map((m) => ({ mailboxId: m.id, addresses: m.addresses.filter((a) => wanted.has(a)) }));
}

export function canMatch(q: MailboxQuery): boolean {
	return q.addresses === undefined || q.addresses.length > 0;
}

/** Newest first, the same order a single mailbox lists in. */
export function mergeByRecency<T extends ThreadSummary>(lists: T[][], limit: number): T[] {
	return lists
		.flat()
		.sort((a, b) => b.lastMessageAt - a.lastMessageAt)
		.slice(0, limit);
}

/** Search ranks aren't comparable across mailboxes' indexes, so take turns: every list's best hit, then second-best, … */
export function interleave<T>(lists: T[][], limit: number): T[] {
	const out: T[] = [];
	for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
		for (const list of lists) if (i < list.length) out.push(list[i]!);
	}
	return out.slice(0, limit);
}

/** Sums per-mailbox counts. Each mailbox has its own threads, so the totals match what the merged list shows. */
export function mergeCounts(parts: Counts[]): Counts {
	const labels = new Map<string, { label: string; threads: number; unread: number }>();
	const addresses = new Map<string, { address: string; unread: number }>();
	for (const part of parts) {
		for (const l of part.labels) {
			const acc = labels.get(l.label) ?? { label: l.label, threads: 0, unread: 0 };
			labels.set(l.label, { ...acc, threads: acc.threads + l.threads, unread: acc.unread + l.unread });
		}
		for (const a of part.addresses) {
			const acc = addresses.get(a.address) ?? { address: a.address, unread: 0 };
			addresses.set(a.address, { ...acc, unread: acc.unread + a.unread });
		}
	}
	return { labels: [...labels.values()], addresses: [...addresses.values()] };
}
