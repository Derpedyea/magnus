import {
	type Address,
	type AuthResults,
	type InboundJob,
	type IngestInput,
	isValidAddress,
	type MailCheck,
	labelFromTag,
	normalizeAddress,
	parseMessageIds,
	r2Keys,
	type SenderCheck,
	type StoredAttachment,
	splitAddress,
	stripSubaddress,
} from "#shared";
import PostalMime, { type Address as ParsedAddress, type Email } from "postal-mime";
import { isOwnAddress, mailboxExists } from "../directory";
import { notifyNewMail } from "../push";
import { checkMail, type MailFacts, type Models } from "./checks";

/**
 * Tries at checking mail from an unknown sender, about a minute and a half apart in all, before it's delivered unchecked
 * instead: to Spam, saying so. Mail isn't held for an outage, and isn't let through unseen.
 */
const CHECK_ATTEMPTS = 3;
const MAX_CHECK_ERROR = 300;
/** HTML read for the checks, at most: what the models see is cut far shorter, so the rest would only cost CPU. */
const MAX_SCANNED = 200_000;

/** Parse a stored raw message, split out bodies/attachments to R2, and hand metadata to the mailbox. */
export async function ingest(env: Env, job: InboundJob, models: Models = env.AI): Promise<void> {
	// The mailbox can be gone since this was queued: its person removed, or a failed add undone after its address took
	// mail. Delivering would bring it back, mail and all, with nobody to open it. (It can also go while this runs: see
	// the end.)
	if (!(await mailboxExists(env.DIRECTORY, job.mailboxId))) return clearGone(env, job);
	const raw = await env.MAIL.get(job.rawKey);
	if (!raw) {
		// Nothing to retry against, or to list under Failed.
		console.error(JSON.stringify({ msg: "raw message missing", rawKey: job.rawKey, mailboxId: job.mailboxId }));
		return;
	}

	const email = await PostalMime.parse(await raw.arrayBuffer(), { attachmentEncoding: "arraybuffer" });
	const messageId = job.ingestId;
	const mailbox = env.MAILBOX.getByName(job.mailboxId);

	const from = firstAddress(email.from) ?? { address: job.envelopeFrom };
	const results = stampedResults(email);
	const sender = await checkSender(env, from.address, results);
	const text = email.text ?? (email.html ? htmlToText(email.html) : null);
	const html = email.html?.slice(0, MAX_SCANNED) ?? null;
	const facts: MailFacts = {
		to: job.envelopeTo,
		from,
		verifiedSender: sender.verified !== null,
		replyTo: flatten(email.replyTo),
		subject: email.subject ?? "(no subject)",
		// What the recipient sees: the app shows the HTML part when there is one, and the sender can make a plain-text
		// part say anything else.
		text: html ? await visibleText(html) : text,
		html,
		attachments: email.attachments.map((a) => ({ filename: a.filename ?? "", contentType: a.mimeType })),
	};
	const messageIdHeader = email.messageId ? (parseMessageIds(email.messageId)[0] ?? null) : null;
	const check = (await mailbox.needsCheck(sender, messageIdHeader, messageId)) ? await checkOrGiveUp(env, models, facts, job) : null;
	// Back in the queue with the failure counted (checkOrGiveUp()): this copy of the job is done.
	if (check === "requeued") return;

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

	const input: IngestInput = {
		id: messageId,
		rawKey: job.rawKey,
		envelopeFrom: job.envelopeFrom,
		envelopeTo: job.envelopeTo,
		receivedAt: job.receivedAt,
		messageIdHeader,
		inReplyTo: parseMessageIds(email.inReplyTo),
		references: parseMessageIds(email.references),
		from,
		to: flatten(email.to),
		cc: flatten(email.cc),
		replyTo: facts.replyTo,
		subject: facts.subject,
		date: parseDate(email.date) ?? job.receivedAt,
		text,
		htmlKey,
		attachments,
		auth: results && authResults(results),
		sender,
		check,
		labels: job.subaddress ? [labelFromTag(job.subaddress)] : [],
	};

	const delivered = await mailbox
		.ingest(input)
		.then(
			(result) => ({ result }),
			(error: unknown) => ({ error }),
		);
	// Deleted since the check above. Its deletion may have cleared the mailbox before this reached it (the mailbox then
	// refuses it), or after, so clear it either way.
	if (!(await mailboxExists(env.DIRECTORY, job.mailboxId))) return clearGone(env, job);
	if ("error" in delivered) throw delivered.error;
	console.log(JSON.stringify({ msg: "ingested", ingestId: job.ingestId, mailboxId: job.mailboxId, ...delivered.result }));
	if ("threadId" in delivered.result && delivered.result.inbox) {
		// The mail is in, so a failure is logged rather than retried: a retry would find it delivered and notify nobody.
		await notifyNewMail(env, job.mailboxId, delivered.result.threadId, input).catch((error: unknown) =>
			console.error(JSON.stringify({ msg: "push failed", ingestId: job.ingestId, mailboxId: job.mailboxId, error: String(error) })),
		);
	}
}

/**
 * A failed check queues the job again, counting the failure, until the last try, which delivers the mail as unchecked
 * instead. If queueing it fails, this throws and the queue retries the job as it was.
 */
async function checkOrGiveUp(env: Env, models: Models, facts: MailFacts, job: InboundJob): Promise<MailCheck | "requeued"> {
	try {
		return await checkMail(models, facts);
	} catch (error) {
		const failures = (job.checkFailures ?? 0) + 1;
		if (failures < CHECK_ATTEMPTS) {
			console.error(JSON.stringify({ msg: "mail check failed", ingestId: job.ingestId, mailboxId: job.mailboxId, failures, error: String(error) }));
			await env.INBOUND.send({ ...job, checkFailures: failures }, { delaySeconds: 30 * 2 ** (failures - 1) });
			return "requeued";
		}
		console.error(JSON.stringify({ msg: "mail unchecked", ingestId: job.ingestId, mailboxId: job.mailboxId, error: String(error) }));
		return { kind: "unchecked", error: String(error).slice(0, MAX_CHECK_ERROR) };
	}
}

/**
 * Lists mail the queue gave up on under its mailbox's Failed, where someone can retry, download, or delete it. Like
 * ingest(), it clears a mailbox deleted before or while this runs instead.
 */
export async function recordFailed(env: Env, job: InboundJob, error: string | null): Promise<void> {
	if (!(await mailboxExists(env.DIRECTORY, job.mailboxId))) return clearGone(env, job);
	await env.MAILBOX.getByName(job.mailboxId).recordFailed(job, error);
	if (!(await mailboxExists(env.DIRECTORY, job.mailboxId))) return clearGone(env, job);
	console.error(JSON.stringify({ msg: "mail failed", ingestId: job.ingestId, mailboxId: job.mailboxId, rawKey: job.rawKey, error }));
}

/**
 * For a mailbox deleted before or while its mail was delivered: clears what delivering it left (the mailbox's files and
 * storage, which destroy() takes any number of times), and the original if no other mailbox is due it.
 */
async function clearGone(env: Env, job: InboundJob): Promise<void> {
	await env.MAILBOX.getByName(job.mailboxId).destroy();
	await dropOriginal(env, job.rawKey);
	console.log(JSON.stringify({ msg: "mailbox gone", ingestId: job.ingestId, mailboxId: job.mailboxId }));
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

/** Who stamps the verdicts we trust: Email Routing's MX. */
const AUTHSERV_ID = "mx.cloudflare.net";

type AuthResult = { method: string; result: string; props: Map<string, string> };

/**
 * The SPF, DKIM, and DMARC verdicts Email Routing stamped on the message. (It already rejects mail that fails a DMARC
 * reject policy, and mail from RBL-listed IPs.) Only its own header counts. It prepends its trace headers, ending with
 * X-CF-SpamH-Score, so anything below that came from the sender and can claim anything, and it doesn't always stamp
 * one (workerd#6740).
 */
function stampedResults(email: Email): AuthResult[] | null {
	const end = email.headers.findIndex((h) => h.key === "x-cf-spamh-score");
	const header = email.headers
		.slice(0, Math.max(end, 0))
		.find((h) => h.key === "authentication-results" && h.value.split(";")[0]?.trim().toLowerCase() === AUTHSERV_ID);
	return header ? resultsOf(header.value) : null;
}

/** For display. */
function authResults(results: AuthResult[]): AuthResults {
	const dkim = results.filter((r) => r.method === "dkim");
	return {
		// The envelope sender's. A result for the HELO name says nothing about who sent it.
		spf: results.find((r) => r.method === "spf" && r.props.has("smtp.mailfrom"))?.result ?? null,
		// Mail can carry several signatures; one that verifies is what counts.
		dkim: dkim.find((r) => r.result === "pass")?.result ?? dkim[0]?.result ?? null,
		dmarc: results.find((r) => r.method === "dmarc")?.result ?? null,
	};
}

/**
 * Who the mail is verifiably from, for Mailbox.ingest() to trust or distrust. The From address counts as verified
 * when DMARC passed for its domain, or, for domains without a DMARC policy, when a DKIM signature or the envelope
 * sender's SPF passed for that domain or a parent of it (only its owner controls those; a child can belong to anyone
 * on a shared domain).
 */
async function checkSender(env: Env, address: string, results: AuthResult[] | null): Promise<SenderCheck> {
	const passed = (method: string) => results?.filter((r) => r.method === method && r.result === "pass") ?? [];
	const failed = (method: string) => results?.some((r) => r.method === method && r.result === "fail") ?? false;
	const spf = results?.find((r) => r.method === "spf" && r.props.has("smtp.mailfrom"));
	const spoofed = failed("dmarc") || (spf?.result === "fail" && passed("dkim").length === 0);
	const from = normalizeAddress(address);
	if (!isValidAddress(from)) return { verified: null, internal: false, spoofed };
	const domain = splitAddress(from).domain;
	const vouches = (d: string | undefined) => {
		const name = d?.toLowerCase().replace(/^.*@/, "");
		return name !== undefined && (domain === name || domain.endsWith(`.${name}`));
	};
	const verified =
		!spoofed &&
		(passed("dmarc").some((r) => r.props.get("header.from")?.toLowerCase() === domain) ||
			passed("dkim").some((r) => vouches(r.props.get("header.d"))) ||
			(spf?.result === "pass" && vouches(spf.props.get("smtp.mailfrom"))));
	if (!verified) return { verified: null, internal: false, spoofed };
	return { verified: from, internal: await isOwnAddress(env.DIRECTORY, stripSubaddress(from).base), spoofed };
}

/** RFC 8601: after the authserv-id, `method=result` then `ptype.property=value` pairs per `;`, with (comments) anywhere. */
function resultsOf(value: string): { method: string; result: string; props: Map<string, string> }[] {
	let text = value;
	// Innermost first, so nested comments go too.
	while (/\([^()]*\)/.test(text)) text = text.replaceAll(/\([^()]*\)/g, " ");
	return text
		.split(";")
		.slice(1)
		.flatMap((part) => {
			const [head, ...rest] = part.trim().split(/\s+/);
			const verdict = head?.match(/^([a-z0-9-]+)=([a-z]+)$/i);
			if (!verdict?.[1] || !verdict[2]) return [];
			const props = new Map(rest.flatMap((p) => {
				const at = p.indexOf("=");
				return at > 0 ? [[p.slice(0, at).toLowerCase(), p.slice(at + 1)] as const] : [];
			}));
			return [{ method: verdict[1].toLowerCase(), result: verdict[2].toLowerCase(), props }];
		});
}

/**
 * An HTML body's text as the app shows it, for the checks: elements hidden by their own style or `hidden` attribute are
 * dropped, so hidden padding can't push what the recipient sees past what the models read. (Hiding by a stylesheet
 * class isn't caught.)
 */
async function visibleText(html: string): Promise<string> {
	const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|(?:font-size|opacity|max-height|max-width)\s*:\s*0(?![.\d])/i;
	const shown = await new HTMLRewriter()
		.on("*", {
			element(el) {
				if (el.hasAttribute("hidden") || hidden.test(el.getAttribute("style") ?? "")) el.remove();
			},
		})
		.transform(new Response(html))
		.text();
	return htmlToText(shown);
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
