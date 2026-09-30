/**
 * Plain text inside markdown (shared/markdown.ts): the message a reply quotes, and signatures saved before they were
 * markdown. Escaped, so it shows as written instead of turning into formatting.
 */

// URLs as far as GitHub's markdown takes them (to whitespace or "<"), and addresses. Markdown links these as they are,
// and a backslash inside one, or right after it, would end up in the link.
const LINKS = /(?:https?:\/\/|www\.)[^\s<]*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

export function escapeMarkdown(text: string): string {
	let out = "";
	let at = 0;
	for (const link of text.matchAll(LINKS)) {
		out += escapeText(text.slice(at, link.index)) + link[0];
		at = link.index + link[0].length;
	}
	// Leading spaces would be dropped, or with four of them make a code block: no-break spaces keep the indent.
	return (out + escapeText(text.slice(at))).replace(/^[ \t]+/gm, (indent) => "\u00a0".repeat(indent.replaceAll("\t", "    ").length));
}

/**
 * Characters that start formatting anywhere, then ones that do at the start of a line (lists, headings, quotes, and
 * rules). Backslash-escaped, markdown reads each as itself. A run that starts after a link gets its first character
 * checked too, which only ever escapes one more than needed.
 */
const escapeText = (s: string) =>
	s.replace(/[\\`*_~[\]<&|]/g, "\\$&").replace(/^([ \t]*)([#>+=-]|\d{1,9}(?=[.)]))/gm, (_, indent: string, lead: string) =>
		/\d/.test(lead) ? `${indent}${lead}\\` : `${indent}\\${lead}`,
	);
