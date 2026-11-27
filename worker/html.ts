import { preview, type StoredAttachment } from "#shared";
import { isInvisibleImage, isTrackerUrl } from "./trackers";

/** Elements removed with their content before mail is shown (and so not read by the spam checks either). */
export const REMOVED_ELEMENTS = ["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "textarea", "select", "base", "link"];

/** What a blocked image shows instead: a transparent pixel, so the layout around it holds. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * HTMLRewriter hands attribute values over as written, entities and all (`?a=1&amp;b=2`), so they're decoded before
 * being read as addresses or CSS. Named entities beyond these are rare in either.
 */
const NAMED: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", colon: ":", sol: "/", bsol: "\\", period: ".",
	commat: "@", quest: "?", num: "#", percnt: "%", equals: "=", lowbar: "_", hyphen: "-", dash: "-", plus: "+",
	excl: "!", comma: ",", semi: ";", ast: "*", lpar: "(", rpar: ")", lsqb: "[", rsqb: "]", lcub: "{", rcub: "}",
	verbar: "|", grave: "`", tab: "\t", newline: "\n", zwsp: "\u200b", shy: "\u00ad",
};
/** Named references a browser also decodes without their semicolon. Others, like `&num=` in a URL, stay as written. */
const LEGACY = new Set(["amp", "lt", "gt", "quot", "nbsp"]);
const decodeEntities = (value: string) =>
	value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (match, name: string) => {
		const code = name[0] !== "#" ? null : name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		if (code === null) return match.endsWith(";") || LEGACY.has(name.toLowerCase()) ? (NAMED[name.toLowerCase()] ?? match) : match;
		return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
	});
/** URL text as the browser canonicalizes it before scheme matching: references decoded, tab/CR/LF ignored, leading C0/space trimmed. */
const canonicalUrlText = (value: string) => decodeEntities(value).replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+/, "");
const dangerousScheme = /^(?:javascript|vbscript|data:text\/html)/i;
const NAVIGATION_SCHEMES = new Set(["http:", "https:", "mailto:", "cid:", "tel:"]);
/** Links may be absolute on schemes mail uses, or relative; everything else isn't a navigation we make clickable. */
function navigationAllowed(canonical: string): boolean {
	const scheme = canonical.match(/^[a-z][a-z0-9+.-]*:/i)?.[0].toLowerCase();
	return !scheme || NAVIGATION_SCHEMES.has(scheme);
}
/** Back into an attribute: HTMLRewriter's setAttribute() writes the value as given, inside double quotes. */
const encodeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const isRemote = (url: string) => /^\s*(https?:)?\/\//i.test(url);
/** A remote address made absolute: `//host/x` is taken as https. */
const absolute = (url: string) => url.trim().replace(/^\/\//, "https://");

/** srcset candidates as the HTML spec parses them: a URL runs to whitespace (a comma ending it closes it), descriptors to a comma. */
function srcsetCandidates(srcset: string): { url: string; descriptor: string }[] {
	const out: { url: string; descriptor: string }[] = [];
	const url = /[\s,]*(\S+)/y;
	const descriptor = /[^,]*/y;
	for (let m = url.exec(srcset); m; m = url.exec(srcset)) {
		if (m[1]!.endsWith(",")) {
			out.push({ url: m[1]!.replace(/,+$/, ""), descriptor: "" });
			continue;
		}
		descriptor.lastIndex = url.lastIndex;
		out.push({ url: m[1]!, descriptor: descriptor.exec(srcset)![0].trim() });
		url.lastIndex = descriptor.lastIndex;
	}
	return out;
}

/**
 * Serve an email's HTML body as its own document, loaded by the client in
 * <iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox">.
 * Defense in depth: strip active content with HTMLRewriter, forbid scripts with CSP, and load remote images only
 * through our proxy (`remoteUrl`), so senders never see the reader's address. Tracking pixels (worker/trackers.ts)
 * don't load at all unless `blockTrackers` is off; each is marked `data-blocked-src` for the client to count.
 */
export function renderEmailHtml(
	source: ReadableStream,
	opts: { attachments: StoredAttachment[]; attachmentUrl: (id: string) => string; remoteUrl: (url: string) => string; blockTrackers: boolean; origin: string },
): Response {
	const byCid = new Map(opts.attachments.filter((a) => a.contentId).map((a) => [a.contentId!, opts.attachmentUrl(a.id)]));
	/** Where a remote image loads from, or null if it's a tracker to block. */
	const remote = (url: string, invisible = false) => {
		const target = absolute(url);
		return opts.blockTrackers && (invisible || isTrackerUrl(target)) ? null : opts.remoteUrl(target);
	};
	/** Trackers blocked in CSS, which has no element to mark; each gets a hidden marker at the end so the client counts it. */
	const cssBlocked: string[] = [];
	/** Remote images in CSS (`background: url(...)`) go through the proxy too; trackers become `none`. */
	const rewriteCss = (css: string) =>
		css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, _quote, url: string) => {
			if (!isRemote(url)) return match;
			const to = remote(url);
			if (!to) cssBlocked.push(url);
			return to ? `url("${to}")` : "none";
		});
	const invisible = (el: Element) => isInvisibleImage((name) => decodeEntities(el.getAttribute(name) ?? "") || null);
	let css = "";

	const rewriter = new HTMLRewriter()
		.on(`${REMOVED_ELEMENTS.join(", ")}, meta[http-equiv]`, {
			element(el) {
				el.remove();
			},
		})
		// A button does nothing in mail but take focus, though its label can be the call to action: it stays, as a span
		// that keeps how it's shown (hidden, style), so what shows is what the spam checks read.
		.on("button", {
			element(el) {
				el.tagName = "span";
				for (const name of ["formaction", "formmethod", "formtarget", "formenctype", "form", "type", "name", "value", "autofocus", "popovertarget"]) el.removeAttribute(name);
			},
		})
		.on("*", {
			element(el) {
				const drop: string[] = [];
				for (const [name = "", value = ""] of el.attributes) {
					const attribute = name.toLowerCase();
					const canonical = canonicalUrlText(value);
					// data-blocked-src is ours, so the mail can't fake a blocked tracker.
					if (
						attribute.startsWith("on") ||
						attribute === "ping" ||
						attribute === "data-blocked-src" ||
						dangerousScheme.test(canonical) ||
						((el.tagName === "a" || el.tagName === "area") && (attribute === "href" || attribute === "xlink:href") && !navigationAllowed(canonical))
					) drop.push(name);
				}
				for (const name of drop) el.removeAttribute(name);
				const style = decodeEntities(el.getAttribute("style") ?? "");
				if (/url\(/i.test(style)) {
					const rewritten = rewriteCss(style);
					if (rewritten !== style) el.setAttribute("style", encodeAttribute(rewritten));
				}
				const background = decodeEntities(el.getAttribute("background") ?? "");
				if (background && isRemote(background)) {
					const to = remote(background);
					if (to) el.setAttribute("background", to);
					else {
						el.setAttribute("data-blocked-src", encodeAttribute(background));
						el.removeAttribute("background");
					}
				}
			},
		})
		// Buffered, since CSS can arrive in several chunks, then written back as it was with remote images proxied.
		.on("style", {
			text(chunk) {
				css += chunk.text;
				if (!chunk.lastInTextNode) {
					chunk.remove();
					return;
				}
				chunk.replace(rewriteCss(css), { html: true });
				css = "";
			},
		})
		.on("img[src]", {
			element(el) {
				const src = decodeEntities(el.getAttribute("src") ?? "");
				if (src.toLowerCase().startsWith("cid:")) {
					const url = byCid.get(src.slice(4).replace(/^<|>$/g, ""));
					if (url) el.setAttribute("src", url);
					else el.removeAttribute("src");
				} else if (isRemote(src)) {
					const to = remote(src, invisible(el));
					if (to) el.setAttribute("src", to);
					else {
						el.setAttribute("data-blocked-src", encodeAttribute(src));
						el.setAttribute("src", BLANK);
						el.removeAttribute("srcset");
					}
				}
			},
		})
		// Every candidate is proxied or dropped; a srcset left with none goes, and the <img>'s src shows instead.
		.on("img[srcset], source[srcset]", {
			element(el) {
				const hidden = el.tagName === "img" && invisible(el);
				let blocked: string | null = null;
				const candidates = srcsetCandidates(decodeEntities(el.getAttribute("srcset") ?? "")).flatMap(({ url, descriptor }) => {
					const to = isRemote(url) ? remote(url, hidden) : url.startsWith("data:") ? url : null;
					if (!to && isRemote(url)) blocked ??= url;
					return to ? [descriptor ? `${to} ${descriptor}` : to] : [];
				});
				if (candidates.length > 0) el.setAttribute("srcset", encodeAttribute(candidates.join(", ")));
				else el.removeAttribute("srcset");
				if (blocked && !el.hasAttribute("data-blocked-src")) el.setAttribute("data-blocked-src", encodeAttribute(blocked));
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
				for (const url of cssBlocked) end.append(`<span hidden data-blocked-src="${encodeAttribute(url).replaceAll("<", "&lt;")}"></span>`, { html: true });
			},
		});

	// Remote images come only through the proxy on this origin, so CSP blocks anything the rewrite missed.
	const csp = [
		"default-src 'none'",
		`img-src ${opts.origin} data:`,
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
			},
		}),
	);
}

/** Raster types the proxy passes on. SVG is left out: it can script if opened on its own. */
const PROXIED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon"]);
const PROXY_MAX_BYTES = 20_000_000;

/**
 * An http(s) address on a public host's default port, or null. Keeps the proxy off localhost and private networks
 * (which a deployed Worker can't reach anyway, but `wrangler dev` can) and away from IP literals mail has no use for.
 */
export function publicImageUrl(raw: string | undefined): URL | null {
	let url: URL;
	try {
		url = new URL(raw ?? "");
	} catch {
		return null;
	}
	const host = url.hostname.toLowerCase();
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username || url.password || url.port) return null;
	if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
	if (/\.(localhost|local|internal|lan|home\.arpa)$/.test(host)) return null;
	return url;
}

/**
 * Fetches a remote image for an email, so the sender sees Cloudflare rather than the reader: no cookies, no referrer,
 * no browser headers. Only raster images come back, as their own type, under the same lockdown as attachments.
 * Cloudflare caches what it fetches, so opening the mail again doesn't ask the sender again.
 */
export async function proxyImage(raw: string | undefined): Promise<Response> {
	let url = publicImageUrl(raw);
	let upstream: Response | null = null;
	try {
		// Redirects are followed by hand so each hop gets the same check.
		for (let hop = 0; url && hop < 5; hop++) {
			upstream = await fetch(url, {
				headers: { Accept: "image/avif,image/webp,image/png,image/*;q=0.8" },
				redirect: "manual",
				signal: AbortSignal.timeout(10_000),
				cf: { cacheEverything: true, cacheTtl: 86_400 },
			});
			const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get("Location") : null;
			if (!location) break;
			await upstream.body?.cancel();
			upstream = null;
			url = publicImageUrl(new URL(location, url).href);
		}
	} catch {
		upstream = null;
	}
	const type = upstream?.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() ?? "";
	const size = Number(upstream?.headers.get("Content-Length") ?? 0);
	if (!upstream?.ok || !PROXIED_IMAGES.has(type) || size > PROXY_MAX_BYTES) {
		await upstream?.body?.cancel();
		return new Response(null, { status: 502 });
	}
	// Content-Length is optional (chunked responses lack it), so the limit holds on the bytes that actually arrive.
	let read = 0;
	const capped = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, stream) {
			read += chunk.byteLength;
			if (read > PROXY_MAX_BYTES) stream.error(new Error("Image too large"));
			else stream.enqueue(chunk);
		},
	});
	return new Response(upstream.body?.pipeThrough(capped) ?? null, {
		headers: { "Content-Type": type, "Content-Security-Policy": FILE_CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" },
	});
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
