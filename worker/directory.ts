import {
	type Directory,
	escapeMarkdown,
	type MailboxMembership,
	normalizeAddress,
	splitAddress,
	stripSubaddress,
	ulid,
	type User,
} from "#shared";
import { REMOVAL_MS } from "./removals";
import { hasCloudflareToken } from "./settings";

// Typed queries over the D1 directory (migrations/0001_init.sql): who can sign in, which domains and addresses
// exist, and which mailbox each address delivers to. People are Better Auth's auth_users.

export type RecipientResolution =
	| { kind: "deliver"; mailboxIds: string[]; subaddress: string | null }
	| { kind: "reject"; reason: string };

/**
 * Decide at SMTP time what happens to an envelope recipient.
 * Rejecting here (instead of accepting and bouncing later) avoids backscatter.
 * `senders` are the envelope sender and the From header's addresses, and a block on any refuses the message:
 * bulk mail carries its sending service's bounce address on the envelope, so only the header (which the app
 * shows and blocks) names who it's from.
 */
export async function resolveRecipient(db: D1Database, senders: string[], envelopeTo: string): Promise<RecipientResolution> {
	const { base, tag } = stripSubaddress(envelopeTo);
	const { domain } = splitAddress(base);
	// Each sender, and everyone at its domain. A bounce's envelope sender is empty.
	const blocks = senders.map(normalizeAddress).filter((s) => s.includes("@")).flatMap((s) => [s, `*@${splitAddress(s).domain}`]);

	// A removed person's mailboxes (worker/removals.ts) take nothing.
	const [routes, dom, blocked] = await Promise.all([
		db
			.prepare(
				`SELECT r.mailbox_id, m.removed_with IS NOT NULL AS removed FROM addresses a
				 JOIN address_routes r ON r.address = a.address
				 JOIN mailboxes m ON m.id = r.mailbox_id
				 WHERE a.address = ?1 AND a.enabled = 1`,
			)
			.bind(base)
			.all<{ mailbox_id: string; removed: number }>(),
		db
			.prepare(
				`SELECT d.receiving, m.id AS catch_all_mailbox_id FROM domains d
				 LEFT JOIN mailboxes m ON m.id = d.catch_all_mailbox_id AND m.removed_with IS NULL
				 WHERE d.name = ?1`,
			)
			.bind(domain)
			.first<{ receiving: number; catch_all_mailbox_id: string | null }>(),
		db.prepare(`SELECT 1 AS hit FROM sender_blocks WHERE pattern IN (SELECT value FROM json_each(?1)) LIMIT 1`).bind(JSON.stringify(blocks)).first(),
	]);

	if (blocked) return { kind: "reject", reason: "5.7.1 Sender blocked" };
	if (!dom || dom.receiving !== 1) return { kind: "reject", reason: "5.1.2 Domain not handled here" };

	const mailboxIds = routes.results.filter((r) => r.removed === 0).map((r) => r.mailbox_id);
	if (mailboxIds.length > 0) return { kind: "deliver", mailboxIds, subaddress: tag };
	// Theirs alone: refused rather than left to the catch-all, so nobody else gets their mail while they can be restored.
	if (routes.results.length > 0) return { kind: "reject", reason: "5.1.1 Mailbox unavailable" };
	if (dom.catch_all_mailbox_id) return { kind: "deliver", mailboxIds: [dom.catch_all_mailbox_id], subaddress: tag };
	return { kind: "reject", reason: "5.1.1 Mailbox unavailable" };
}

/** For the local-dev sign-in bypass; real requests take the user from their session. */
export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
	const row = await db
		.prepare(`SELECT id, email, name, role FROM auth_users WHERE email = ?1 AND NOT coalesce(banned, 0)`)
		.bind(email.toLowerCase())
		.first<{ id: string; email: string; name: string; role: string | null }>();
	return row ? { id: row.id, email: row.email, name: row.name, isAdmin: row.role === "admin" } : null;
}

/**
 * Who a request is from: the person, and the session it came with. A session cookie vouches for itself for a while
 * without asking D1, and Better Auth renews it from that alone (get-session), so a session that's been ended (signed
 * out elsewhere, suspended, removed) can stay signed in. Reading mail asks D1 too: every query of a request's mailboxes
 * checks its session still exists.
 */
export interface Reader {
	userId: string;
	sessionId: string;
}

/** SQL: the session in parameter `session` still exists, belongs to the person in `user`, and hasn't expired. */
export const live = (session: string, user: string) =>
	`EXISTS (SELECT 1 FROM auth_sessions s WHERE s.id = ${session} AND s.userId = ${user} AND s.expiresAt > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

/**
 * SQL: the person in parameter `user` is an admin now, not suspended, and signed in with the session in parameter
 * `session`. Suspending marks them before their sessions go, so both are asked.
 */
export const liveAdmin = (session: string, user: string) =>
	`EXISTS (SELECT 1 FROM auth_users a WHERE a.id = ${user} AND a.role = 'admin' AND coalesce(a.banned, 0) = 0 AND ${live(session, user)})`;

export async function getUserMailboxes(db: D1Database, reader: Reader): Promise<MailboxMembership[]> {
	const [mailboxes, addresses] = await Promise.all([
		db
			.prepare(
				`SELECT m.id, m.name, mm.role FROM mailbox_members mm
				 JOIN mailboxes m ON m.id = mm.mailbox_id
				 WHERE mm.user_id = ?1 AND ${live("?2", "?1")} ORDER BY m.created_at`,
			)
			.bind(reader.userId, reader.sessionId)
			.all<Omit<MailboxMembership, "addresses">>(),
		db
			.prepare(
				`SELECT r.mailbox_id, a.address, a.display_name, a.enabled, r.can_send AND d.sending AS can_send, s.text AS signature, s.markdown
				 FROM mailbox_members mm
				 JOIN address_routes r ON r.mailbox_id = mm.mailbox_id
				 JOIN addresses a ON a.address = r.address
				 JOIN domains d ON d.name = a.domain
				 LEFT JOIN signatures s ON s.user_id = mm.user_id AND s.address = a.address
				 WHERE mm.user_id = ?1 AND ${live("?2", "?1")} ORDER BY a.created_at, a.rowid`,
			)
			.bind(reader.userId, reader.sessionId)
			.all<{ mailbox_id: string; address: string; display_name: string | null; enabled: number; can_send: number; signature: string | null; markdown: number | null }>(),
	]);
	return mailboxes.results.map((m) => ({
		...m,
		disabled: addresses.results.filter((a) => a.mailbox_id === m.id && a.enabled !== 1).map((a) => a.address),
		addresses: addresses.results
			.filter((a) => a.mailbox_id === m.id && a.enabled === 1)
			.map((a) => ({
				address: a.address,
				displayName: a.display_name,
				canSend: a.can_send === 1,
				// Saved as plain text before signatures were markdown: escaped, so it still reads as written.
				signature: a.signature !== null && a.markdown === 0 ? escapeMarkdown(a.signature) : a.signature,
			})),
	}));
}

/**
 * Blank clears it. Returns what was saved. Written only while the request's session exists, since checking it before
 * the write proves nothing by the time it lands.
 */
export async function setSignature(db: D1Database, reader: Reader, address: string, text: string): Promise<string | null> {
	// The composer adds the "-- " delimiter itself, so one pasted from another client would show twice. The editor
	// writes it as markdown, escaped (`\--`).
	const signature = text.trim().replace(/^\\?--[ \t]*\n/, "").trim() || null;
	await (signature
		? db
				.prepare(
					`INSERT INTO signatures (user_id, address, text, markdown) SELECT ?1, ?2, ?3, 1 WHERE ${live("?4", "?1")}
					 ON CONFLICT (user_id, address) DO UPDATE SET text = excluded.text, markdown = 1`,
				)
				.bind(reader.userId, address, signature, reader.sessionId)
		: db.prepare(`DELETE FROM signatures WHERE user_id = ?1 AND address = ?2 AND ${live("?3", "?1")}`).bind(reader.userId, address, reader.sessionId)
	).run();
	return signature;
}

/** For a request: whether its person may read the mailbox, with a session that still exists. */
export async function isMailboxMember(db: D1Database, reader: Reader, mailboxId: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS ok FROM mailbox_members WHERE user_id = ?1 AND mailbox_id = ?2 AND ${live("?3", "?1")}`)
		.bind(reader.userId, mailboxId, reader.sessionId)
		.first();
	return row !== null;
}

/**
 * Whether the reader may use this mailbox now: "restoring" while an admin restores it to an earlier time
 * (worker/restore.ts), when it's out of use. Null if they aren't in it, or their session has ended.
 */
export async function mailboxAccess(db: D1Database, reader: Reader, mailboxId: string, now: number): Promise<"member" | "restoring" | null> {
	const row = await db
		.prepare(
			`SELECT (coalesce(b.restoring_until, 0) > ?4 OR b.restore_incomplete = 1) AS restoring FROM mailbox_members mm JOIN mailboxes b ON b.id = mm.mailbox_id
			 WHERE mm.user_id = ?1 AND mm.mailbox_id = ?2 AND ${live("?3", "?1")}`,
		)
		.bind(reader.userId, mailboxId, reader.sessionId, now)
		.first<{ restoring: number }>();
	return row === null ? null : row.restoring ? "restoring" : "member";
}

/**
 * Which of these mailboxes are out of use, being restored to an earlier time or left unfinished by a restore that
 * failed (worker/restore.ts), as mailboxAccess() says for one.
 */
export async function mailboxesRestoring(db: D1Database, mailboxIds: string[], now: number): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT id FROM mailboxes WHERE id IN (SELECT value FROM json_each(?1)) AND (coalesce(restoring_until, 0) > ?2 OR restore_incomplete = 1)`)
		.bind(JSON.stringify(mailboxIds), now)
		.all<{ id: string }>();
	return results.map((r) => r.id);
}

/** Whether a restore revoked this send of a draft it put back (worker/restore.ts). */
export async function isRevokedSend(db: D1Database, mailboxId: string, sendId: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS hit FROM revoked_sends WHERE mailbox_id = ?1 AND send_id = ?2`).bind(mailboxId, sendId).first()) !== null;
}

/** For work no request is behind (an import running on): whether the person is still in the mailbox. */
export async function hasMember(db: D1Database, mailboxId: string, userId: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS ok FROM mailbox_members WHERE user_id = ?1 AND mailbox_id = ?2`).bind(userId, mailboxId).first()) !== null;
}

/** Still in the directory, its person removed or not: mail queued for it is delivered, so a restore loses none. */
export async function mailboxExists(db: D1Database, mailboxId: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS ok FROM mailboxes WHERE id = ?1`).bind(mailboxId).first()) !== null;
}

/**
 * What the directory says of a mailbox: whether it's in use (not hidden by its person's removal: worker/removals.ts),
 * and its latest restore to an earlier time (worker/restore.ts). Null if it isn't in the directory. Asks for every
 * column rather than naming them, so it answers before D1 is migrated: a mailbox's alarm can be the first thing to run
 * after a deploy, and until then a missing column means nobody was removed and nothing restored.
 */
export async function mailboxState(
	db: D1Database,
	mailboxId: string,
): Promise<{ inUse: boolean; restoreId: string | null; restoringUntil: number | null } | null> {
	const row = await db.prepare(`SELECT * FROM mailboxes WHERE id = ?1`).bind(mailboxId).first<Record<string, unknown>>();
	if (!row) return null;
	return {
		inUse: row.removed_with == null,
		restoreId: typeof row.restore_id === "string" ? row.restore_id : null,
		restoringUntil: typeof row.restoring_until === "number" ? row.restoring_until : null,
	};
}

/** In the directory and not hidden by its person's removal. */
export async function mailboxInUse(db: D1Database, mailboxId: string): Promise<boolean> {
	return (await mailboxState(db, mailboxId))?.inUse === true;
}

/** One of this install's addresses (normalized, no +tag), enabled or not. */
export async function isOwnAddress(db: D1Database, address: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS ok FROM addresses WHERE address = ?1`).bind(address).first()) !== null;
}

export interface SendIdentity {
	address: string;
	displayName: string | null;
}

/** Addresses this mailbox may send as: routed to it with can_send, on a domain onboarded for sending. */
export async function getSendIdentities(db: D1Database, mailboxId: string): Promise<SendIdentity[]> {
	const { results } = await db
		.prepare(
			`SELECT a.address, a.display_name FROM address_routes r
			 JOIN addresses a ON a.address = r.address
			 JOIN domains d ON d.name = a.domain
			 WHERE r.mailbox_id = ?1 AND r.can_send = 1 AND a.enabled = 1 AND d.sending = 1
			 ORDER BY a.address`,
		)
		.bind(mailboxId)
		.all<{ address: string; display_name: string | null }>();
	return results.map((r) => ({ address: r.address, displayName: r.display_name }));
}

/** Mailboxes that could have sent from this address (used to route delivery events). */
export async function getSenderMailboxes(db: D1Database, address: string): Promise<string[]> {
	const { results } = await db
		.prepare(`SELECT mailbox_id FROM address_routes WHERE address = ?1 AND can_send = 1`)
		.bind(normalizeAddress(address))
		.all<{ mailbox_id: string }>();
	return results.map((r) => r.mailbox_id);
}

/** Sign-in codes come from login@ the oldest domain that can send; null until one can. */
export async function loginCodeSender(db: D1Database): Promise<string | null> {
	const row = await db.prepare(`SELECT name FROM domains WHERE sending = 1 ORDER BY created_at LIMIT 1`).first<{ name: string }>();
	return row ? `login@${row.name}` : null;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

/** Everything the admin pages show. Small enough to read whole. */
export async function getDirectory(db: D1Database): Promise<Directory> {
	const [domains, people, mailboxes, members, addresses, routes, blocks, cloudflareTokenSaved] = await Promise.all([
		db
			.prepare(`SELECT name, zone_id, receiving, sending, catch_all_mailbox_id FROM domains ORDER BY created_at`)
			.all<{ name: string; zone_id: string | null; receiving: number; sending: number; catch_all_mailbox_id: string | null }>(),
		db
			.prepare(
				`SELECT u.id, u.name, u.email, u.role, u.banned, r.removed_at FROM auth_users u
				 LEFT JOIN removed_people r ON r.user_id = u.id ORDER BY u.createdAt`,
			)
			.all<{ id: string; name: string; email: string; role: string | null; banned: number | null; removed_at: number | null }>(),
		db.prepare(`SELECT id, name, removed_with FROM mailboxes ORDER BY created_at`).all<{ id: string; name: string; removed_with: string | null }>(),
		db.prepare(`SELECT mailbox_id, user_id FROM mailbox_members`).all<{ mailbox_id: string; user_id: string }>(),
		db.prepare(`SELECT address, domain, display_name FROM addresses ORDER BY domain, address`).all<{ address: string; domain: string; display_name: string | null }>(),
		db.prepare(`SELECT address, mailbox_id FROM address_routes`).all<{ address: string; mailbox_id: string }>(),
		db.prepare(`SELECT pattern FROM sender_blocks ORDER BY created_at DESC`).all<{ pattern: string }>(),
		hasCloudflareToken(db),
	]);
	return {
		domains: domains.results.map(
			(d) => ({ name: d.name, zoneId: d.zone_id, receiving: d.receiving === 1, sending: d.sending === 1, catchAllMailboxId: d.catch_all_mailbox_id }),
		),
		people: people.results.map((p) => ({
			id: p.id,
			name: p.name,
			email: p.email,
			isAdmin: p.role === "admin",
			banned: p.banned === 1,
			deletesAt: p.removed_at === null ? null : p.removed_at + REMOVAL_MS,
		})),
		mailboxes: mailboxes.results.map((m) => ({
			id: m.id,
			name: m.name,
			memberIds: members.results.filter((r) => r.mailbox_id === m.id).map((r) => r.user_id),
			removedWith: m.removed_with,
		})),
		addresses: addresses.results.map(
			(a) => ({
				address: a.address,
				domain: a.domain,
				displayName: a.display_name,
				mailboxIds: routes.results.filter((r) => r.address === a.address).map((r) => r.mailbox_id),
			}),
		),
		blockedSenders: blocks.results.map((b) => b.pattern),
		cloudflareTokenSaved,
	};
}

export async function getDomain(db: D1Database, name: string): Promise<{ name: string; zoneId: string | null } | null> {
	const row = await db.prepare(`SELECT name, zone_id FROM domains WHERE name = ?1`).bind(name).first<{ name: string; zone_id: string | null }>();
	return row ? { name: row.name, zoneId: row.zone_id } : null;
}

/** Sign-in codes sent to an address at one of Magnus's own domains would land in the inbox they're meant to open. */
export const codesWouldLandHere = (domain: string) => `Codes sent to ${domain} would arrive in Magnus itself. Use an address somewhere else.`;

/** Email Routing hands this domain's mail to Magnus (connect.ts keeps the flag in line with Cloudflare). */
export async function receivesMail(db: D1Database, name: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS hit FROM domains WHERE name = ?1 AND receiving = 1`).bind(name).first()) !== null;
}

export async function addDomain(db: D1Database, name: string, zoneId: string): Promise<void> {
	await db.prepare(`INSERT INTO domains (name, zone_id) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET zone_id = excluded.zone_id`).bind(name, zoneId).run();
}

export async function setDomainFlag(db: D1Database, name: string, flag: "receiving" | "sending", on: boolean): Promise<void> {
	// The column comes from the union above, never from input.
	await db.prepare(`UPDATE domains SET ${flag} = ?2 WHERE name = ?1`).bind(name, on ? 1 : 0).run();
}

/** False if there's no such domain, or the mailbox is gone or its person removed. */
export async function setCatchAll(db: D1Database, name: string, mailboxId: string | null): Promise<boolean> {
	const { meta } = await db
		.prepare(
			`UPDATE domains SET catch_all_mailbox_id = ?2 WHERE name = ?1
			 AND (?2 IS NULL OR EXISTS (SELECT 1 FROM mailboxes WHERE id = ?2 AND removed_with IS NULL))`,
		)
		.bind(name, mailboxId)
		.run();
	return meta.changes === 1;
}

/** Its addresses go with it. Cloudflare keeps routing mail here, which is then rejected at SMTP time. */
export async function removeDomain(db: D1Database, name: string): Promise<void> {
	await db.prepare(`DELETE FROM domains WHERE name = ?1`).bind(name).run();
}

/** A person's own mailbox, named after them. */
export function createMailbox(db: D1Database, ownerId: string, name: string): { id: string; statements: D1PreparedStatement[] } {
	const id = `mbx_${ulid().toLowerCase()}`;
	return {
		id,
		statements: [
			db.prepare(`INSERT INTO mailboxes (id, name) VALUES (?1, ?2)`).bind(id, name),
			// Nobody if they were removed meanwhile, which fails the batch (user_id is NOT NULL): a removed person gets no
			// mailbox that their deletion would leave behind.
			db
				.prepare(
					`INSERT INTO mailbox_members (mailbox_id, user_id, role)
					 VALUES (?1, (SELECT id FROM auth_users WHERE id = ?2 AND id NOT IN (SELECT user_id FROM removed_people)), 'owner')`,
				)
				.bind(id, ownerId),
		],
	};
}

/**
 * Delivers to every listed mailbox (a group alias when there's more than one), and each may send as it. A mailbox
 * that's gone or whose person was removed fails the batch (mailbox_id is NOT NULL).
 */
export function addAddress(db: D1Database, address: string, displayName: string | null, mailboxIds: string[]): D1PreparedStatement[] {
	const { domain } = splitAddress(address);
	return [
		db.prepare(`INSERT INTO addresses (address, domain, display_name) VALUES (?1, ?2, ?3)`).bind(address, domain, displayName),
		...mailboxIds.map((id) =>
			db.prepare(`INSERT INTO address_routes (address, mailbox_id) VALUES (?1, (SELECT id FROM mailboxes WHERE id = ?2 AND removed_with IS NULL))`).bind(address, id),
		),
	];
}

/** Whether every one of these mailboxes is in the directory and in use. */
export async function mailboxesInUse(db: D1Database, ids: string[]): Promise<boolean> {
	const row = await db
		.prepare(`SELECT count(*) AS n FROM mailboxes WHERE id IN (SELECT value FROM json_each(?1)) AND removed_with IS NULL`)
		.bind(JSON.stringify([...new Set(ids)]))
		.first<{ n: number }>();
	return row?.n === new Set(ids).size;
}

export async function addressExists(db: D1Database, address: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS ok FROM addresses WHERE address = ?1`).bind(address).first()) !== null;
}

export async function removeAddress(db: D1Database, address: string): Promise<void> {
	await db.prepare(`DELETE FROM addresses WHERE address = ?1`).bind(address).run();
}

/** `pattern` comes from blockPattern(). Blocking twice is fine. */
export async function blockSender(db: D1Database, pattern: string): Promise<void> {
	await db.prepare(`INSERT INTO sender_blocks (pattern) VALUES (?1) ON CONFLICT DO NOTHING`).bind(pattern).run();
}

export async function unblockSender(db: D1Database, pattern: string): Promise<void> {
	await db.prepare(`DELETE FROM sender_blocks WHERE pattern = ?1`).bind(pattern).run();
}

/**
 * Deletes mailboxes from the directory, and the addresses that delivered only to them, so those start bouncing. For a
 * batch that also records the mailboxes in mailbox_deletions, so their mail goes too (worker/removals.ts).
 */
export function deleteMailboxStatements(db: D1Database, ids: string[]): D1PreparedStatement[] {
	const list = JSON.stringify(ids);
	return [
		db.prepare(
			`DELETE FROM addresses WHERE address IN (SELECT address FROM address_routes WHERE mailbox_id IN (SELECT value FROM json_each(?1)))
			 AND address NOT IN (SELECT address FROM address_routes WHERE mailbox_id NOT IN (SELECT value FROM json_each(?1)))`,
		).bind(list),
		db.prepare(`DELETE FROM mailboxes WHERE id IN (SELECT value FROM json_each(?1))`).bind(list),
	];
}
