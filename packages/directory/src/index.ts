import { normalizeAddress, splitAddress, stripSubaddress } from "@magnus/shared";

export type RecipientResolution =
	| { kind: "deliver"; mailboxIds: string[]; subaddress: string | null }
	| { kind: "reject"; reason: string };

/**
 * Decide at SMTP time what happens to an envelope recipient.
 * Rejecting here (instead of accepting and bouncing later) avoids backscatter.
 */
export async function resolveRecipient(
	db: D1Database,
	envelopeFrom: string,
	envelopeTo: string,
): Promise<RecipientResolution> {
	const { base, tag } = stripSubaddress(envelopeTo);
	const { domain } = splitAddress(base);
	const sender = normalizeAddress(envelopeFrom);
	const senderDomain = sender.includes("@") ? splitAddress(sender).domain : "";

	const [routes, domainRow, blocked] = await db.batch([
		db
			.prepare(
				`SELECT r.mailbox_id FROM addresses a
				 JOIN address_routes r ON r.address = a.address
				 WHERE a.address = ?1 AND a.enabled = 1`,
			)
			.bind(base),
		db.prepare(`SELECT receiving, catch_all_mailbox_id FROM domains WHERE name = ?1`).bind(domain),
		db.prepare(`SELECT 1 AS hit FROM sender_blocks WHERE pattern IN (?1, ?2) LIMIT 1`).bind(sender, `*@${senderDomain}`),
	]);

	if ((blocked?.results.length ?? 0) > 0) return { kind: "reject", reason: "5.7.1 Sender blocked" };

	const dom = domainRow?.results[0] as { receiving: number; catch_all_mailbox_id: string | null } | undefined;
	if (!dom || dom.receiving !== 1) return { kind: "reject", reason: "5.1.2 Domain not handled here" };

	const mailboxIds = (routes?.results as { mailbox_id: string }[] | undefined)?.map((r) => r.mailbox_id) ?? [];
	if (mailboxIds.length > 0) return { kind: "deliver", mailboxIds, subaddress: tag };
	if (dom.catch_all_mailbox_id) return { kind: "deliver", mailboxIds: [dom.catch_all_mailbox_id], subaddress: tag };
	return { kind: "reject", reason: "5.1.1 Mailbox unavailable" };
}

export interface User {
	id: string;
	loginEmail: string;
	displayName: string;
	isAdmin: boolean;
}

export async function getUserByLogin(db: D1Database, loginEmail: string): Promise<User | null> {
	const row = await db
		.prepare(`SELECT id, login_email, display_name, is_admin FROM users WHERE login_email = ?1`)
		.bind(loginEmail)
		.first<{ id: string; login_email: string; display_name: string; is_admin: number }>();
	if (!row) return null;
	return { id: row.id, loginEmail: row.login_email, displayName: row.display_name, isAdmin: row.is_admin === 1 };
}

export interface MailboxAddress {
	address: string;
	displayName: string | null;
	/** Same rule as getSendIdentities(). */
	canSend: boolean;
}

export interface MailboxMembership {
	id: string;
	name: string;
	role: "owner" | "member";
	/** Every enabled address routed here, in the order they were added (primary first). */
	addresses: MailboxAddress[];
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
				`SELECT r.mailbox_id, a.address, a.display_name, r.can_send AND d.sending AS can_send
				 FROM mailbox_members mm
				 JOIN address_routes r ON r.mailbox_id = mm.mailbox_id
				 JOIN addresses a ON a.address = r.address
				 JOIN domains d ON d.name = a.domain
				 WHERE mm.user_id = ?1 AND a.enabled = 1 ORDER BY a.created_at, a.rowid`,
			)
			.bind(userId)
			.all<{ mailbox_id: string; address: string; display_name: string | null; can_send: number }>(),
	]);
	return mailboxes.results.map((m) => ({
		...m,
		addresses: addresses.results
			.filter((a) => a.mailbox_id === m.id)
			.map((a) => ({ address: a.address, displayName: a.display_name, canSend: a.can_send === 1 })),
	}));
}

export async function isMailboxMember(db: D1Database, userId: string, mailboxId: string): Promise<boolean> {
	const row = await db
		.prepare(`SELECT 1 AS ok FROM mailbox_members WHERE user_id = ?1 AND mailbox_id = ?2`)
		.bind(userId, mailboxId)
		.first();
	return row !== null;
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
