import type { Address } from "./address";

// Recipient suggestions. Each Mailbox DO remembers who it has written to and heard from; the API merges every
// mailbox the user reads, and the composer matches what's typed against the result.

/** One mailbox's record of an address. */
export interface Contact {
	address: string;
	/** The newest display name seen with it. */
	name: string | null;
	/** Messages this mailbox has sent to it. */
	sent: number;
	/** The newest message to or from it. */
	lastAt: number;
}

// Nobody reads these, so they'd only crowd out people.
const AUTOMATED = /^(no-?reply|do-?not-?reply|mailer-daemon|bounces?)\b/i;

/** One list across mailboxes, best first: people you've written to, then everyone else, newest first within each. */
export function mergeContacts(lists: Contact[][], limit: number): Address[] {
	const merged = new Map<string, Contact>();
	for (const c of lists.flat()) {
		if (AUTOMATED.test(c.address)) continue;
		const seen = merged.get(c.address);
		if (!seen) {
			merged.set(c.address, c);
			continue;
		}
		const [newer, older] = c.lastAt > seen.lastAt ? [c, seen] : [seen, c];
		merged.set(c.address, { address: c.address, name: newer.name ?? older.name, sent: seen.sent + c.sent, lastAt: newer.lastAt });
	}
	return [...merged.values()]
		.sort((a, b) => Number(b.sent > 0) - Number(a.sent > 0) || b.lastAt - a.lastAt)
		.slice(0, limit)
		.map((c) => (c.name ? { address: c.address, name: c.name } : { address: c.address }));
}

/**
 * Contacts matching what's typed, in the order given. Every typed word has to start a word of the name or the
 * address: "jo sm" finds John Smith, and "smith@ex" finds john.smith@example.com. `exclude` holds lowercase
 * addresses already added.
 */
export function matchContacts(contacts: Address[], typed: string, exclude: ReadonlySet<string>, limit: number): Address[] {
	const terms = typed.toLowerCase().split(/[\s,;<>"]+/).filter(Boolean);
	if (terms.length === 0) return [];
	const matches: Address[] = [];
	for (const c of contacts) {
		if (matches.length === limit) break;
		if (exclude.has(c.address)) continue;
		const words = [...wordStarts(c.name?.toLowerCase() ?? ""), ...wordStarts(c.address)];
		if (terms.every((t) => words.some((w) => w.startsWith(t)))) matches.push(c);
	}
	return matches;
}

/** "john.smith@example.com" → itself, "smith@example.com", "example.com", "com". */
const wordStarts = (text: string) => [text, ...Array.from(text.matchAll(/[\s@._+-]+/g), (m) => text.slice(m.index + m[0].length))];
