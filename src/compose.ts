import { type Address, escapeMarkdown, type MessageDetail } from "#shared";
import { createStore } from "@tanstack/react-store";
import type { Draft, SavedDraft } from "#shared/drafts";
import type { Identity } from "./api";

/**
 * The open composer. It floats above whatever route is showing, so any view can start a draft
 * (Compose, Reply, Undo send) without threading callbacks through the router. Each opening has its own `id`, so
 * the composer starts over for it rather than keeping what was typed into the one before. `draftId` follows its
 * persisted content across openings; Undo starts a new draft because sending consumed the old id.
 */
export const compose = createStore<{ id: number; draftId: string; draft: Draft; restored: boolean; saved?: SavedDraft } | null>(null);

let opened = 0;
export const openDraft = (draft: Draft, restored = false, saved?: SavedDraft) => compose.setState(() => ({ id: ++opened, draftId: saved?.id ?? crypto.randomUUID(), draft, restored, saved }));

/** Recovery/conflict copies already have an id in this account's local journal. */
export const openLocalDraft = (draftId: string, draft: Draft) => compose.setState(() => ({ id: ++opened, draftId, draft, restored: true }));
/** With `id`, only if that opening is still the open one: a send that finishes after you've opened another draft leaves it be. */
export const closeDraft = (id?: number) => compose.setState((open) => (id === undefined || open?.id === id ? null : open));

/**
 * What a reply starts with: the message it answers, quoted. The signature goes above it. The message is plain text,
 * so it's escaped to stay as it was received rather than read as markdown.
 */
export function quote(m: { date: number; from: Address; text: string | null }): string {
	const quoted = escapeMarkdown(m.text ?? "")
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return `\n\nOn ${new Date(m.date).toLocaleString()}, ${escapeMarkdown(m.from.name || m.from.address)} wrote:\n${quoted}`;
}

// The attribution, then the quote: on the next line as quote() writes it, after a blank one as the editor does.
const QUOTE = /\n\nOn .+ wrote:\n\n?>/;

/**
 * Swaps `previous`'s signature for `next`'s, so changing From changes it. With none yet, `next`'s goes above
 * the quote, or at the end. One edited or removed by hand is left alone. Text that's been through the editor needs
 * its `normalize` (src/markdown.ts), which writes the signature the way the editor would; the composer passes it,
 * since that module comes with the editor.
 */
export function withSignature(markdown: string, previous: string | null, next: string | null, normalize = (md: string) => md): string {
	// "-- " on its own line is the RFC 3676 signature delimiter, which mail clients recognise.
	const block = (signature: string | null) => (signature ? `\n\n${normalize(`-- \n${signature}`)}` : "");
	const text = normalize(markdown);
	if (previous) {
		const at = text.indexOf(block(previous));
		const after = text.slice(at + block(previous).length);
		// Only where it sits untouched: last, or right above the quote.
		const untouched = at !== -1 && (after === "" || after.search(QUOTE) === 0);
		return untouched ? text.slice(0, at) + block(next) + after : text;
	}
	const at = text.search(QUOTE);
	return at === -1 ? text + block(next) : text.slice(0, at) + block(next) + text.slice(at);
}

export interface AnswerContext {
	mailboxId: string;
	identities: Identity[];
	/** The thread's own addresses, which catch mail that reached us via Bcc or a list. */
	delivered: string[];
	outgoing: boolean;
	inView: (address: string) => boolean;
}

/**
 * Whether a message reads as sent: replies go to whom it was sent to. Mail one of our addresses sent another reads as
 * received when only the recipient is in view. Sent mail imported from an address that isn't ours is always sent.
 * `ours` is every address of the mailbox, those that can only receive too.
 */
export function isOutgoing(m: Pick<MessageDetail, "direction" | "from">, ours: string[], inView: (address: string) => boolean): boolean {
	if (m.direction !== "out") return false;
	const from = m.from.address.toLowerCase();
	return inView(from) || !ours.some((a) => a.toLowerCase() === from);
}

/**
 * Who a reply goes to. Received mail answers its sender, or where it asks replies to go. Sent mail answers whom it was
 * sent to: its To, else its Cc, else its Bcc, kept in Bcc so they stay hidden from each other as they were.
 */
export function replyRecipients(m: Pick<MessageDetail, "from" | "replyTo" | "to" | "cc" | "bcc">, outgoing: boolean): { to: Address[]; bcc: Address[] } {
	if (!outgoing) return { to: m.replyTo.length ? m.replyTo : [m.from], bcc: [] };
	if (m.to.length) return { to: m.to, bcc: [] };
	return m.cc.length ? { to: m.cc, bcc: [] } : { to: [], bcc: m.bcc };
}

/** Which of our addresses answers or forwards a message: the one being viewed when it reached several of ours. */
export function answerFrom(m: Pick<MessageDetail, "from" | "to" | "cc">, ctx: AnswerContext): string {
	const ours = new Set(ctx.identities.map((i) => i.address.toLowerCase()));
	// Sent mail imported from another provider can be from an address this one can't send as.
	if (ctx.outgoing && ours.has(m.from.address.toLowerCase())) return m.from.address.toLowerCase();
	const recipients = [...m.to, ...m.cc].filter((a) => ours.has(a.address.toLowerCase()));
	const from =
		recipients.find((a) => ctx.inView(a.address))?.address ??
		recipients[0]?.address ??
		ctx.delivered.find((a) => ours.has(a)) ??
		ctx.identities[0]?.address ??
		"";
	return from.toLowerCase();
}
