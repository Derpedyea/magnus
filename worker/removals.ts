import { REMOVAL_DAYS } from "#shared";

/** How long after their removal a person is deleted for good. */
export const REMOVAL_MS = REMOVAL_DAYS * 24 * 3600_000;

// Removing a person (migrations/0007_removals.sql) works at once: their sessions end, they can't sign in (auth.ts),
// their memberships go, and the mailboxes only they could read refuse mail (resolveRecipient()), share no files
// (links.ts), and send nothing (Mailbox.alarm()). Nothing is deleted until REMOVAL_MS later, so restoring them
// before then brings it all back. Every write is one D1 batch whose statements check the removal is still there, so
// a restore and the purge that race each other can't both happen.

/** Whether an admin has removed this person. Better Auth asks before it makes any session for them. */
export async function isRemoved(db: D1Database, userId: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS hit FROM removed_people WHERE user_id = ?1`).bind(userId).first()) !== null;
}

/**
 * Removes a person, keeping what a restore needs. Removing someone already removed changes nothing, the date their mail
 * goes included. False if there's nobody by that id.
 */
export async function removePerson(env: Env, userId: string, now: number): Promise<boolean> {
	const db = env.DIRECTORY;
	await db.batch([
		db
			.prepare(
				`INSERT INTO removed_people (user_id, removed_at, memberships, passkeys, accounts)
				 SELECT ?1, ?2,
					(SELECT json_group_array(json_object('mailbox', mailbox_id, 'role', role)) FROM mailbox_members WHERE user_id = ?1),
					(SELECT json_group_array(id) FROM auth_passkeys WHERE userId = ?1),
					(SELECT json_group_array(id) FROM auth_accounts WHERE userId = ?1)
				 WHERE EXISTS (SELECT 1 FROM auth_users WHERE id = ?1)
				 ON CONFLICT (user_id) DO NOTHING`,
			)
			.bind(userId, now),
		// Read before their memberships go below.
		db
			.prepare(
				`UPDATE mailboxes SET removed_with = ?1 WHERE removed_with IS NULL AND id IN (
					SELECT mailbox_id FROM mailbox_members WHERE user_id = ?1
					AND mailbox_id NOT IN (SELECT mailbox_id FROM mailbox_members WHERE user_id != ?1))`,
			)
			.bind(userId),
		db.prepare(`DELETE FROM mailbox_members WHERE user_id = ?1`).bind(userId),
		// Reading mail needs a session that still exists, so this shuts them out at once, cookies and all (Reader in
		// directory.ts). Their browsers' push subscriptions go with the sessions.
		db.prepare(`DELETE FROM auth_sessions WHERE userId = ?1`).bind(userId),
	]);
	// Their open tabs would otherwise hear about changes until their socket's next sign-in check, in every mailbox they
	// were in, shared ones too. Done again by a repeated removal, so a failure here can be retried.
	const wereIn = await db
		.prepare(`SELECT json_extract(m.value, '$.mailbox') AS id FROM removed_people r, json_each(r.memberships) m WHERE r.user_id = ?1`)
		.bind(userId)
		.all<{ id: string }>();
	await Promise.all(wereIn.results.map((m) => env.MAILBOX.getByName(m.id).recheckSockets()));
	return isRemoved(db, userId);
}

/**
 * Puts a removed person back as they were: their memberships, and the mailboxes they're in, hidden by their removal or
 * by a later one of someone they shared it with. They sign in again, with the passkeys they had before it: the sessions
 * the removal ended stay ended, cookies and all (Reader in directory.ts), and nothing they added as it happened stays. Changes made meanwhile stay: an address removed or
 * given to someone else isn't brought back. False if they're gone for good (or never existed); true if they're here,
 * restored now or before.
 */
export async function restorePerson(db: D1Database, userId: string): Promise<boolean> {
	// Sign-in methods they didn't have when removed: a request checked just before the removal can finish after it, and
	// what it added shouldn't outlive the removal. Only with a removal to compare against, or every one would go.
	const added = (table: string, column: string) =>
		db
			.prepare(
				`DELETE FROM ${table} WHERE userId = ?1 AND EXISTS (SELECT 1 FROM removed_people WHERE user_id = ?1)
				 AND id NOT IN (SELECT m.value FROM removed_people r, json_each(r.${column}) m WHERE r.user_id = ?1)`,
			)
			.bind(userId);
	await db.batch([
		added("auth_passkeys", "passkeys"),
		added("auth_accounts", "accounts"),
		db
			.prepare(
				`INSERT INTO mailbox_members (mailbox_id, user_id, role)
				 SELECT json_extract(m.value, '$.mailbox'), r.user_id, json_extract(m.value, '$.role')
				 FROM removed_people r, json_each(r.memberships) m
				 WHERE r.user_id = ?1 AND json_extract(m.value, '$.mailbox') IN (SELECT id FROM mailboxes)
				 ON CONFLICT DO NOTHING`,
			)
			.bind(userId),
		db
			.prepare(
				`UPDATE mailboxes SET removed_with = NULL WHERE removed_with = ?1
				 OR id IN (SELECT json_extract(m.value, '$.mailbox') FROM removed_people r, json_each(r.memberships) m WHERE r.user_id = ?1)`,
			)
			.bind(userId),
		db.prepare(`DELETE FROM removed_people WHERE user_id = ?1`).bind(userId),
	]);
	return (await db.prepare(`SELECT 1 AS hit FROM auth_users WHERE id = ?1`).bind(userId).first()) !== null;
}

/**
 * Hourly: deletes everyone removed REMOVAL_MS ago or more, as removal used to at once: the person, the mailboxes
 * their removal hid, and the addresses only those received. Then deletes the mail of every mailbox that's gone.
 */
export async function purgeRemoved(env: Env, now: number): Promise<void> {
	const db = env.DIRECTORY;
	const cutoff = now - REMOVAL_MS;
	const { results } = await db.prepare(`SELECT user_id FROM removed_people WHERE removed_at <= ?1`).bind(cutoff).all<{ user_id: string }>();
	// Each independent of the others, and the mail of anyone done before still goes. Whatever fails is due again next hour.
	const purged = await Promise.allSettled(results.map(({ user_id }) => purgePerson(db, user_id, now)));
	const deleted = await Promise.allSettled([deleteMailboxObjects(env)]);
	const failed = [...purged, ...deleted].flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
	if (failed.length > 0) throw new AggregateError(failed, `Removal purge failed: ${failed.map(String).join("; ")}`);
}

/**
 * Deletes one person removed REMOVAL_MS before `now` or earlier, leaving their mail for deleteMailboxObjects(). Each
 * statement checks they're still removed and due, so someone restored (or removed again) since they were picked is left
 * alone, as is anyone whose mailbox is being restored to an earlier time (worker/restore.ts): that waits for the next
 * hour, rather than bring back mail the purge deleted. The person goes last, since their removal row goes with them.
 */
export async function purgePerson(db: D1Database, userId: string, now: number): Promise<void> {
	const cutoff = now - REMOVAL_MS;
	const due = `EXISTS (SELECT 1 FROM removed_people WHERE user_id = ?1 AND removed_at <= ?2)
		AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE removed_with = ?1 AND coalesce(restoring_until, 0) > ?3)`;
	// Never one somebody's in. A restore takes the mailboxes it gives back out of hiding; this holds even if one didn't.
	const hidden = `SELECT id FROM mailboxes WHERE removed_with = ?1 AND NOT EXISTS (SELECT 1 FROM mailbox_members WHERE mailbox_id = mailboxes.id)`;
	await db.batch([
		db.prepare(`INSERT INTO mailbox_deletions (mailbox_id) ${hidden} AND ${due} ON CONFLICT DO NOTHING`).bind(userId, cutoff, now),
		db
			.prepare(
				`DELETE FROM addresses WHERE ${due}
				 AND address IN (SELECT address FROM address_routes WHERE mailbox_id IN (${hidden}))
				 AND address NOT IN (SELECT address FROM address_routes WHERE mailbox_id NOT IN (${hidden}))`,
			)
			.bind(userId, cutoff, now),
		db.prepare(`DELETE FROM mailboxes WHERE id IN (${hidden}) AND ${due}`).bind(userId, cutoff, now),
		// Their sessions, sign-in methods, signatures, and drafts go with them.
		db.prepare(`DELETE FROM auth_users WHERE id = ?1 AND ${due}`).bind(userId, cutoff, now),
	]);
}

/** How many gone mailboxes' mail one run deletes. The rest wait for the next. */
const DELETIONS_PER_RUN = 20;

/**
 * Deletes the Durable Object and R2 objects of mailboxes gone from the directory (mailbox_deletions). A row goes only
 * once its mailbox is empty, so one that fails, or a crash partway, is tried again next hour. Mail still queued for one
 * finds no mailbox in the directory and is dropped (ingest()), so nothing brings it back.
 */
export async function deleteMailboxObjects(env: Env): Promise<void> {
	const { results } = await env.DIRECTORY.prepare(`SELECT mailbox_id FROM mailbox_deletions LIMIT ?1`).bind(DELETIONS_PER_RUN).all<{ mailbox_id: string }>();
	const done = await Promise.allSettled(
		results.map(async ({ mailbox_id }) => {
			await env.MAILBOX.getByName(mailbox_id).destroy();
			await env.DIRECTORY.prepare(`DELETE FROM mailbox_deletions WHERE mailbox_id = ?1`).bind(mailbox_id).run();
		}),
	);
	const failed = done.flatMap((d) => (d.status === "rejected" ? [d.reason] : []));
	if (failed.length > 0) throw new AggregateError(failed, `${failed.length} mailbox deletions failed; retried next hour`);
}
