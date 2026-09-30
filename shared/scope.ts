import type { Counts, ListCursor, ThreadSummary } from "./types";

/**
 * A view can span every mailbox the user belongs to, narrowed to some of their addresses.
 * The web API fans one request out to each Mailbox DO and merges the answers with these helpers.
 */
export interface MailboxQuery {
	mailboxId: string;
	/** Omitted = the whole mailbox; empty = none of the selected addresses route here. */
	addresses?: string[];
}

/** The selected addresses as `?in=a@x.com,b@y.com`, in the app's URLs and API calls. None selected (every address) leaves it out. */
export const parseScope = (param: string | undefined) => param?.split(",").filter(Boolean) ?? [];
export const formatScope = (scope: string[]) => (scope.length ? scope.join(",") : undefined);

/** Selected addresses → one query per mailbox. No selection means everything, unfiltered. */
export function planScope(mailboxes: { id: string; addresses: string[] }[], selected: string[]): MailboxQuery[] {
	if (selected.length === 0) return mailboxes.map((m) => ({ mailboxId: m.id }));
	const wanted = new Set(selected);
	return mailboxes.map((m) => ({ mailboxId: m.id, addresses: m.addresses.filter((a) => wanted.has(a)) }));
}

export function canMatch(q: MailboxQuery): boolean {
	return q.addresses === undefined || q.addresses.length > 0;
}

/** The order every mailbox lists in (see ListCursor), so one cursor means the same place in each. */
const listOrder = (a: ThreadSummary, b: ThreadSummary) => b.lastMessageAt - a.lastMessageAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Merges each mailbox's page into one. Ask every mailbox for `size + 1` threads: anything past the
 * first `size` means there's more, and `next` resumes every mailbox after the last thread shown.
 */
export function mergePage<T extends ThreadSummary>(lists: T[][], size: number): { threads: T[]; next: string | null } {
	const all = lists.flat().sort(listOrder);
	const threads = all.slice(0, size);
	const last = threads.at(-1);
	return { threads, next: all.length > size && last ? `${last.lastMessageAt}.${last.id}` : null };
}

/** Reads a `next` from mergePage. Missing or malformed means the first page. Mail dated before 1970 has negative times. */
export function parseCursor(value: string | undefined): ListCursor | undefined {
	const [, at, id] = value?.match(/^(-?\d+)\.(\w+)$/) ?? [];
	return at && id ? { at: Number(at), id } : undefined;
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
