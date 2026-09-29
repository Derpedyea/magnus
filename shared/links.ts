/**
 * Files too big for Email Sending go out as download links instead, the way Gmail's Drive links work. The
 * sender keeps the file like any attachment; the message carries a link that works until the sender stops
 * sharing it. No expiry: an attachment stays readable in the recipient's archive forever, and so should this.
 */

import { formatBytes, type PreviewKind, preview } from "./files";

/** Email Service: total outbound message size, attachments included, for non-verified recipients. */
export const MAX_OUTBOUND_BYTES = 5 * 1024 * 1024;
/** Largest single upload: Cloudflare's request body limit on Free and Pro plans. */
export const MAX_UPLOAD_BYTES = 100 * 1000 * 1000;

/** Room for headers (Email Sending allows 16 KB of custom ones) and MIME boundaries. */
const MESSAGE_OVERHEAD = 64 * 1024;

/**
 * Bytes a part takes once base64-encoded into the message: 57 bytes per 78-character line, CRLF included.
 * Cloudflare doesn't say whether its limit counts encoded or raw bytes, so assume encoded.
 */
export const encodedSize = (bytes: number) => Math.ceil(bytes / 57) * 78;

/**
 * Which files ride inside the message and which go as links. Links the largest files first, so the fewest
 * files become links. The body counts toward the limit too; `fits` is false when it's too big on its own.
 */
export function splitAttachments<T extends { size: number }>(files: T[], bodyBytes: number): { attached: T[]; linked: T[]; fits: boolean } {
	let total = MESSAGE_OVERHEAD + encodedSize(bodyBytes) + files.reduce((n, f) => n + encodedSize(f.size), 0);
	const linked = new Set<T>();
	for (const f of files.toSorted((a, b) => b.size - a.size)) {
		if (total <= MAX_OUTBOUND_BYTES) break;
		linked.add(f);
		total -= encodedSize(f.size);
	}
	return { attached: files.filter((f) => !linked.has(f)), linked: files.filter((f) => linked.has(f)), fits: total <= MAX_OUTBOUND_BYTES };
}

/**
 * splitAttachments for a whole message. Linking anything grows the body: a block in the text and, for plain-text
 * mail, an HTML part carrying the text again. So once something has to be linked, split again against that
 * bigger body, sized as if every file were linked, which only overestimates.
 */
export function planAttachments<T extends Omit<LinkedFile, "url">>(files: T[], body: MessageBody, linkBase: string) {
	const plain = splitAttachments(files, byteLength(body.text + (body.html ?? "")));
	if (plain.linked.length === 0) return plain;
	const url = linkBase + newLinkToken();
	const linked = withLinks(body, files.map((f) => ({ ...f, url })));
	return splitAttachments(files, byteLength(linked.text + linked.html));
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** 128 random bits, base64url. The link's only credential. */
export function newLinkToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export const isLinkToken = (s: string) => /^[\w-]{22}$/.test(s);

export interface LinkedFile {
	filename: string;
	contentType: string;
	size: number;
	url: string;
}

export interface MessageBody {
	text: string;
	html?: string;
}

/** The body once `files` are linked: their block in the text, and cards in the HTML, made from the text if there's none. */
export function withLinks(body: MessageBody, files: LinkedFile[]): { text: string; html: string } {
	return {
		text: insertBeforeQuote(body.text, linkBlockText(files)),
		html: body.html ? body.html + linkCards(files) : linkedMessageHtml(body.text, files),
	};
}

// Wording after Thunderbird's Filelink, which recipients have seen for a decade.
const linkIntro = (count: number) => (count === 1 ? "I've linked a file to this email." : `I've linked ${count} files to this email.`);

/** For the plain-text part, which text-only clients show: the bare URLs. */
export function linkBlockText(files: LinkedFile[]): string {
	return [linkIntro(files.length), ...files.map((f) => `${f.filename} (${formatBytes(f.size)})\n${f.url}`)].join("\n\n");
}

/**
 * The plain-text message as its HTML part, with a card per linked file where the text has its link block. HTML
 * readers (nearly everyone, and Magnus itself) see cards instead of long URLs, like Gmail's Drive attachments.
 */
export function linkedMessageHtml(text: string, files: LinkedFile[]): string {
	const [body, quote] = splitQuote(text);
	const lines = (s: string, style: string) => (s ? `<div style="${style}">${escapeHtml(s).replaceAll("\n", "<br>")}</div>` : "");
	return `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${INK}">${lines(body, "")}${linkCards(files)}${lines(quote, `margin-top:16px;color:${MUTED}`)}</div>`;
}

/** Link cards on their own, for appending to HTML the sender wrote. */
export function linkCards(files: LinkedFile[]): string {
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:440px;margin:16px 0 0;font-family:${FONT}">
<tr><td style="font-size:13px;color:${MUTED}">${escapeHtml(linkIntro(files.length))}</td></tr>
${files.map((f) => `<tr><td style="padding:8px 0 0">${linkCard(f)}</td></tr>`).join("\n")}
</table>`;
}

// Email HTML: tables and inline styles only, so it holds up in Gmail and Outlook. A tile with the extension on it
// stands in for an icon, since clients strip SVG and block images.
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#18181b";
const MUTED = "#71717a";
const TILE_COLORS: Record<PreviewKind | "other", string> = { image: "#0284c7", video: "#7c3aed", audio: "#d97706", pdf: "#dc2626", other: "#52525b" };

function linkCard(f: LinkedFile): string {
	const kind = preview(f)?.kind;
	const extension = /\.([a-z0-9]{1,4})$/i.exec(f.filename)?.[1]?.toUpperCase() ?? "FILE";
	const url = escapeHtml(f.url);
	return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border:1px solid #e4e4e7;border-radius:10px;border-collapse:separate">
<tr>
<td style="padding:12px 0 12px 12px;width:40px"><div style="width:40px;height:40px;border-radius:8px;background:${TILE_COLORS[kind ?? "other"]};color:#fff;font-size:11px;font-weight:700;line-height:40px;text-align:center">${extension}</div></td>
<td style="padding:12px"><a href="${url}" style="color:${INK};font-size:14px;font-weight:600;text-decoration:none;word-break:break-word">${escapeHtml(f.filename)}</a><div style="color:${MUTED};font-size:13px">${formatBytes(f.size)}</div></td>
<td style="padding:12px 12px 12px 0;text-align:right"><a href="${url}" style="display:inline-block;padding:7px 12px;border-radius:7px;background:${INK};color:#fff;font-size:13px;font-weight:500;text-decoration:none">${kind ? "View" : "Download"}</a></td>
</tr>
</table>`;
}

/**
 * Splits off a trailing quote ("On …, X wrote:" and its "> " lines), so link blocks go above it, where Gmail
 * would otherwise fold them out of sight. Bottom-posted replies have no trailing quote.
 */
export function splitQuote(text: string): [body: string, quote: string] {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && (lines[end - 1]!.startsWith(">") || lines[end - 1]!.trim() === "")) end--;
	if (!lines.slice(end).some((l) => l.startsWith(">"))) return [text.trimEnd(), ""];
	if (end > 0 && /wrote:\s*$/.test(lines[end - 1]!)) end--;
	return [lines.slice(0, end).join("\n").trimEnd(), lines.slice(end).join("\n")];
}

export function insertBeforeQuote(text: string, block: string): string {
	const [body, quote] = splitQuote(text);
	return [body, block, quote].filter(Boolean).join("\n\n");
}

export const escapeHtml = (s: string) =>
	s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
