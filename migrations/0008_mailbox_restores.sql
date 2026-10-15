-- Restoring a mailbox to an earlier time (worker/restore.ts).
-- The latest restore. The mailbox sends nothing and shares no file by link until it has failed what the restore
-- brought back of its outbox and stopped every link (either may have been sent or stopped since). NULL = never restored.
ALTER TABLE mailboxes ADD COLUMN restore_id TEXT;
-- The restore running now, and until when it holds the mailbox: one at a time, so each restores what it asked for.
ALTER TABLE mailboxes ADD COLUMN restoring TEXT;
ALTER TABLE mailboxes ADD COLUMN restoring_until INTEGER;
-- 1 once a restore failed after it may have rewound the mailbox, until one finishes: out of use meanwhile, since the
-- retry rewinds again and would erase whatever its people did in between.
ALTER TABLE mailboxes ADD COLUMN restore_incomplete INTEGER NOT NULL DEFAULT 0;
-- Sends of drafts a restore put back, refused for good: the restore took away the mailbox's record of them, so one
-- retried could go twice. Here rather than only in the mailbox, which a later restore rewinds.
CREATE TABLE revoked_sends (
	mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
	send_id TEXT NOT NULL,
	PRIMARY KEY (mailbox_id, send_id)
);
