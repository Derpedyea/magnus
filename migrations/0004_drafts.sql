-- Private to a person, including in shared mailboxes. Tombstones reject late saves after discard/send.
CREATE TABLE drafts (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	content TEXT NOT NULL,
	revision INTEGER NOT NULL,
	change_id TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'sending', 'sent', 'deleted')),
	send_id TEXT,
	queued TEXT
);
CREATE INDEX drafts_user_updated ON drafts(user_id, updated_at DESC);

-- Written before an upload starts. Orphans expire; active drafts and outbox attachments keep their files.
-- No cascading FK: deleting a user/mailbox must leave cleanup work available for retry.
CREATE TABLE draft_files (
	r2_key TEXT PRIMARY KEY,
	mailbox_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	deleting INTEGER NOT NULL DEFAULT 0
);
