import {
	type Directory,
	type MailboxMembership,
	normalizeAddress,
	splitAddress,
	stripSubaddress,
	ulid,
	type User,
} from "#shared";
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

	const [routes, dom, blocked] = await Promise.all([
		db
			.prepare(
				`SELECT r.mailbox_id FROM addresses a
				 JOIN address_routes r ON r.address = a.address
				 WHERE a.address = ?1 AND a.enabled = 1`,
			)
			.bind(base)
			.all<{ mailbox_id: string }>(),
		db.prepare(`SELECT receiving, catch_all_mailbox_id FROM domains WHERE name = ?1`).bind(domain).first<{ receiving: number; catch_all_mailbox_id: string | null }>(),
		db.prepare(`SELECT 1 AS hit FROM sender_blocks WHERE pattern IN (SELECT value FROM json_each(?1)) LIMIT 1`).bind(JSON.stringify(blocks)).first(),
	]);

	if (blocked) return { kind: "reject", reason: "5.7.1 Sender blocked" };
	if (!dom || dom.receiving !== 1) return { kind: "reject", reason: "5.1.2 Domain not handled here" };

	const mailboxIds = routes.results.map((r) => r.mailbox_id);
	if (mailboxIds.length > 0) return { kind: "deliver", mailboxIds, subaddress: tag };
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

export async function getUserMailboxes(db: D1Database, userId: string): Promise<MailboxMembership[]> {
	const [mailboxes, addresses] = await Promise.all([
		db
			.prepare(
				`SELECT m.id, m.name, mm.role FROM mailbox_members mm
				 JOIN mailboxes m ON m.id = mm.mailbox_id
				 WHERE mm.user_id = ?1 ORDER BY m.created_at`,
			)
			.bind(userId)
			.all<Omit<MailboxMembership, "addresses">>(),
		db
			.prepare(
				`SELECT r.mailbox_id, a.address, a.display_name, r.can_send AND d.sending AS can_send, s.text AS signature
				 FROM mailbox_members mm
				 JOIN address_routes r ON r.mailbox_id = mm.mailbox_id
				 JOIN addresses a ON a.address = r.address
				 JOIN domains d ON d.name = a.domain
				 LEFT JOIN signatures s ON s.user_id = mm.user_id AND s.address = a.address
				 WHERE mm.user_id = ?1 AND a.enabled = 1 ORDER BY a.created_at, a.rowid`,
			)
			.bind(userId)
			.all<{ mailbox_id: string; address: string; display_name: string | null; can_send: number; signature: string | null }>(),
	]);
	return mailboxes.results.map((m) => ({
		...m,
		addresses: addresses.results
			.filter((a) => a.mailbox_id === m.id)
			.map((a) => ({ address: a.address, displayName: a.display_name, canSend: a.can_send === 1, signature: a.signature })),
	}));
}

/** Blank clears it. Returns what was saved. */
export async function setSignature(db: D1Database, userId: string, address: string, text: string): Promise<string | null> {
	// The composer adds the "-- " delimiter itself, so one pasted from another client would show twice.
	const signature = text.trim().replace(/^--[ \t]*\n/, "").trim() || null;
	await (signature
		? db
				.prepare(`INSERT INTO signatures (user_id, address, text) VALUES (?1, ?2, ?3) ON CONFLICT (user_id, address) DO UPDATE SET text = excluded.text`)
				.bind(userId, address, signature)
		: db.prepare(`DELETE FROM signatures WHERE user_id = ?1 AND address = ?2`).bind(userId, address)
	).run();
	return signature;
}

export async function isMailboxMember(db: D1Database, userId: string, mailboxId: string): Promise<boolean> {
	const row = await db.prepare(`SELECT 1 AS ok FROM mailbox_members WHERE user_id = ?1 AND mailbox_id = ?2`).bind(userId, mailboxId).first();
	return row !== null;
}

export async function mailboxExists(db: D1Database, mailboxId: string): Promise<boolean> {
	return (await db.prepare(`SELECT 1 AS ok FROM mailboxes WHERE id = ?1`).bind(mailboxId).first()) !== null;
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
		db.prepare(`SELECT id, name, email, role, banned FROM auth_users ORDER BY createdAt`).all<{ id: string; name: string; email: string; role: string | null; banned: number | null }>(),
		db.prepare(`SELECT id, name FROM mailboxes ORDER BY created_at`).all<{ id: string; name: string }>(),
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
		people: people.results.map((p) => ({ id: p.id, name: p.name, email: p.email, isAdmin: p.role === "admin", banned: p.banned === 1 })),
		mailboxes: mailboxes.results.map(
			(m) => ({ id: m.id, name: m.name, memberIds: members.results.filter((r) => r.mailbox_id === m.id).map((r) => r.user_id) }),
		),
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

export async function addDomain(db: D1Database, name: string, zoneId: string): Promise<void> {
	await db.prepare(`INSERT INTO domains (name, zone_id) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET zone_id = excluded.zone_id`).bind(name, zoneId).run();
}

export async function setDomainFlag(db: D1Database, name: string, flag: "receiving" | "sending", on: boolean): Promise<void> {
	// The column comes from the union above, never from input.
	await db.prepare(`UPDATE domains SET ${flag} = ?2 WHERE name = ?1`).bind(name, on ? 1 : 0).run();
}

export async function setCatchAll(db: D1Database, name: string, mailboxId: string | null): Promise<void> {
	await db.prepare(`UPDATE domains SET catch_all_mailbox_id = ?2 WHERE name = ?1`).bind(name, mailboxId).run();
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
			db.prepare(`INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES (?1, ?2, 'owner')`).bind(id, ownerId),
		],
	};
}

/** Delivers to every listed mailbox (a group alias when there's more than one), and each may send as it. */
export function addAddress(db: D1Database, address: string, displayName: string | null, mailboxIds: string[]): D1PreparedStatement[] {
	const { domain } = splitAddress(address);
	return [
		db.prepare(`INSERT INTO addresses (address, domain, display_name) VALUES (?1, ?2, ?3)`).bind(address, domain, displayName),
		...mailboxIds.map((id) => db.prepare(`INSERT INTO address_routes (address, mailbox_id) VALUES (?1, ?2)`).bind(address, id)),
	];
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

/** Mailboxes only this person can read: they go when the person does. */
export async function soleMailboxes(db: D1Database, userId: string): Promise<string[]> {
	const { results } = await db
		.prepare(
			`SELECT mailbox_id FROM mailbox_members WHERE user_id = ?1
			 AND mailbox_id NOT IN (SELECT mailbox_id FROM mailbox_members WHERE user_id != ?1)`,
		)
		.bind(userId)
		.all<{ mailbox_id: string }>();
	return results.map((r) => r.mailbox_id);
}

/** Addresses that delivered only to these mailboxes are removed too, so they start bouncing instead. */
export async function deleteMailboxes(db: D1Database, ids: string[]): Promise<void> {
	if (ids.length === 0) return;
	const list = JSON.stringify(ids);
	await db.batch([
		db.prepare(
			`DELETE FROM addresses WHERE address IN (SELECT address FROM address_routes WHERE mailbox_id IN (SELECT value FROM json_each(?1)))
			 AND address NOT IN (SELECT address FROM address_routes WHERE mailbox_id NOT IN (SELECT value FROM json_each(?1)))`,
		).bind(list),
		db.prepare(`DELETE FROM mailboxes WHERE id IN (SELECT value FROM json_each(?1))`).bind(list),
	]);
}
