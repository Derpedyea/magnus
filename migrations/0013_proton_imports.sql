-- One Proton import container per person across every mailbox (worker/proton-import.ts): Cloudflare's container
-- capacity is account-wide, so without this someone with several mailbox memberships can hold all of them.
CREATE TABLE proton_imports (
	user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	job_id TEXT NOT NULL,
	started_at INTEGER NOT NULL
);
