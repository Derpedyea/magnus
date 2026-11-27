import { type UnsubscribeMail, unsubscribeOptions } from "#shared";
import PostalMime from "postal-mime";
import { headerBlock, MAX_HEADER_BYTES } from "./import";
import { stampedResults } from "./ingest";

/** A message's headers as PostalMime gives them: named in lower case, unfolded, top first. */
type Headers = { key: string; value: string }[];

/** RFC 8058 §5: the one value List-Unsubscribe-Post can have. */
const ONE_CLICK = "List-Unsubscribe=One-Click";
/** A list server that hasn't answered by now isn't going to. */
const ONE_CLICK_TIMEOUT_MS = 10_000;

/**
 * How to take the recipient off a message's list, best first: a one-click POST (RFC 8058) when the sender signed for
 * one, else mail to the list's address, else a page to finish on (RFC 2369). Null when its headers offer none.
 */
export interface UnsubscribePlan {
	oneClick: string | null;
	mail: UnsubscribeMail | null;
	page: string | null;
}

export function unsubscribePlan(headers: Headers): UnsubscribePlan | null {
	const lists = headers.filter((h) => h.key === "list-unsubscribe");
	const posts = headers.filter((h) => h.key === "list-unsubscribe-post");
	if (!lists[0]) return null;
	const { https, mail, page } = unsubscribeOptions(lists[0].value);
	// One of each (§3.1), so a header added above the signed ones on the way can't redirect the POST.
	const signed = lists.length === 1 && posts.length === 1 && posts[0]?.value.trim() === ONE_CLICK && signsBoth(headers);
	const oneClick = signed ? https : null;
	return oneClick || mail || page ? { oneClick, mail, page } : null;
}

/**
 * §4: one-click needs a valid DKIM signature whose h= covers List-Unsubscribe and List-Unsubscribe-Post, else it
 * SHOULD NOT be offered. Email Routing verified the signatures; its stamp names each passing one by its domain
 * (header.d) and, when it says, the start of its b= (header.b). A pass that fits more than one signature counts for
 * none: anyone handling the mail on the way can add a signature copying another's d= and b= with an h= of its own.
 */
function signsBoth(headers: Headers): boolean {
	const passed = (stampedResults(headers) ?? []).filter((r) => r.method === "dkim" && r.result === "pass");
	const signatures = headers.filter((h) => h.key === "dkim-signature").map((h) => dkimTags(h.value));
	return passed.some((r) => {
		const b = r.props.get("header.b");
		const named = signatures.filter((tags) => tags.get("d")?.toLowerCase() === r.props.get("header.d")?.toLowerCase() && (b === undefined || (tags.get("b") ?? "").startsWith(b)));
		const covered = named.length === 1 ? (named[0]?.get("h") ?? "").toLowerCase().split(":") : [];
		return covered.includes("list-unsubscribe") && covered.includes("list-unsubscribe-post");
	});
}

/** RFC 6376 §3.2: `tag=value` pairs split by `;`, with folding whitespace anywhere in a value. */
function dkimTags(value: string): Map<string, string> {
	return new Map(
		value.split(";").flatMap((part) => {
			const eq = part.indexOf("=");
			return eq > 0 ? [[part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).replaceAll(/\s+/g, "")] as const] : [];
		}),
	);
}

/** The headers of a stored original, reading no further than where they must end. Null when it's gone or they never end. */
export async function originalHeaders(bucket: R2Bucket, key: string): Promise<Headers | null> {
	const obj = await bucket.get(key, { range: { offset: 0, length: MAX_HEADER_BYTES } });
	if (!obj) return null;
	const block = headerBlock(new Uint8Array(await obj.arrayBuffer()));
	return block ? (await PostalMime.parse(block)).headers : null;
}

/**
 * §3.2: POSTs the one key/value pair, as the RFC's own examples send it, and nothing that could tie it to anyone:
 * no cookies or credentials, and no referrer. A redirect is the sender's mistake (§3.1) and isn't followed. Whether the
 * list server took it.
 */
export async function postOneClick(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: ONE_CLICK,
			redirect: "manual",
			signal: AbortSignal.timeout(ONE_CLICK_TIMEOUT_MS),
		});
		await res.body?.cancel();
		return res.ok;
	} catch {
		return false;
	}
}
