import { type Address, escapeMarkdown } from "#shared";
import { createStore } from "@tanstack/react-store";
import type { Draft } from "./components/Composer";

/**
 * The open composer. It floats above whatever route is showing, so any view can start a draft
 * (Compose, Reply, Undo send) without threading callbacks through the router.
 */
export const compose = createStore<Draft | null>(null);

export const openDraft = (draft: Draft) => compose.setState(() => draft);
export const closeDraft = () => compose.setState(() => null);

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
