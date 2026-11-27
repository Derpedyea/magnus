import { WorkerEntrypoint } from "cloudflare:workers";
import type { Address } from "#shared";
import PostalMime, { type Address as ParsedAddress } from "postal-mime";
import { type MailFacts, readHtml, readText } from "../../worker/mail/checks";

// What the models would read of a raw message, as worker/mail/ingest.ts builds it (read()), for bench/models/import.mjs.
// Run in workerd, as readHtml() needs HTMLRewriter. One difference: production trusts only Email Routing's
// Authentication-Results; mail saved elsewhere carries its receiving provider's, which stands in for it here.

function flatten(list: ParsedAddress[] | undefined): Address[] {
	if (!list) return [];
	return list.flatMap((a) => (a.group ? a.group : [a])).map((m) => (m.name ? { address: m.address, name: m.name } : { address: m.address }));
}

/** RFC 8601 results, as ingest.ts's resultsOf() reads them. */
function resultsOf(value: string) {
	let text = value;
	while (/\([^()]*\)/.test(text)) text = text.replaceAll(/\([^()]*\)/g, " ");
	return text
		.split(";")
		.slice(1)
		.flatMap((part) => {
			const [head, ...rest] = part.trim().split(/\s+/);
			const verdict = head?.match(/^([a-z0-9-]+)=([a-z]+)$/i);
			if (!verdict?.[1] || !verdict[2]) return [];
			const props = new Map(
				rest.flatMap((p) => {
					const at = p.indexOf("=");
					return at > 0 ? [[p.slice(0, at).toLowerCase(), p.slice(at + 1)] as const] : [];
				}),
			);
			return [{ method: verdict[1].toLowerCase(), result: verdict[2].toLowerCase(), props }];
		});
}

/** checkSender()'s reading: verified, or spoofed (which production never shows the models), or neither. */
function sender(address: string, stamp: string | undefined) {
	const results = stamp ? resultsOf(stamp) : null;
	const passed = (method: string) => results?.filter((r) => r.method === method && r.result === "pass") ?? [];
	const failed = (method: string) => results?.some((r) => r.method === method && r.result === "fail") ?? false;
	const spf = results?.find((r) => r.method === "spf" && r.props.has("smtp.mailfrom"));
	const spoofed = failed("dmarc") || (spf?.result === "fail" && passed("dkim").length === 0);
	const domain = address.toLowerCase().split("@")[1] ?? "";
	const vouches = (d: string | undefined) => {
		const name = d?.toLowerCase().replace(/^.*@/, "");
		return name !== undefined && name !== "" && (domain === name || domain.endsWith(`.${name}`));
	};
	const verified =
		!spoofed &&
		(passed("dmarc").some((r) => r.props.get("header.from")?.toLowerCase() === domain) ||
			passed("dkim").some((r) => vouches(r.props.get("header.d"))) ||
			(spf?.result === "pass" && vouches(spf.props.get("smtp.mailfrom"))));
	return { verified, spoofed, stamped: results !== null };
}

export default class extends WorkerEntrypoint {
	override async fetch() {
		return new Response("bench facts worker");
	}

	async facts(raw: ArrayBuffer): Promise<{ facts: MailFacts; spoofed: boolean; stamped: boolean; date: string | null }> {
		const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
		const from = flatten(email.from ? [email.from] : undefined)[0] ?? { address: "" };
		// The topmost stamp: the receiving provider's.
		const stamp = email.headers.find((h) => h.key === "authentication-results")?.value;
		const s = sender(from.address, stamp);
		const attached = new Set(email.attachments.flatMap((a) => (a.contentId ? [a.contentId.replace(/^<|>$/g, "")] : [])));
		const facts: MailFacts = {
			to: flatten(email.to)[0]?.address ?? "",
			from,
			verifiedSender: s.verified,
			replyTo: flatten(email.replyTo),
			subject: email.subject ?? "(no subject)",
			page: email.html ? await readHtml(email.html, attached) : readText(email.text ?? ""),
			attachments: email.attachments.map((a) => ({ filename: a.filename ?? "", contentType: a.mimeType })),
		};
		return { facts, spoofed: s.spoofed, stamped: s.stamped, date: email.date ?? null };
	}
}
