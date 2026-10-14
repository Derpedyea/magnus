import { type InboundJob, r2Keys, stripSubaddress, ulid, ulidTime } from "#shared";
import { INGEST_WINDOW_MS } from "./mailbox/mailbox";

// Restores one mailbox to how it was at an earlier moment, with Cloudflare's point-in-time recovery of its Durable Object
// (Mailbox.prepareRestore() and on), then queues again the mail it should have and doesn't. docs/RESTORE.md has the
// runbook.

/** How far back Cloudflare can restore a Durable Object: "any point in time in the past 30 days". */
export const RESTORE_WINDOW_MS = 30 * 24 * 3600_000;

/** How long a restore holds its mailbox against another (restoring_until): long past any restore, in case one dies. */
const LEASE_MS = 10 * 60_000;

/** Where to restore to: a moment, or for undoing a restore, the bookmark it returned (with the moment it was taken). */
export interface RestoreTarget {
	at: number;
	bookmark: string | null;
}

export type RestoreResult =
	| { kind: "missing" }
	| { kind: "busy" }
	| {
			kind: "done";
			/** Restore to this to undo this restore. */
			undo: RestoreTarget;
			/** Outbox messages it brought back, failed for their sender to send again if they didn't go. */
			held: number;
			/** Files the mailbox shared by link, now stopped. */
			linksStopped: number;
			/** Mail it should have and didn't, queued again (replayMail()). */
			replayed: number;
			/** Originals since that don't say which mailboxes they were for, so weren't queued. */
			unknown: number;
	  };

/**
 * Restores the mailbox to the target, one restore at a time. Running it again with the same target ends the same way,
 * so a failure partway is retried by restoring again.
 */
export async function restoreMailbox(env: Env, mailboxId: string, target: RestoreTarget): Promise<RestoreResult> {
	const db = env.DIRECTORY;
	const restoreId = ulid();
	const now = Date.now();
	const claimed = await db
		.prepare(`UPDATE mailboxes SET restoring = ?2, restoring_until = ?3 WHERE id = ?1 AND coalesce(restoring_until, 0) < ?4`)
		.bind(mailboxId, restoreId, now + LEASE_MS, now)
		.run();
	if (claimed.meta.changes !== 1) {
		const exists = await db.prepare(`SELECT 1 AS ok FROM mailboxes WHERE id = ?1`).bind(mailboxId).first();
		return { kind: exists ? "busy" : "missing" };
	}
	const release = async () => db.prepare(`UPDATE mailboxes SET restoring = NULL, restoring_until = NULL WHERE id = ?1 AND restoring = ?2`).bind(mailboxId, restoreId).run();
	// Should letting go fail, the claim runs out by itself (LEASE_MS), so what the restore did (its undo above all) is
	// answered either way.
	const letGo = () =>
		release().catch((error: unknown) => console.error(JSON.stringify({ msg: "restore lease kept until it runs out", mailboxId, error: String(error) })));
	try {
		const result = await restoreClaimed(env, mailboxId, restoreId, target);
		await letGo();
		return result;
	} catch (error) {
		await letGo();
		throw error;
	}
}

async function restoreClaimed(env: Env, mailboxId: string, restoreId: string, target: RestoreTarget): Promise<RestoreResult> {
	const undoAt = Date.now();
	// A fresh stub for every call: one whose object reset can't be used again.
	const mailbox = () => env.MAILBOX.getByName(mailboxId);
	const bookmark = await mailbox().prepareRestore(target.at, target.bookmark, restoreId);
	// Named before it's armed, so the object applies the restore from its first moment restored, even if Cloudflare
	// restarts it before restart() does. The state from before still works as usual: it's marked pending.
	const named = await env.DIRECTORY.prepare(`UPDATE mailboxes SET restore_id = ?2 WHERE id = ?1 AND restoring = ?2`).bind(mailboxId, restoreId).run();
	if (named.meta.changes !== 1) throw new Error("Lost hold of the mailbox before restoring it. Restore again.");
	const undo = { at: undoAt, bookmark: await mailbox().armRestore(bookmark) };
	// From here the mailbox may be rewound, so a failure still answers with the way back (RestoreIncomplete).
	try {
		// The reset makes this call fail. finishRestore() checks the restore took, and gives this error if it didn't.
		const restart = await mailbox().restart().then(
			() => null,
			(error: unknown) => error,
		);
		const applied = await mailbox().finishRestore(restoreId);
		if (!applied) throw new Error("The mailbox didn't restart into the restore. Restore again.", { cause: restart });
		// A draft caught mid-send still says so in D1, but the restore took away the mailbox's record of that send, so
		// retrying it would send it again. It goes back to being a draft, with a new revision: the retry fails, and its
		// sender decides.
		await env.DIRECTORY.prepare(`UPDATE drafts SET state = 'active', revision = revision + 1, send_id = NULL WHERE mailbox_id = ?1 AND state = 'sending'`)
			.bind(mailboxId)
			.run();
		return { kind: "done", undo, ...applied, ...(await replayMail(env, mailboxId, target.at)) };
	} catch (error) {
		throw new RestoreIncomplete(undo, error);
	}
}

/** A restore that failed once the mailbox may have been rewound. `undo` still undoes it; restoring again finishes it. */
export class RestoreIncomplete extends Error {
	constructor(
		readonly undo: RestoreTarget,
		cause: unknown,
	) {
		super(`The restore didn't finish: ${cause instanceof Error ? cause.message : String(cause)} Restore again to finish it.`, { cause });
	}
}

/** Queue messages per send: the most sendBatch takes. */
const QUEUE_BATCH = 100;
/** Ids asked of the mailbox at once (Mailbox.holding()). */
const HOLDING_BATCH = 500;

/**
 * Queues again the originals under raw/ that this mailbox should have but, restored, doesn't: anything received since
 * `since`, and anything received in the day before that, which can have been taken in after it (the inbound queue
 * retries for up to INGEST_WINDOW_MS). Mail imported from elsewhere isn't kept under raw/: importing it again brings it
 * back.
 */
async function replayMail(env: Env, mailboxId: string, since: number): Promise<{ replayed: number; unknown: number }> {
	const candidates: InboundJob[] = [];
	let unknown = 0;
	const from = since - INGEST_WINDOW_MS;
	for (let day = new Date(from).setUTCHours(0, 0, 0, 0); day <= Date.now(); day += 24 * 3600_000) {
		let cursor: string | undefined;
		do {
			// "If include is set, you may receive fewer than limit results", so it's read to the end by cursor.
			const page = await env.MAIL.list({ prefix: r2Keys.rawDay(day), cursor, include: ["customMetadata"] });
			for (const obj of page.objects) {
				const ingestId = obj.key.slice(obj.key.lastIndexOf("/") + 1, -".eml".length);
				const receivedAt = ulidTime(ingestId);
				if (receivedAt < from) continue;
				const meta = obj.customMetadata;
				if (!meta?.mailboxes || meta.envelopeFrom === undefined || meta.envelopeTo === undefined) {
					if (receivedAt >= since) unknown++;
					continue;
				}
				if (!meta.mailboxes.split(",").includes(mailboxId)) continue;
				candidates.push({
					v: 1,
					ingestId,
					rawKey: obj.key,
					rawSize: obj.size,
					mailboxId,
					envelopeFrom: meta.envelopeFrom,
					envelopeTo: meta.envelopeTo,
					subaddress: stripSubaddress(meta.envelopeTo).tag,
					receivedAt,
				});
			}
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
	}
	// Only what it doesn't have (or hasn't listed under Failed), so nothing it has is parsed or checked again.
	const held = new Set<string>();
	for (let i = 0; i < candidates.length; i += HOLDING_BATCH) {
		for (const id of await env.MAILBOX.getByName(mailboxId).holding(candidates.slice(i, i + HOLDING_BATCH).map((j) => j.ingestId))) held.add(id);
	}
	const jobs = candidates.filter((j) => !held.has(j.ingestId));
	for (let i = 0; i < jobs.length; i += QUEUE_BATCH) await env.INBOUND.sendBatch(jobs.slice(i, i + QUEUE_BATCH).map((body) => ({ body })));
	return { replayed: jobs.length, unknown };
}
