-- Better Auth's rate-limit counters, per client IP and endpoint. Kept in D1 rather than isolate memory so the
-- limits on sign-in codes hold across every Worker instance.
CREATE TABLE auth_rate_limits (
	id TEXT NOT NULL PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	count INTEGER NOT NULL,
	lastRequest BIGINT NOT NULL
);
