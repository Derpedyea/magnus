import { type Address, escapeHtml, formatBytes, isLinkToken, preview, type StoredAttachment } from "#shared";
import { Hono } from "hono";
import { mailboxExists } from "./directory";
import { fileHeaders, serveFile } from "./html";

/**
 * Files sent as links (shared/links.ts). Public, like a Drive link: whoever has the link gets the file until the
 * sender stops sharing it. The link opens a page that previews the file (shared/files.ts decides what's safe to
 * show) next to a Download button. The bytes live under the file's name, which viewers show and save as.
 */
export const links = new Hono<{ Bindings: Env }>();

links.get("/f/:mailboxId/:token", async (c) => {
	const { mailboxId, token } = c.req.param();
	const found = await findShared(c.env, mailboxId, token);
	if (found instanceof Response) return found;
	return filePage(found.file, found.from, `/f/${mailboxId}/${token}/${encodeURIComponent(found.file.filename)}`);
});

links.get("/f/:mailboxId/:token/:filename", async (c) => {
	const { mailboxId, token } = c.req.param();
	const found = await findShared(c.env, mailboxId, token);
	if (found instanceof Response) return found;
	const headers = fileHeaders(found.file, c.req.query("download") === "1");
	// Revalidate every time, so stopping sharing takes effect at once.
	headers.set("Cache-Control", "private, no-cache");
	headers.set("X-Robots-Tag", "noindex");
	return (await serveFile(c.env.MAIL, found.file.r2Key, c.req.raw, headers)) ?? notFound();
});

async function findShared(env: Env, mailboxId: string, token: string): Promise<{ file: StoredAttachment; from: Address } | Response> {
	// Checked before getByName, which would create a Durable Object for any name it's given.
	const found = isLinkToken(token) && (await mailboxExists(env.DIRECTORY, mailboxId)) ? await env.MAILBOX.getByName(mailboxId).getLinkedFile(token) : null;
	if (!found) return notFound();
	if (!found.file.link?.shared) {
		const sender = found.from.name || found.from.address;
		return message(410, "No longer shared", `${sender} stopped sharing ${found.file.filename}. Ask them to share it again.`);
	}
	return found;
}

const notFound = () => message(404, "File not found", "This link doesn't lead to a file. Check that you copied all of it.");

const DOWNLOAD_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`;

/** Name, size, and sender over a preview, after Drive's and Dropbox's shared-file pages. Plain HTML: no scripts. */
function filePage(file: StoredAttachment, from: Address, fileUrl: string): Response {
	const name = escapeHtml(file.filename);
	const src = escapeHtml(fileUrl);
	const media = {
		image: `<img src="${src}" alt="${name}">`,
		video: `<video src="${src}" controls playsinline preload="metadata"></video>`,
		audio: `<audio src="${src}" controls preload="metadata"></audio>`,
		pdf: `<iframe src="${src}" title="${name}"></iframe>`,
	};
	const kind = preview(file)?.kind;
	const body = `<header>
	<div><h1>${name}</h1><p>${formatBytes(file.size)} · from ${escapeHtml(from.name || from.address)}</p></div>
	<a class="download" href="${src}?download=1">${DOWNLOAD_ICON}Download</a>
</header>
${kind ? `<main class="${kind}">${media[kind]}</main>` : ""}`;
	return html(200, file.filename, body, kind ? "" : "plain");
}

function message(status: 404 | 410, title: string, text: string): Response {
	return html(status, title, `<header><div><h1>${title}</h1><p>${escapeHtml(text)}</p></div></header>`, "plain");
}

function html(status: number, title: string, body: string, bodyClass: string): Response {
	const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg">
<title>${escapeHtml(title)}</title>
<style>
	:root { color-scheme: light dark; --fg: #0a0a0a; --muted: #71717a; --bg: #fff; --stage: #f4f4f5; --line: #e4e4e7; font: 15px/1.5 system-ui, sans-serif; }
	@media (prefers-color-scheme: dark) { :root { --fg: #fafafa; --muted: #a1a1aa; --bg: #0a0a0a; --stage: #000; --line: #27272a; } }
	body { margin: 0; height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--bg); color: var(--fg); }
	header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--line); }
	header div { flex: 1; min-width: 0; }
	h1 { margin: 0; font-size: 1rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	p { margin: 0; color: var(--muted); font-size: 0.875rem; }
	.download { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.875rem; border-radius: 0.5rem; background: var(--fg); color: var(--bg); font-size: 0.875rem; font-weight: 500; text-decoration: none; white-space: nowrap; }
	main { display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center; padding: 1.5rem; background: var(--stage); }
	main img, main video { max-width: 100%; max-height: 100%; border-radius: 0.5rem; }
	main.video { background: #000; }
	main audio { width: min(32rem, 100%); }
	main.pdf { padding: 0; }
	main iframe { width: 100%; height: 100%; border: 0; }
	body.plain { grid-template-rows: auto; place-content: center; padding: 1.5rem; }
	body.plain header { flex-direction: column; gap: 1.25rem; max-width: 26rem; padding: 0; border: 0; text-align: center; }
	body.plain h1 { white-space: normal; font-size: 1.25rem; }
</style>
<body class="${bodyClass}">
${body}
</body>
</html>`;
	return new Response(page, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
			"X-Content-Type-Options": "nosniff",
			"Referrer-Policy": "no-referrer",
			"X-Robots-Tag": "noindex",
		},
	});
}
