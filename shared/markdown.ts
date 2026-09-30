/**
 * Mail is written in markdown (the composer and signatures, src/markdown.ts) and goes out as both parts: HTML with the
 * formatting, and plain text that reads like it. Both are rendered here with the dialect the editor parses (GitHub's,
 * where a newline is a line break), and the HTML is spaced like the editor, so a message looks the way it was written.
 */

import { Marked, type Token } from "marked";
import { escapeHtml, FONT, type LinkedFile, linkBlockText, linkCards, type MessageBody, splitQuote } from "./links";

/**
 * The note someone wrote, as the message's two parts. Files sent as links go above the quote a reply ends with, where
 * Gmail would otherwise fold them out of sight. No HTML part for an empty note.
 */
export function noteBody(markdown: string, links: LinkedFile[] = []): MessageBody {
	const [body, quote] = splitQuote(markdown.trim());
	const linked = links.length > 0;
	const text = [plain(body), linked ? linkBlockText(links) : "", plain(quote)].filter(Boolean).join("\n\n");
	const html = [markup(body), linked ? linkCards(links) : "", markup(quote, !body && !linked)].join("");
	return html ? { text, html: `<div style="font-family:${FONT};font-size:14px;line-height:${LINE}px">${html}</div>` } : { text };
}

// Email HTML takes inline styles only. No text or background colours, so Magnus shows it in the theme's (ThreadView's HtmlBody).
const LINE = 20;
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const RULE = "#d4d4d8";
const HEADINGS = ["font-size:20px;line-height:28px", "font-size:16px;line-height:24px", "font-size:14px;line-height:20px"];

/**
 * Blocks sit a blank line apart, as in the editor. Email HTML can't say :first-child, so the first block in each
 * container is marked before it renders and gets no margin above.
 */
const firsts = new WeakSet<Token>();
function children(tokens: Token[]): Token[] {
	const first = tokens.find((t) => t.type !== "space");
	if (first) firsts.add(first);
	return tokens;
}
const gap = (token: Token) => (firsts.has(token) ? "margin:0" : `margin:${LINE}px 0 0`);

/** The editor keeps each run of extra blank lines as empty paragraphs: one per blank line past the first. */
const emptyLines = (raw: string) => Math.max(0, Math.floor(((raw.match(/\n/g)?.length ?? 0) - 2) / 2));

const isSafeUrl = (href: string) => /^(https?|mailto):/i.test(href);

const html = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		space: ({ raw }) => `<p style="margin:${LINE}px 0 0"><br></p>`.repeat(emptyLines(raw)),
		paragraph(token) {
			return `<p style="${gap(token)}">${this.parser.parseInline(token.tokens)}</p>\n`;
		},
		heading(token) {
			return `<h${token.depth} style="${gap(token)};${HEADINGS[Math.min(token.depth, 3) - 1] ?? ""};font-weight:600">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
		},
		// type=cite marks a quote for Apple Mail, Thunderbird, and Magnus's own folding (src/quotes.ts).
		blockquote(token) {
			return `<blockquote type="cite" style="${gap(token)};padding-left:12px;border-left:2px solid ${RULE}">${this.parser.parse(children(token.tokens))}</blockquote>\n`;
		},
		list(token) {
			const tag = token.ordered ? "ol" : "ul";
			const start = token.ordered && token.start !== "" && token.start !== 1 ? ` start="${token.start}"` : "";
			const items = token.items.map((item) => {
				children(item.tokens);
				return this.listitem(item);
			});
			return `<${tag}${start} style="${gap(token)};padding-left:24px">${items.join("")}</${tag}>\n`;
		},
		code: (token) => `<pre style="${gap(token)};font-family:${MONO};font-size:13px;white-space:pre-wrap">${escapeHtml(token.text)}</pre>\n`,
		hr: (token) => `<hr style="${gap(token)};border:0;border-top:1px solid ${RULE}">\n`,
		codespan: ({ text }) => `<code style="font-family:${MONO};font-size:13px">${escapeHtml(text)}</code>`,
		// Markdown that looks like HTML shows as written. The editor never writes any.
		html: ({ text }) => escapeHtml(text),
		link({ href, tokens }) {
			const text = this.parser.parseInline(tokens);
			return isSafeUrl(href) ? `<a href="${escapeHtml(href)}">${text}</a>` : text;
		},
		image: ({ href, text }) => (isSafeUrl(href) ? `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>` : escapeHtml(text)),
	},
});

/** `first` when nothing comes before it in the note. */
function markup(markdown: string, first = true): string {
	const tokens = html.lexer(markdown);
	return html.parser(first ? children(tokens) : tokens);
}

// Named ones Tiptap writes (it escapes &, <, and >), and numeric ones.
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
	s.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/gi, (entity, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
		if (name) return ENTITIES[name.toLowerCase()] ?? entity;
		const code = dec ? Number(dec) : Number.parseInt(hex ?? "", 16);
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
	});

/** Plain text the way Gmail writes it for rich mail: formatting dropped, links as "text <url>", lists and quotes kept. */
const text = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		space: ({ raw }) => "\n\n".repeat(emptyLines(raw)),
		// The editor can't keep the space in RFC 3676's "-- " signature line, so it's put back for clients that look for it.
		paragraph(token) {
			return `${this.parser.parseInline(token.tokens).replace(/^--(?=\n|$)/, "-- ")}\n\n`;
		},
		heading(token) {
			return `${this.parser.parseInline(token.tokens)}\n\n`;
		},
		blockquote(token) {
			return `${this.parser.parse(token.tokens).trimEnd().replace(/^/gm, "> ").replace(/^> $/gm, ">")}\n\n`;
		},
		list(token) {
			const start = token.ordered && token.start !== "" ? token.start : 1;
			const items = token.items.map((item, i) => {
				const marker = token.ordered ? `${start + i}. ` : "- ";
				return marker + this.parser.parse(item.tokens).trim().replaceAll("\n", `\n${" ".repeat(marker.length)}`);
			});
			return `${items.join("\n")}\n\n`;
		},
		code: ({ text }) => `${text}\n\n`,
		hr: () => "---\n\n",
		table: ({ raw }) => `${raw.trim()}\n\n`,
		html: ({ text }) => text,
		checkbox: ({ checked }) => (checked ? "[x] " : "[ ] "),
		strong({ tokens }) {
			return this.parser.parseInline(tokens);
		},
		em({ tokens }) {
			return this.parser.parseInline(tokens);
		},
		del({ tokens }) {
			return this.parser.parseInline(tokens);
		},
		codespan: ({ text }) => text,
		br: () => "\n",
		// One that shows its own address ("example.com", an email) needs nothing more.
		link({ href, tokens }) {
			const label = this.parser.parseInline(tokens);
			return withoutScheme(href) === withoutScheme(label) ? label : `${label} <${href}>`;
		},
		image: ({ href, text }) => (text ? `${text} <${href}>` : href),
		text(token) {
			return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : decodeEntities(token.text);
		},
	},
});

const withoutScheme = (url: string) => url.replace(/^(https?:\/\/|mailto:)/i, "");

const plain = (markdown: string) => (markdown ? text.parser(text.lexer(markdown)).trimEnd() : "");
