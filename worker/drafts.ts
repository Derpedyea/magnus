import { DraftSchema, type DraftWrite, type SavedDraft } from "#shared/drafts";
import type { SendQueued } from "#shared";
import { live, type Reader } from "./directory";

interface DraftRow {
	id: string;
	user_id: string;
	mailbox_id: string;
	content: string;
	revision: number;
	change_id: string;
	updated_at: number;
	state: "active" | "sending" | "sent" | "deleted";
	send_id: string | null;
	queued: string | null;
}

export async function readDraft(db: D1Database, userId: string, id: string) {
	return db.prepare(`SELECT * FROM drafts WHERE id = ?1 AND user_id = ?2`).bind(id, userId).first<DraftRow>();
}

export function toSavedDraft(row: DraftRow): SavedDraft {
	if (row.state !== "active" && row.state !== "sending") throw new Error("Draft is no longer editable");
	return { id: row.id, revision: row.revision, changeId: row.change_id, updatedAt: row.updated_at, content: DraftSchema.parse(JSON.parse(row.content)), state: row.state };
}

export async function listDrafts(db: D1Database, reader: Reader) {
	const { results } = await db.prepare(`SELECT d.* FROM drafts d
		WHERE user_id = ?1 AND state IN ('active', 'sending') AND ${live("?2", "?1")}
		AND EXISTS (SELECT 1 FROM mailbox_members m WHERE m.mailbox_id = d.mailbox_id AND m.user_id = ?1)
		ORDER BY updated_at DESC, id DESC`).bind(reader.userId, reader.sessionId).all<DraftRow>();
	return results.map(toSavedDraft);
}

/**
 * Compare-and-swap plus a stable change id: a lost response can be retried without creating another revision. The
 * session has to still exist when it's written, as checking it earlier proves nothing after the awaits in between.
 */
export async function saveDraft(db: D1Database, reader: Reader, id: string, write: DraftWrite, now: number) {
	const userId = reader.userId;
	const content = JSON.stringify(write.content);
	// In the write statement itself, so cleanup cannot claim a file between validation and persistence.
	const availableFiles = `NOT EXISTS (SELECT 1 FROM json_each(?4, '$.attachments') a
		WHERE NOT EXISTS (SELECT 1 FROM draft_files f WHERE f.r2_key = json_extract(a.value, '$.r2Key')
			AND f.user_id = ?2 AND f.mailbox_id = ?3 AND f.deleting = 0))
		AND EXISTS (SELECT 1 FROM mailbox_members WHERE user_id = ?2 AND mailbox_id = ?3) AND ${live("?8", "?2")}`;
	await db.prepare(`INSERT INTO drafts (id, user_id, mailbox_id, content, revision, change_id, updated_at)
		SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6 WHERE ${availableFiles}
		AND (?7 = 0 OR EXISTS (SELECT 1 FROM drafts WHERE id = ?1 AND user_id = ?2))
		ON CONFLICT (id) DO UPDATE SET mailbox_id = excluded.mailbox_id, content = excluded.content,
			revision = drafts.revision + 1, change_id = excluded.change_id, updated_at = excluded.updated_at
		WHERE drafts.user_id = ?2 AND drafts.state = 'active' AND drafts.revision = ?7 AND drafts.change_id != ?5
		AND ${availableFiles}`)
		.bind(id, userId, write.content.mailboxId, content, write.changeId, now, write.revision, reader.sessionId).run();
	const row = await readDraft(db, userId, id);
	return row?.state === "active" && row.change_id === write.changeId && row.content === content ? toSavedDraft(row) : null;
}

/**
 * A tombstone, not a physical delete: neither retries nor another device can resurrect this id. Checks the session and
 * membership in the write itself, as saveDraft() does.
 */
export async function discardDraft(db: D1Database, reader: Reader, id: string, revision: number) {
	await db.prepare(`UPDATE drafts SET state = 'deleted', content = '{}', revision = revision + 1
		WHERE id = ?1 AND user_id = ?2 AND revision = ?3 AND state = 'active' AND ${live("?4", "?2")}
		AND EXISTS (SELECT 1 FROM mailbox_members m WHERE m.mailbox_id = drafts.mailbox_id AND m.user_id = ?2)`)
		.bind(id, reader.userId, revision, reader.sessionId).run();
	const row = await readDraft(db, reader.userId, id);
	return row?.state === "deleted";
}

export async function claimDraft(db: D1Database, userId: string, id: string, revision: number, sendId: string) {
	await db.prepare(`UPDATE drafts SET state = 'sending', send_id = ?4
		WHERE id = ?1 AND user_id = ?2 AND revision = ?3 AND state = 'active'`).bind(id, userId, revision, sendId).run();
	const row = await readDraft(db, userId, id);
	return row?.revision === revision && (row.state === "sending" || row.state === "sent") ? row : null;
}

/** Marks a draft sent, if it's still claimed by this send: a restore can have put it back since (worker/restore.ts). */
export async function finishDraftSend(db: D1Database, userId: string, id: string, sendId: string, queued: SendQueued) {
	await db.prepare(`UPDATE drafts SET state = 'sent', content = '{}', queued = ?3 WHERE id = ?1 AND user_id = ?2 AND state = 'sending' AND send_id = ?4`)
		.bind(id, userId, JSON.stringify(queued), sendId).run();
}

/** Makes a draft whose send was refused a draft again, if it's still claimed by that send and not another since. */
export async function releaseDraft(db: D1Database, userId: string, id: string, sendId: string) {
	await db.prepare(`UPDATE drafts SET state = 'active', send_id = NULL WHERE id = ?1 AND user_id = ?2 AND state = 'sending' AND send_id = ?3`)
		.bind(id, userId, sendId).run();
}

/** Hourly, bounded cleanup. Failed deletions retain their row and are retried on the next run. */
export async function cleanDraftFiles(env: Env, now: number) {
	const { results } = await env.DIRECTORY.prepare(`SELECT f.r2_key, f.mailbox_id FROM draft_files f WHERE created_at < ?1
		AND NOT EXISTS (SELECT 1 FROM drafts d, json_each(d.content, '$.attachments') a
			WHERE d.state IN ('active', 'sending') AND json_extract(a.value, '$.r2Key') = f.r2_key) LIMIT 100`)
		.bind(now - 24 * 3600_000).all<{ r2_key: string; mailbox_id: string }>();
	for (const file of results) {
		const claimed = await env.DIRECTORY.prepare(`UPDATE draft_files SET deleting = 1 WHERE r2_key = ?1
			AND NOT EXISTS (SELECT 1 FROM drafts d, json_each(d.content, '$.attachments') a
				WHERE d.state IN ('active', 'sending') AND json_extract(a.value, '$.r2Key') = ?1) RETURNING r2_key`)
			.bind(file.r2_key).first();
		if (!claimed) continue;
		// Queued/failed sends can still need the original before the outbox has made its own permanent copy.
		if (await env.MAILBOX.getByName(file.mailbox_id).holdsFile(file.r2_key)) {
			await env.DIRECTORY.prepare(`UPDATE draft_files SET deleting = 0 WHERE r2_key = ?1`).bind(file.r2_key).run();
			continue;
		}
		await env.MAIL.delete(file.r2_key);
		await env.DIRECTORY.prepare(`DELETE FROM draft_files WHERE r2_key = ?1`).bind(file.r2_key).run();
	}
}
