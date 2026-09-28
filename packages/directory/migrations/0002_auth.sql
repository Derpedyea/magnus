-- Sign-in (Better Auth, served by magnus-web at /api/auth/*). Generated from its schema for Better Auth 1.7;
-- column names are Better Auth's own. These tables only prove who someone is: `users` (0001) still decides
-- who may sign in at all, and what they can read.

CREATE TABLE auth_users (
	id TEXT NOT NULL PRIMARY KEY,
	name TEXT NOT NULL,
	-- Joins to users.login_email.
	email TEXT NOT NULL UNIQUE,
	emailVerified INTEGER NOT NULL,
	image TEXT,
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

-- Short-lived values such as OAuth state.
CREATE TABLE auth_verifications (
	id TEXT NOT NULL PRIMARY KEY,
	identifier TEXT NOT NULL,
	value TEXT NOT NULL,
	expiresAt DATE NOT NULL,
	createdAt DATE NOT NULL,
	updatedAt DATE NOT NULL
);
CREATE INDEX auth_verifications_identifier_idx ON auth_verifications(identifier);
