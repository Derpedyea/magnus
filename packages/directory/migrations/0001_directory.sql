-- Global directory (D1). Small, read-mostly, shared by magnus-mx and magnus-web.
-- Mail content lives in per-mailbox Durable Objects (apps/mailstore), not here.

CREATE TABLE domains (
	name TEXT PRIMARY KEY,
	-- Email Routing catch-all → magnus-mx is live for this domain.
	receiving INTEGER NOT NULL DEFAULT 0,
	-- Domain is onboarded to Email Sending (SPF/DKIM/cf-bounce records in place).
	sending INTEGER NOT NULL DEFAULT 0,
	-- Unknown local parts are delivered here instead of rejected at SMTP time. NULL = reject.
	catch_all_mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- A person who can sign in. login_email is the Google account they sign in with (see 0002_auth.sql).
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	login_email TEXT NOT NULL UNIQUE COLLATE NOCASE,
	display_name TEXT NOT NULL,
	is_admin INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- A mailbox is one Durable Object instance; its id is the DO name.
CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE mailbox_members (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
	PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX mailbox_members_user ON mailbox_members(user_id);

-- Every deliverable address, normalized (lowercase, no +tag).
CREATE TABLE addresses (
	address TEXT PRIMARY KEY,
	domain TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
	-- Default From display name when sending as this address.
	display_name TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Address → mailbox fan-out. More than one row for an address makes it a group alias.
-- can_send: members of that mailbox may use the address as a From identity.
CREATE TABLE address_routes (
	address TEXT NOT NULL REFERENCES addresses(address) ON DELETE CASCADE,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	can_send INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (address, mailbox_id)
);
CREATE INDEX address_routes_mailbox ON address_routes(mailbox_id);

-- Rejected at SMTP time by magnus-mx. Pattern is an address or '*@domain'.
CREATE TABLE sender_blocks (
	pattern TEXT PRIMARY KEY COLLATE NOCASE,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
