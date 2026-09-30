/**
 * The markdown the app writes mail and signatures in, and the document the editor (components/MarkdownEditor.tsx)
 * shows for it. The Worker renders the same dialect into the message's HTML and plain text (shared/markdown.ts), so
 * a message goes out looking the way it did while you wrote it.
 */

import type { JSONContent } from "@tiptap/core";
import { Paragraph } from "@tiptap/extension-paragraph";
import { MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { find } from "linkifyjs";

/**
 * A line of text that starts like a list, heading, or rule ("- milk", "1. ", "--" under a line) would turn into one
 * once sent. Escaping its first character keeps it the text it was in the editor. Tiptap already escapes `*`, `_`,
 * and backticks wherever they are.
 */
const LiteralParagraph = Paragraph.extend({
	renderMarkdown: (node, h, ctx) =>
		(Paragraph.config.renderMarkdown?.(node, h, ctx) ?? "").replace(/^([ \t]*)([-+=#]|\d{1,9}(?=[.)]))/gm, (_, indent: string, lead: string) =>
			/\d/.test(lead) ? `${indent}${lead}\\` : `${indent}\\${lead}`,
		),
});

/** What mail can hold: markdown's own formatting, minus underline, which it can't write. */
export const markdownExtensions = [
	StarterKit.configure({
		paragraph: false,
		underline: false,
		heading: { levels: [1, 2, 3] },
		link: { openOnClick: false, defaultProtocol: "https" },
	}),
	LiteralParagraph,
];

// A newline is a line break, as in plain-text mail. (This sets it on marked's global instance, which nothing else uses.)
const manager = new MarkdownManager({ markedOptions: { gfm: true, breaks: true }, extensions: markdownExtensions });

/** The editor's document for `markdown`. Blank lines before a signature or quote become an empty line to write on. */
export const parseMarkdown = (markdown: string) => manager.parse(markdown);

export const serializeMarkdown = (doc: JSONContent) => manager.serialize(linkBare(doc)).trimEnd();

/**
 * Links addresses and URLs the way the editor's autolink does. It waits for a space after one, and Tiptap escapes
 * markdown characters in plain text, which would break one written last in a message or signature ("first\_last@").
 */
function linkBare(node: JSONContent): JSONContent {
	if (!node.content || node.type === "codeBlock") return node;
	return { ...node, content: node.content.flatMap((child) => (child.type === "text" ? linkText(child) : [linkBare(child)])) };
}

function linkText(node: JSONContent): JSONContent[] {
	const text = node.text ?? "";
	if (node.marks?.some((m) => m.type === "link" || m.type === "code")) return [node];
	const found = find(text, { defaultProtocol: "https" }).filter((l) => l.isLink);
	if (found.length === 0) return [node];
	const parts: JSONContent[] = [];
	let at = 0;
	for (const link of found) {
		if (link.start > at) parts.push({ ...node, text: text.slice(at, link.start) });
		parts.push({ ...node, text: link.value, marks: [...(node.marks ?? []), { type: "link", attrs: { href: link.href } }] });
		at = link.end;
	}
	if (at < text.length) parts.push({ ...node, text: text.slice(at) });
	return parts;
}

/** `markdown` as the editor writes it back, so text from elsewhere can be compared with what it holds. */
export const normalizeMarkdown = (markdown: string) => serializeMarkdown(parseMarkdown(markdown));
