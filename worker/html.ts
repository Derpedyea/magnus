import type { StoredAttachment } from "#shared";

/**
 * Serve an email's HTML body as its own document, loaded by the client in
 * <iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">.
 * Defense in depth: strip active content with HTMLRewriter, forbid scripts with CSP,
 * and block remote content (tracking pixels) unless the user opts in.
 */
export function renderEmailHtml(
	source: ReadableStream,
	opts: { attachments: StoredAttachment[]; attachmentUrl: (id: string) => string; allowRemote: boolean; origin: string },
): Response {
	const byCid = new Map(opts.attachments.filter((a) => a.contentId).map((a) => [a.contentId!, opts.attachmentUrl(a.id)]));
	let blockedRemote = 0;

	const rewriter = new HTMLRewriter()
		.on("script, noscript, iframe, frame, frameset, object, embed, applet, form, base, link, meta[http-equiv]", {
			element(el) {
				el.remove();
			},
		})
		.on("*", {
			element(el) {
				const drop: string[] = [];
				for (const [name = "", value = ""] of el.attributes) {
					if (name.startsWith("on") || name === "ping" || /^\s*(javascript|vbscript|data:text\/html)/i.test(value)) drop.push(name);
				}
				for (const name of drop) el.removeAttribute(name);
			},
		})
		.on("img[src]", {
			element(el) {
				const src = el.getAttribute("src") ?? "";
				if (src.toLowerCase().startsWith("cid:")) {
					const url = byCid.get(src.slice(4).replace(/^<|>$/g, ""));
					if (url) el.setAttribute("src", url);
					else el.removeAttribute("src");
				} else if (!opts.allowRemote && /^(https?:)?\/\//i.test(src)) {
					el.setAttribute("data-blocked-src", src);
					el.removeAttribute("src");
					blockedRemote++;
				}
			},
		})
		.on("a[href]", {
			element(el) {
				el.setAttribute("target", "_blank");
				el.setAttribute("rel", "noopener noreferrer");
			},
		})
		.onDocument({
			end(end) {
				if (blockedRemote > 0) end.append(`<!-- magnus:blocked-remote=${blockedRemote} -->`, { html: true });
			},
		});

	const imgSrc = opts.allowRemote ? `${opts.origin} data: https:` : `${opts.origin} data:`;
	const csp = [
		"default-src 'none'",
		`img-src ${imgSrc}`,
		"style-src 'unsafe-inline'",
		"font-src data:",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join("; ");

	return rewriter.transform(
		new Response(source, {
			headers: {
				"Content-Type": "text/html; charset=utf-8",
				"Content-Security-Policy": csp,
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, max-age=3600",
			},
		}),
	);
}

/** Types a browser may render inline without risking script execution on our origin. */
const INLINE_SAFE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "text/plain"]);

export function attachmentHeaders(a: StoredAttachment, download: boolean): Headers {
	const type = a.contentType.toLowerCase().split(";")[0]!.trim();
	const inline = !download && INLINE_SAFE.has(type);
	const ascii = a.filename.replaceAll(/[^\x20-\x7e]|["\\]/g, "_");
	return new Headers({
		"Content-Type": inline ? a.contentType : "application/octet-stream",
		"Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
		"Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "private, max-age=86400, immutable",
	});
}
