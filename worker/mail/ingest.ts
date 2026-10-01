import {
	type Address,
	type AuthResults,
	type InboundJob,
	type IngestInput,
	labelFromTag,
	parseMessageIds,
	r2Keys,
	type StoredAttachment,
} from "#shared";
import PostalMime, { type Address as ParsedAddress, type Email } from "postal-mime";
import { mailboxExists } from "../directory";

/** Parse a stored raw message, split out bodies/attachments to R2, and hand metadata to the mailbox. */
export async function ingest(env: Env, job: InboundJob): Promise<void> {
	// The mailbox can be gone since this was queued: its person removed, or a failed add undone after its address took
	// mail. Delivering would bring it back, mail and all, with nobody to open it.
	if (!(await mailboxExists(env.DIRECTORY, job.mailboxId))) {
		await dropOriginal(env, job.rawKey);
		console.log(JSON.stringify({ msg: "mailbox gone", ingestId: job.ingestId, mailboxId: job.mailboxId }));
		return;
	}
	const raw = await env.MAIL.get(job.rawKey);
	if (!raw) {
		// Nothing to retry against. Logged for the DLQ/ops trail.
		console.error(JSON.stringify({ msg: "raw message missing", rawKey: job.rawKey, mailboxId: job.mailboxId }));
		return;
	}

	const email = await PostalMime.parse(await raw.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
	const messageId = job.ingestId;

	let htmlKey: string | null = null;
	if (email.html) {
		htmlKey = r2Keys.html(job.mailboxId, messageId);
		await env.MAIL.put(htmlKey, email.html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
	}

	const attachments: StoredAttachment[] = [];
	for (const [index, a] of email.attachments.entries()) {
		// Deterministic, so a redelivered job overwrites instead of orphaning objects.
		const id = `${messageId}-${index + 1}`;
		const r2Key = r2Keys.attachment(job.mailboxId, messageId, id);
		const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
		await env.MAIL.put(r2Key, content, { httpMetadata: { contentType: a.mimeType } });
		const contentId = a.contentId?.replace(/^<|>$/g, "") ?? null;
		attachments.push({
			id,
			filename: a.filename ?? `attachment-${index + 1}`,
			contentType: a.mimeType,
			size: content.byteLength,
			contentId,
			inline: a.disposition === "inline" || (a.related === true && contentId !== null),
			link: null,
			r2Key,
		});
	}

	const auth = parseAuthResults(email);
	const labels = [classify(auth) ?? "inbox"];
	if (job.subaddress) labels.push(labelFromTag(job.subaddress));

	const input: IngestInput = {
		id: messageId,
		rawKey: job.rawKey,
		envelopeFrom: job.envelopeFrom,
		envelopeTo: job.envelopeTo,
		receivedAt: job.receivedAt,
		messageIdHeader: email.messageId ? (parseMessageIds(email.messageId)[0] ?? null) : null,
		inReplyTo: parseMessageIds(email.inReplyTo),
		references: parseMessageIds(email.references),
		from: firstAddress(email.from) ?? { address: job.envelopeFrom },
		to: flatten(email.to),
		cc: flatten(email.cc),
		replyTo: flatten(email.replyTo),
		subject: email.subject ?? "(no subject)",
		date: parseDate(email.date) ?? job.receivedAt,
		text: email.text ?? (email.html ? htmlToText(email.html) : null),
		htmlKey,
		attachments,
		auth,
		labels,
	};

	const result = await env.MAILBOX.getByName(job.mailboxId).ingest(input);
	console.log(JSON.stringify({ msg: "ingested", ingestId: job.ingestId, mailboxId: job.mailboxId, ...result }));
}

/**
 * Deletes an original none of whose mailboxes is left, since none will hold it to delete it later. One that doesn't
 * list them is kept, as Mailbox.deleteOriginals keeps it.
 */
async function dropOriginal(env: Env, rawKey: string): Promise<void> {
	const listed = (await env.MAIL.head(rawKey))?.customMetadata?.mailboxes;
	if (!listed) return;
	const left = await env.DIRECTORY.prepare(`SELECT 1 AS ok FROM mailboxes WHERE id IN (SELECT value FROM json_each(?1)) LIMIT 1`)
		.bind(JSON.stringify(listed.split(",")))
		.first();
	if (left === null) await env.MAIL.delete(rawKey);
}

function flatten(list: ParsedAddress[] | undefined): Address[] {
	if (!list) return [];
	return list.flatMap((a) => (a.group ? a.group : [a])).map((m) => toAddress(m.address, m.name));
}

function firstAddress(a: ParsedAddress | undefined): Address | null {
	return a ? (flatten([a])[0] ?? null) : null;
}

function toAddress(address: string, name: string): Address {
	return name ? { address, name } : { address };
}

function parseDate(value: string | undefined): number | null {
	if (!value) return null;
	const t = Date.parse(value);
	return Number.isNaN(t) ? null : t;
}

/**
 * Email Routing already rejects mail that fails the sender's DMARC policy and mail from
 * RBL-listed IPs. We record the verdicts it stamped on the message for display and triage.
 */
function parseAuthResults(email: Email): AuthResults | null {
	const header = email.headers.find((h) => h.key === "authentication-results" || h.key === "arc-authentication-results");
	if (!header) return null;
	const verdict = (mech: string) => header.value.match(new RegExp(`\\b${mech}=([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? null;
	return { spf: verdict("spf"), dkim: verdict("dkim"), dmarc: verdict("dmarc") };
}

/** Minimal first-pass triage. Swap in Workers AI or a rules engine here. */
function classify(auth: AuthResults | null): "spam" | null {
	if (!auth) return null;
	if (auth.dmarc === "fail") return "spam";
	if (auth.spf === "fail" && auth.dkim !== "pass") return "spam";
	return null;
}

/** me+Receipts@… → label "receipts". */
/** Good enough for snippets and search when a message has no text/plain part. */
function htmlToText(html: string): string {
	return html
		.replaceAll(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
		.replaceAll(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replaceAll(/<[^>]+>/g, " ")
		.replaceAll(/&nbsp;/g, " ")
		.replaceAll(/&amp;/g, "&")
		.replaceAll(/&lt;/g, "<")
		.replaceAll(/&gt;/g, ">")
		.replaceAll(/&quot;/g, '"')
		.replaceAll(/&#39;/g, "'")
		.replaceAll(/[ \t]+/g, " ")
		.replaceAll(/\n\s*\n+/g, "\n\n")
		.trim();
}
