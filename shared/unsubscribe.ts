import { isValidAddress, normalizeAddress } from "./address";
import type { MailHeader } from "./types";

/** A mailto: URI from List-Unsubscribe (RFC 6068): who to write to, and what to say. */
export interface UnsubscribeMail {
	to: string[];
	subject: string;
	body: string;
}

/** What a List-Unsubscribe header (RFC 2369) offers, in the sender's order of preference within each kind. */
export interface UnsubscribeOptions {
	/** The first HTTPS URI: the only kind RFC 8058's one-click POST goes to. */
	https: string | null;
	/** The first web page, HTTPS or plain HTTP, for the person to finish on. */
	page: string | null;
	mail: UnsubscribeMail | null;
}

/**
 * RFC 2369: URIs in angle brackets, separated by commas, in the order the list prefers them. Whitespace inside one is
 * folding to ignore. Only web pages and mail are of use here; anything else (ftp:, javascript:) is left out.
 */
export function unsubscribeOptions(value: string): UnsubscribeOptions {
	const uris = [...value.matchAll(/<([^>]*)>/g)].map((m) => (m[1] ?? "").replaceAll(/\s+/g, ""));
	const web = uris.flatMap((uri) => {
		const url = URL.parse(uri);
		return url && (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "" ? [url] : [];
	});
	const mail = uris.filter((uri) => /^mailto:/i.test(uri)).map(parseMailto).find((m) => m !== null) ?? null;
	return { https: web.find((url) => url.protocol === "https:")?.href ?? null, page: web[0]?.href ?? null, mail };
}

/** Whether a message's kept headers (MailHeader) offer a way off its list: what the app shows the button for. */
export function offersUnsubscribe(headers: MailHeader[]): boolean {
	const value = headers.find((h) => h.name === "list-unsubscribe")?.value;
	if (!value) return false;
	const options = unsubscribeOptions(value);
	return options.page !== null || options.mail !== null;
}

/**
 * mailto:a@x,b@x?subject=…&body=… (RFC 6068). Parsed by hand rather than with URLSearchParams, which reads `+` as a
 * space: a list's address can be `unsubscribe+token@…`. Null when it names nobody valid or can't be decoded.
 */
function parseMailto(uri: string): UnsubscribeMail | null {
	const rest = uri.slice("mailto:".length);
	const at = rest.indexOf("?");
	const path = at < 0 ? rest : rest.slice(0, at);
	const fields = new Map<string, string>();
	const to: string[] = [];
	try {
		to.push(...path.split(",").map(decodeURIComponent));
		for (const pair of at < 0 ? [] : rest.slice(at + 1).split("&")) {
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = decodeURIComponent(pair.slice(0, eq)).toLowerCase();
			const value = decodeURIComponent(pair.slice(eq + 1));
			if (name === "to") to.push(...value.split(","));
			else if (!fields.has(name)) fields.set(name, value);
		}
	} catch {
		return null;
	}
	const valid = [...new Set(to.map(normalizeAddress).filter(isValidAddress))];
	if (valid.length === 0) return null;
	return { to: valid, subject: fields.get("subject")?.trim() || "Unsubscribe", body: fields.get("body")?.trim() || "Unsubscribe" };
}
