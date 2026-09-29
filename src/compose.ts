import type { Address } from "#shared";
import { createStore } from "@tanstack/react-store";
import type { Draft } from "./components/Composer";

/**
 * The open composer. It floats above whatever route is showing, so any view can start a draft
 * (Compose, Reply, Undo send) without threading callbacks through the router.
 */
export const compose = createStore<Draft | null>(null);

export const openDraft = (draft: Draft) => compose.setState(() => draft);
export const closeDraft = () => compose.setState(() => null);

/** What a reply starts with: the message it answers, quoted. The signature goes above it. */
export function quote(m: { date: number; from: Address; text: string | null }): string {
	const quoted = (m.text ?? "")
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return `\n\nOn ${new Date(m.date).toLocaleString()}, ${m.from.name || m.from.address} wrote:\n${quoted}`;
}

const QUOTE = /\n\nOn .+ wrote:\n>/;

// "-- " on its own line is the RFC 3676 signature delimiter, which mail clients recognise.
const block = (signature: string | null) => (signature ? `\n\n-- \n${signature}` : "");

/**
 * Swaps `previous`'s signature for `next`'s, so changing From changes it. With none yet, `next`'s goes above
 * the quote, or at the end. One edited or removed by hand is left alone.
 */
export function withSignature(text: string, previous: string | null, next: string | null): string {
	if (previous) {
		const at = signatureAt(text, previous);
		return at === -1 ? text : text.slice(0, at) + block(next) + text.slice(at + block(previous).length);
	}
	const at = text.search(QUOTE);
	return at === -1 ? text + block(next) : text.slice(0, at) + block(next) + text.slice(at);
}

/** Where the signature sits untouched: last, or right above the quote. -1 once it's been edited. */
function signatureAt(text: string, signature: string): number {
	const at = text.indexOf(block(signature));
	const after = text.slice(at + block(signature).length);
	return at !== -1 && (after === "" || after.search(QUOTE) === 0) ? at : -1;
}
