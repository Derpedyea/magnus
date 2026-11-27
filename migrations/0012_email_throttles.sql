-- Per-email sign-in code throttles, independent of client IP. `key` is a SHA-256 hex digest of the action and
-- normalized email, bucket the hour since epoch; one upsert counts atomically across every Worker instance.
CREATE TABLE auth_email_throttles (
	key TEXT PRIMARY KEY,
	bucket INTEGER NOT NULL,
	count INTEGER NOT NULL
);
