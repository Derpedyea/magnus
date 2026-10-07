-- Passkeys (Better Auth's passkey plugin, column names its own): sign in without a code, so losing the inbox your
-- codes go to doesn't lock you out. One row per credential. Removing a person removes their passkeys.
CREATE TABLE auth_passkeys (
	id TEXT NOT NULL PRIMARY KEY,
	-- The password manager that holds it, when its aaguid says.
	name TEXT,
	publicKey TEXT NOT NULL,
	userId TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
	credentialID TEXT NOT NULL UNIQUE,
	-- The authenticator's signature counter, checked on every sign-in to catch a cloned key.
	counter INTEGER NOT NULL,
	deviceType TEXT NOT NULL,
	backedUp INTEGER NOT NULL,
	transports TEXT,
	createdAt DATE,
	-- Which kind of authenticator made it (a password manager, Windows Hello…); all zeros when it won't say.
	aaguid TEXT
);
CREATE INDEX auth_passkeys_userId_idx ON auth_passkeys(userId);
