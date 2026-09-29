/**
 * Forwarding inline, the way Gmail does: the sender's note, then Gmail's divider and header, then the original.
 * The original's HTML is forwarded as is, so receipts and newsletters keep their layout, and text-only mail stays
 * text-only.
 */

import { type Address, formatAddress } from "./address";
import { escapeHtml, type MessageBody } from "./links";

/** The message being forwarded. */
export interface ForwardedMessage {
	from: Address;
	to: Address[];
	cc: Address[];
	subject: string;
	date: number;
	text: string | null;
	/** Its HTML document, if it had one. */
	html: string | null;
}

// Gmail's wording, which people and forward parsers already recognise.
const DIVIDER = "---------- Forwarded message ---------";

/** What goes below the note: the divider and header, then the original. `timeZone` sets the Date line's clock. */
export function forwardedPart(m: ForwardedMessage, timeZone?: string): MessageBody {
	const list = (addresses: Address[]) => addresses.map(formatAddress).join(", ");
	const lines = [
		`From: ${formatAddress(m.from)}`,
		`Date: ${formatDate(m.date, timeZone)}`,
		`Subject: ${m.subject}`,
		`To: ${list(m.to)}`,
		...(m.cc.length ? [`Cc: ${list(m.cc)}`] : []),
	];
	const text = `${[DIVIDER, ...lines].join("\n")}\n\n${m.text ?? ""}`.trimEnd();
	if (!m.html) return { text };
	return { text, html: insertAtTop(m.html, `<div>${[DIVIDER, ...lines].map(escapeHtml).join("<br>")}</div><br>`) };
}

/** The note with the forwarded part below it. There's an HTML part if either has one. */
export function withForward(note: MessageBody, part: MessageBody): MessageBody {
	const text = [note.text.trim(), part.text].filter(Boolean).join("\n\n");
	if (!note.html && !part.html) return { text };
	const noteHtml = note.html ?? (note.text.trim() ? textHtml(note.text.trim()) : "");
	return { text, html: insertAtTop(part.html ?? textHtml(part.text), noteHtml && `${noteHtml}<br>`) };
}

const textHtml = (text: string) => `<div>${escapeHtml(text).replaceAll("\n", "<br>")}</div>`;

/** At the top of the document's body, so its <head> styles still apply; at the start when it has no <body>. */
function insertAtTop(doc: string, html: string): string {
	const body = /<body\b[^>]*>/i.exec(doc);
	if (!body) return html + doc;
	const at = body.index + body[0].length;
	return doc.slice(0, at) + html + doc.slice(at);
}

/** "Mon, Sep 29, 2026, 10:15 AM GMT+2". UTC when the time zone is missing or unknown. */
function formatDate(at: number, timeZone = "UTC"): string {
	const options: Intl.DateTimeFormatOptions = {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZoneName: "short",
	};
	try {
		return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at);
	} catch {
		return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at);
	}
}
