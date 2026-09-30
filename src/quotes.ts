/**
 * The quoted history at the end of a reply repeats what the thread already shows, so it folds away behind a
 * "•••" like Gmail's. Only a quote that ends the message folds: answers written between quoted lines stay whole,
 * and so does a forward, whose original is the point. Callers fold only replies whose parent is in the thread.
 */

/** Forwards keep what they carry, even when the client quotes it like a reply (Outlook does). */
export const isForward = (subject: string) => /^\s*(fwd?|wg|tr|rv)\s*:/i.test(subject);

const FORWARDED = /forwarded message/i;

/**
 * "On Tue, Sep 29, 2026 at 2:15 PM Derped <me@derped.dev> wrote:", in any language: a short line ending in a colon,
 * with a date, an address, or the word for "wrote" (or "forwarded"), so a reply's own "Details below:" stays put.
 */
const isAttribution = (line: string) =>
	line.length < 300 && /:\s*$/.test(line) && /\d|@|wrote|schrieb|écrit|escribió|scritto|schreef|escreveu|skrev|napisał|forwarded/i.test(line);

/** How attributions start in the languages that wrap them onto a second line ("…<me@derped.dev>" / "wrote:"). */
const ATTRIBUTION_START = /^\s*(on|le|am|el|il|op|em|den|w dniu)\s/i;

/** Outlook's plain-text divider, above a From:/Sent: header and the original, unprefixed. */
const OUTLOOK_DIVIDER = /^\s*(-{3,}\s*original message\s*-{3,}|_{10,})\s*$/i;

/** Splits a plain-text body into what's new and the quote that ends it. `quote` is empty when nothing folds. */
export function splitQuote(text: string): { body: string; quote: string } {
	const lines = text.split(/\r?\n/);
	const blank = (i: number) => lines[i]!.trim() === "";
	const above = (i: number) => {
		let j = i - 1;
		while (j >= 0 && blank(j)) j--;
		return j;
	};
	const below = (i: number) => {
		let j = i + 1;
		while (j < lines.length && blank(j)) j++;
		return j;
	};

	let end = lines.length;
	while (end > 0 && blank(end - 1)) end--;
	// The run of "> " lines at the end, and the attribution over it.
	let from = end;
	while (from > 0 && (blank(from - 1) || lines[from - 1]!.startsWith(">"))) from--;
	while (from < end && blank(from)) from++;
	if (from < end) {
		const attribution = above(from);
		if (attribution >= 0 && isAttribution(lines[attribution]!)) {
			from = attribution;
			const start = from - 1;
			if (start >= 0 && ATTRIBUTION_START.test(lines[start]!) && !ATTRIBUTION_START.test(lines[from]!)) from = start;
		}
	} else {
		from = lines.findLastIndex((l, i) => OUTLOOK_DIVIDER.test(l) && /^\s*\*?from:/i.test(lines[below(i)] ?? ""));
		if (from === -1) return { body: text, quote: "" };
	}

	const body = lines.slice(0, from).join("\n").trimEnd();
	const quote = lines.slice(from, end).join("\n");
	if (!body.trim() || FORWARDED.test(quote.slice(0, 300))) return { body: text, quote: "" };
	return { body, quote };
}

/** How mail clients wrap what they quote. Outlook's marks the original's header, and the original follows it. */
const QUOTE = [
	".gmail_quote",
	".protonmail_quote",
	".yahoo_quoted",
	// Apple Mail, Thunderbird, Fastmail.
	"blockquote[type=cite]",
	"#divRplyFwdMsg",
	"#mail-editor-reference-message-container",
].join(", ");

const SHOWN = "img, video, svg";

/** Whether a range holds anything a reader would see. */
const hasContent = (range: Range) => range.toString().trim() !== "" || range.cloneContents().querySelector(SHOWN) !== null;

/** Spacing, like the empty line clients leave above a quote. */
const isBlank = (el: Element) => !el.textContent.trim() && !el.matches(SHOWN) && !el.querySelector(SHOWN);

/** The elements of an HTML reply that make up the quote ending it, attribution included; none when nothing folds. */
export function findQuote(doc: Document): Element[] {
	for (const found of doc.body.querySelectorAll(QUOTE)) {
		let start = found;
		let end = found;
		if (found.id === "divRplyFwdMsg") {
			// Outlook: the divider before the header, then everything after it.
			while (start.previousElementSibling?.matches("hr, #appendonsend")) start = start.previousElementSibling;
			while (end.nextElementSibling) end = end.nextElementSibling;
		} else {
			// Whatever wraps just the quote goes with it, then the attribution that Apple Mail and Thunderbird put before it.
			while (start.parentElement && start.parentElement !== doc.body && start.parentElement.textContent.trim() === start.textContent.trim()) {
				start = start.parentElement;
			}
			end = start;
			let el = start.previousElementSibling;
			while (el && isBlank(el)) el = el.previousElementSibling;
			if (el && isAttribution(el.textContent.trim())) start = el;
		}
		while (start.previousElementSibling && isBlank(start.previousElementSibling)) start = start.previousElementSibling;
		const parts = [start];
		for (let el = start; el !== end && el.nextElementSibling; ) parts.push((el = el.nextElementSibling));

		const after = doc.createRange();
		after.setStartAfter(parts.at(-1)!);
		after.setEnd(doc.body, doc.body.childNodes.length);
		if (hasContent(after)) continue;
		const before = doc.createRange();
		before.setStart(doc.body, 0);
		before.setEndBefore(parts[0]!);
		const text = parts.map((p) => p.textContent).join(" ");
		return hasContent(before) && !FORWARDED.test(text.slice(0, 300)) ? parts : [];
	}
	return [];
}
