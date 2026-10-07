import { type Imported, type InboundJob, isValidAddress, r2Keys, stripSubaddress, ulid } from "#shared";
import type { ImportPlacement } from "#shared/import";
import PostalMime, { type Address as ParsedAddress } from "postal-mime";

/** Where a message's headers must end. Real ones run to tens of KB at most; past this it isn't mail. */
const MAX_HEADER_BYTES = 256 * 1024;
/** The latest time a ULID holds. */
const MAX_ULID_TIME = 2 ** 48 - 1;

/**
 * Takes one message imported from another provider into the inbound queue, which parses it like mail that just arrived
 * (ingest.ts) but places it as it was there. Only the headers are read here, to refuse what isn't mail and to fill in
 * the envelope the message never had.
 *
 * The id comes from the mailbox and the bytes, so the same file imported twice is the same message, and so is its
 * original in R2: the second upload overwrites it with the same bytes and ingest() finds it already there. If the job
 * can't be queued, the original stays for the browser to retry; one never retried is overwritten by the next import of
 * that file, or deleted with the mailbox. It isn't deleted here, since the same file can be queued from another upload.
 */
export async function importMessage(env: Env, mailboxId: string, raw: Uint8Array, placement: ImportPlacement): Promise<{ id: string } | { refused: string }> {
	const block = headerBlock(raw);
	const headers = block ? await PostalMime.parse(block) : null;
	if (!headers || !(headers.from || headers.messageId || headers.date)) return { refused: "This file isn't an email message" };

	// In the order the sidebar lists them.
	const { results } = await env.DIRECTORY.prepare(
		`SELECT r.address, a.enabled FROM address_routes r JOIN addresses a ON a.address = r.address
		 WHERE r.mailbox_id = ?1 ORDER BY a.created_at, a.rowid`,
	)
		.bind(mailboxId)
		.all<{ address: string; enabled: number }>();
	const base = (address: string) => stripSubaddress(address).base;
	const ours = new Set(results.map((r) => r.address));
	// Only these show in the sidebar and its views of an address, so only these file mail.
	const enabled = results.filter((r) => r.enabled === 1).map((r) => r.address);
	const shown = new Set(enabled);

	const from = addresses(headers.from ? [headers.from] : undefined).find(isValidAddress) ?? null;
	const sent = placement.sent ?? (from !== null && ours.has(base(from)));
	// The addresses it reached, and for sent mail the one it came from too: mail one of the mailbox's addresses sent
	// another belongs to both, as it would had it been sent here.
	const recipients = [headers.deliveredTo ?? "", header(headers.headers, "x-original-to"), ...addresses(headers.to), ...addresses(headers.cc)];
	const named = [...(sent && from ? [from] : []), ...recipients].filter(isValidAddress).map(base);
	const filed = [...new Set(named.filter((a) => shown.has(a)))];
	// Mail that names none of them (to or from an old address at the provider it came from, or one disabled here) goes
	// under the mailbox's first, so views of an address show it: it was imported into this mailbox on purpose.
	if (filed.length === 0 && enabled[0]) filed.push(enabled[0]);
	const envelopeTo = filed[0] ?? "";

	// When the old provider received it (Proton stamps X-Pm-Date), else when it says it was written.
	const date = parseDate(header(headers.headers, "x-pm-date")) ?? parseDate(headers.date);
	const id = await importId(mailboxId, raw, date ?? 0);
	const rawKey = r2Keys.imported(mailboxId, id);
	// With nothing to say where it was, mail from one of our addresses goes to Sent.
	const labels = sent && placement.sent === undefined ? [...new Set([...placement.labels, "sent"])] : placement.labels;
	const imported: Imported = { labels, read: placement.read, sent, addresses: filed };

	await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { mailboxes: mailboxId } });
	const job: InboundJob = {
		v: 1,
		ingestId: id,
		rawKey,
		rawSize: raw.byteLength,
		mailboxId,
		envelopeFrom: from ?? "",
		envelopeTo,
		subaddress: null,
		// Never later than now: deleting it removes its original once received_at is a day past (deleteTrashedOriginals).
		receivedAt: Math.min(date ?? Date.now(), Date.now()),
		imported,
	};
	await env.INBOUND.send(job);
	return { id };
}

/** The header block, through the blank line that ends it, or the whole file when it's all headers. Null when it never ends. */
function headerBlock(raw: Uint8Array): Uint8Array | null {
	const end = Math.min(raw.length, MAX_HEADER_BYTES);
	for (let i = 0; i < end - 1; i++) {
		if (raw[i] !== 10) continue;
		if (raw[i + 1] === 10 || (raw[i + 1] === 13 && raw[i + 2] === 10)) return raw.subarray(0, i + 1);
	}
	return raw.length <= MAX_HEADER_BYTES ? raw : null;
}

/** A ULID whose randomness is a digest of the mailbox and the message, so one file always gets the same id in a mailbox. */
async function importId(mailboxId: string, raw: Uint8Array, at: number): Promise<string> {
	const content = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
	const name = new TextEncoder().encode(`${mailboxId}\n`);
	const keyed = new Uint8Array(name.length + content.length);
	keyed.set(name);
	keyed.set(content, name.length);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", keyed));
	return ulid(Math.min(Math.max(at, 0), MAX_ULID_TIME), digest.subarray(0, 16));
}

function addresses(list: ParsedAddress[] | undefined): string[] {
	return (list ?? []).flatMap((a) => (a.group ? a.group : [a])).map((m) => m.address);
}

function header(headers: { key: string; value: string }[], key: string): string {
	return headers.find((h) => h.key === key)?.value.trim() ?? "";
}

function parseDate(value: string | undefined): number | null {
	if (!value) return null;
	const t = Date.parse(value);
	return Number.isNaN(t) ? null : t;
}
