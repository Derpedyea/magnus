-- Browsers to notify when mail reaches an inbox (worker/push.ts). Each belongs to the session that turned it on, so
-- signing out, suspension, or removal ends it along with that session. One per session: a browser has one.
CREATE TABLE push_subscriptions (
	-- The push service's URL for this browser. It's what lets you send it pushes, so it isn't logged.
	endpoint TEXT PRIMARY KEY,
	session_id TEXT NOT NULL UNIQUE REFERENCES auth_sessions(id) ON DELETE CASCADE,
	-- The browser's keys. Payloads are encrypted to them (RFC 8291), so the push service can't read the mail.
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	-- The app's origin, given to the push service as the sender's contact (VAPID `sub`).
	origin TEXT NOT NULL
);
