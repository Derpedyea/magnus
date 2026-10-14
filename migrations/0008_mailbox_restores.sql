-- Restoring a mailbox to an earlier time (worker/restore.ts).
-- The latest restore. The mailbox sends nothing and shares no file by link until it has failed what the restore
-- brought back of its outbox and stopped every link (either may have been sent or stopped since). NULL = never restored.
ALTER TABLE mailboxes ADD COLUMN restore_id TEXT;
-- The restore running now, and until when it holds the mailbox: one at a time, so each restores what it asked for.
ALTER TABLE mailboxes ADD COLUMN restoring TEXT;
ALTER TABLE mailboxes ADD COLUMN restoring_until INTEGER;
