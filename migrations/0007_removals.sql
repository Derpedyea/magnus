-- Removing a person takes effect at once but deletes nothing for 30 days, so an admin can restore them
-- (worker/removals.ts). Until then they can't sign in, their mailboxes refuse mail, and nothing of theirs is lost.
CREATE TABLE removed_people (
	user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
	removed_at INTEGER NOT NULL,
	-- Their memberships as they were, put back by a restore: [{"mailbox": id, "role": role}].
	memberships TEXT NOT NULL,
	-- Their sign-in methods as they were ([id] of auth_passkeys, auth_accounts): a restore drops any added since.
	passkeys TEXT NOT NULL,
	accounts TEXT NOT NULL
);

-- The person whose removal hid this mailbox: it refuses mail, and it's deleted along with them. NULL = in use.
ALTER TABLE mailboxes ADD COLUMN removed_with TEXT;

-- Mailboxes gone from the directory whose Durable Object and R2 objects still have to go. No foreign key: the
-- mailbox row is gone by then. The hourly cron retries whatever's left.
CREATE TABLE mailbox_deletions (
	mailbox_id TEXT PRIMARY KEY
);
