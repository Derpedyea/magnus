-- D1: who can sign in, and where mail for each address goes. Mail itself lives in the Mailbox Durable Objects
-- (worker/mailbox/). The Worker applies these files itself on first use (worker/migrate.ts), so a deploy never
-- needs a separate migration step.

-- ─── Sign-in (Better Auth, served at /api/auth/*) ─────────────────────────────
-- Column names are Better Auth's own, for its core schema plus the admin plugin (role, ban*, impersonatedBy).
-- auth_users is the list of people: nobody signs up, an admin adds them.

CREATE TABLE auth_users (
	id TEXT NOT NULL PRIMARY KEY,
	name TEXT NOT NULL,
	-- Where sign-in codes go. Outside this install, so a code can always reach you.
	email TEXT NOT NULL UNIQUE,
	emailVerified INTEGER NOT NULL,
	image TEXT,
	-- 'admin' manages domains, people, and addresses; anyone else only reads their own mail.
	role TEXT,
	banned INTEGER DEFAULT 0,
	banReason TEXT,
	banExpires DATE,
	createdAt DATE NOT NULL,
	updatedAt DATE NOT NULL
);

CREATE TABLE auth_sessions (
	id TEXT NOT NULL PRIMARY KEY,
	expiresAt DATE NOT NULL,
	token TEXT NOT NULL UNIQUE,
	createdAt DATE NOT NULL,
	updatedAt DATE NOT NULL,
	ipAddress TEXT,
	userAgent TEXT,
	impersonatedBy TEXT,
	userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE
);
CREATE INDEX auth_sessions_userId_idx ON auth_sessions(userId);

-- One row per linked sign-in method (e.g. a Google account).
CREATE TABLE auth_accounts (
	id TEXT NOT NULL PRIMARY KEY,
	accountId TEXT NOT NULL,
	providerId TEXT NOT NULL,
	userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
	accessToken TEXT,
	refreshToken TEXT,
	idToken TEXT,
	accessTokenExpiresAt DATE,
	refreshTokenExpiresAt DATE,
	scope TEXT,
	password TEXT,
	createdAt DATE NOT NULL,
	updatedAt DATE NOT NULL
);
CREATE INDEX auth_accounts_userId_idx ON auth_accounts(userId);

-- Short-lived values: sign-in codes (hashed), OAuth state.
CREATE TABLE auth_verifications (
	id TEXT NOT NULL PRIMARY KEY,
	identifier TEXT NOT NULL,
	value TEXT NOT NULL,
	expiresAt DATE NOT NULL,
	createdAt DATE NOT NULL,
	updatedAt DATE NOT NULL
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);

-- Per client IP and endpoint. In D1 rather than isolate memory, so limits hold across every Worker instance.
CREATE TABLE auth_rate_limits (
	id TEXT NOT NULL PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	count INTEGER NOT NULL,
	lastRequest BIGINT NOT NULL
);

-- ─── Install ──────────────────────────────────────────────────────────────────
-- What the Worker learns during setup rather than being configured with (worker/settings.ts).
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

-- ─── Mail directory ───────────────────────────────────────────────────────────

-- A mailbox is one Durable Object instance; its id is the DO name. Everyone gets their own.
CREATE TABLE mailboxes (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE mailbox_members (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member')),
	PRIMARY KEY (mailbox_id, user_id)
);
CREATE INDEX mailbox_members_user ON mailbox_members(user_id);

CREATE TABLE domains (
	name TEXT PRIMARY KEY,
	-- Cloudflare zone, for turning routing and sending on from the admin pages.
	zone_id TEXT,
	-- Email Routing's catch-all hands this domain's mail to this Worker.
	receiving INTEGER NOT NULL DEFAULT 0,
	-- Onboarded to Email Sending (SPF/DKIM on cf-bounce.<domain>), so its addresses can send.
	sending INTEGER NOT NULL DEFAULT 0,
	-- Unknown local parts are delivered here instead of rejected at SMTP time. NULL = reject.
	catch_all_mailbox_id TEXT REFERENCES mailboxes(id) ON DELETE SET NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Every deliverable address, normalized (lowercase, no +tag).
CREATE TABLE addresses (
	address TEXT PRIMARY KEY,
	domain TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
	-- Default From display name when sending as this address.
	display_name TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Address → mailbox fan-out. More than one row for an address makes it a group alias (e.g. family@).
-- can_send: that mailbox's members may use the address as a From identity.
CREATE TABLE address_routes (
	address TEXT NOT NULL REFERENCES addresses(address) ON DELETE CASCADE,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	can_send INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (address, mailbox_id)
);
CREATE INDEX address_routes_mailbox ON address_routes(mailbox_id);

-- Rejected at SMTP time. Pattern is an address or '*@domain'.
CREATE TABLE sender_blocks (
	pattern TEXT PRIMARY KEY COLLATE NOCASE,
	created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
