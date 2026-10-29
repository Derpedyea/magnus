import { type HeldAddress, type InboundJob, r2Keys, stripSubaddress, ulid } from "#shared";
import { decodeWords } from "postal-mime";

// Moving a domain's mail here before every address it gets mail at is added would bounce the rest. So for the first
// 30 days after a domain starts receiving here (domains.receiving_since), mail to an address it doesn't have yet is
// held instead: the original in R2, a row in held_mail. Adding the address delivers it, an admin can deliver it
// somewhere else or discard it, and the hourly cron deletes what's left when the window ends. Senders aren't told
// either way, so nothing goes back to them (no backscatter).

export const HOLD_WINDOW_MS = 30 * 24 * 3600_000;
/** Held for one domain at once, so guesses at addresses can't pile up without end. Past it, mail is rejected again. */
export const HOLD_LIMIT = 1000;
const MAX_SUBJECT_LENGTH = 200;
/** Jobs per sendBatch, Queues' limit. */
const QUEUE_BATCH = 100;

export interface Hold {
	/** Without its +tag. */
	address: string;
	domain: string;
	expiresAt: number;
}

/** Keeps mail to an address not added yet. Runs inside the SMTP session: a failure throws, and the sender retries. */
export async function holdMail(env: Env, message: ForwardableEmailMessage, hold: Hold, sender: string): Promise<void> {
	const receivedAt = Date.now();
	const id = ulid(receivedAt);
	const rawKey = r2Keys.held(id);
	// message.raw is single-use; buffer once (inbound is capped at 25 MiB).
	const raw = await new Response(message.raw).arrayBuffer();
	await env.MAIL.put(rawKey, raw, { httpMetadata: { contentType: "message/rfc822" }, customMetadata: { envelopeFrom: message.from, envelopeTo: message.to } });
	const subject = decodeWords(message.headers.get("subject") ?? "").slice(0, MAX_SUBJECT_LENGTH);
	await env.DIRECTORY.prepare(
		`INSERT INTO held_mail (id, address, domain, envelope_from, envelope_to, sender, subject, raw_key, raw_size, received_at, expires_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
	)
		.bind(id, hold.address, hold.domain, message.from, message.to, sender, subject, rawKey, message.rawSize, receivedAt, hold.expiresAt)
		.run();
	console.log(JSON.stringify({ msg: "held", ingestId: id, to: message.to, size: message.rawSize }));
}

/**
 * Queues mail held for `address` to the mailboxes given, or else those it delivers to now, as if it had just arrived
 * (ingest() skips a message it already has, so releasing twice is harmless). How many it released.
 */
export async function releaseHeld(env: Env, address: string, mailboxIds?: string[]): Promise<number> {
	const to = mailboxIds ?? (await deliversTo(env.DIRECTORY, address));
	if (to.length === 0) return 0;
	const { results } = await env.DIRECTORY.prepare(
		`SELECT id, envelope_from, envelope_to, raw_key, raw_size, received_at FROM held_mail WHERE address = ?1`,
	)
		.bind(address)
		.all<{ id: string; envelope_from: string; envelope_to: string; raw_key: string; raw_size: number; received_at: number }>();
	const jobs = results.flatMap((row) =>
		to.map(
			(mailboxId): InboundJob => ({
				v: 1,
				ingestId: row.id,
				rawKey: row.raw_key,
				rawSize: row.raw_size,
				mailboxId,
				envelopeFrom: row.envelope_from,
				envelopeTo: row.envelope_to,
				subaddress: stripSubaddress(row.envelope_to).tag,
				receivedAt: row.received_at,
			}),
		),
	);
	for (let i = 0; i < jobs.length; i += QUEUE_BATCH) await env.INBOUND.sendBatch(jobs.slice(i, i + QUEUE_BATCH).map((body) => ({ body })));
	// Only what was queued: mail held meanwhile waits for the next release.
	await forget(env.DIRECTORY, results.map((r) => r.id));
	if (results.length > 0) console.log(JSON.stringify({ msg: "released held mail", address, count: results.length, mailboxes: to }));
	return results.length;
}

/** Deletes mail held for `address` for good. */
export async function discardHeld(env: Env, address: string): Promise<void> {
	const { results } = await env.DIRECTORY.prepare(`SELECT id, raw_key FROM held_mail WHERE address = ?1`).bind(address).all<{ id: string; raw_key: string }>();
	await drop(env, results);
}

/**
 * The hourly cron: delivers mail whose address has been added since (releasing then failed, or it was added another
 * way), then deletes what's past its window.
 */
export async function cleanHeld(env: Env, now: number): Promise<void> {
	const { results: ready } = await env.DIRECTORY.prepare(
		`SELECT DISTINCT h.address FROM held_mail h JOIN addresses a ON a.address = h.address AND a.enabled = 1`,
	).all<{ address: string }>();
	for (const { address } of ready) await releaseHeld(env, address);
	for (;;) {
		const { results } = await env.DIRECTORY.prepare(`SELECT id, raw_key FROM held_mail WHERE expires_at <= ?1 LIMIT 1000`)
			.bind(now)
			.all<{ id: string; raw_key: string }>();
		await drop(env, results);
		if (results.length < 1000) return;
	}
}

/** Mail held per address for the admin pages, newest first. */
export async function heldAddresses(db: D1Database): Promise<HeldAddress[]> {
	const { results } = await db
		.prepare(
			`SELECT address, domain, sender, subject, received_at, count, expires_at FROM (
				SELECT address, domain, sender, subject, received_at,
					count(*) OVER (PARTITION BY address) AS count,
					min(expires_at) OVER (PARTITION BY address) AS expires_at,
					row_number() OVER (PARTITION BY address ORDER BY received_at DESC) AS n
				FROM held_mail
			) WHERE n = 1 ORDER BY received_at DESC`,
		)
		.all<{ address: string; domain: string; sender: string; subject: string; received_at: number; count: number; expires_at: number }>();
	return results.map((r) => ({
		address: r.address,
		domain: r.domain,
		count: r.count,
		newest: { sender: r.sender, subject: r.subject, receivedAt: r.received_at },
		expiresAt: r.expires_at,
	}));
}

/** The mailboxes an address delivers to, as resolveRecipient finds them. */
async function deliversTo(db: D1Database, address: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT r.mailbox_id FROM addresses a
			 JOIN address_routes r ON r.address = a.address
			 JOIN mailboxes m ON m.id = r.mailbox_id AND m.removed_with IS NULL
			 WHERE a.address = ?1 AND a.enabled = 1`,
		)
		.bind(address)
		.all<{ mailbox_id: string }>();
	return results.map((r) => r.mailbox_id);
}

/** The originals first: a row left behind is dropped again next time, but an original left behind nothing finds. */
async function drop(env: Env, rows: { id: string; raw_key: string }[]): Promise<void> {
	if (rows.length === 0) return;
	await env.MAIL.delete(rows.map((r) => r.raw_key));
	await forget(env.DIRECTORY, rows.map((r) => r.id));
}

async function forget(db: D1Database, ids: string[]): Promise<void> {
	if (ids.length > 0) await db.prepare(`DELETE FROM held_mail WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(ids)).run();
}
