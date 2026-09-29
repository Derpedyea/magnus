import { preview, type StoredAttachment } from "#shared";

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

/** Locked down even if something renders: no scripts, nothing loaded but the file itself. Chrome's PDF viewer copes. */
const FILE_CSP = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'self'";

/**
 * Headers for a stored file. It shows inline only when shared/files.ts says it's safe, served as that safe type;
 * anything else, and anything asked for with `download`, is an attachment.
 */
export function fileHeaders(a: { filename: string; contentType: string }, download: boolean): Headers {
	const shown = download ? null : preview(a);
	const ascii = a.filename.replaceAll(/[^\x20-\x7e]|["\\]/g, "_");
	return new Headers({
		"Content-Type": shown?.type ?? "application/octet-stream",
		"Content-Disposition": `${shown ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
		"Content-Security-Policy": FILE_CSP,
		"X-Content-Type-Options": "nosniff",
		"Cache-Control": "private, max-age=86400, immutable",
	});
}

/** Streams a file from R2, honouring Range so video and audio can seek. Null if it's missing. */
export async function serveFile(bucket: R2Bucket, key: string, request: Request, headers: Headers): Promise<Response | null> {
	const range = parseRange(request.headers.get("Range"));
	let obj: R2ObjectBody | null;
	try {
		obj = await bucket.get(key, range ? { range } : {});
	} catch {
		// R2 rejects a range that starts past the end.
		const head = await bucket.head(key);
		return head ? unsatisfiable(head.size) : null;
	}
	if (!obj) return null;
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", obj.httpEtag);
	if (!range) return new Response(obj.body, { headers });

	const [start, end] = rangeBounds(range, obj.size);
	if (start > end) {
		await obj.body.cancel();
		return unsatisfiable(obj.size);
	}
	headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
	headers.set("Content-Length", String(end - start + 1));
	return new Response(obj.body, { status: 206, headers });
}

/** `bytes=a-b`, `bytes=a-`, or `bytes=-n`. Anything else, several ranges included, gets the whole file. */
export function parseRange(header: string | null): R2Range | null {
	const m = header?.match(/^bytes=(\d*)-(\d*)$/);
	if (!m || (!m[1] && !m[2])) return null;
	if (!m[1]) return { suffix: Number(m[2]) };
	const offset = Number(m[1]);
	if (!m[2]) return { offset };
	const length = Number(m[2]) - offset + 1;
	return length > 0 ? { offset, length } : null;
}

/** First and last byte a range covers in a file of `size` bytes; start > end when none of it exists. */
export function rangeBounds(range: R2Range, size: number): [number, number] {
	if ("suffix" in range) return [Math.max(0, size - range.suffix), size - 1];
	const start = range.offset ?? 0;
	return [start, range.length === undefined ? size - 1 : Math.min(size, start + range.length) - 1];
}

const unsatisfiable = (size: number) => new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
