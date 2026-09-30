-- Signatures are markdown now (the editor in Settings › Signatures). Ones saved before are plain text: 0 here, and
-- escaped when read (getUserMailboxes()), so they still show as written until they're saved again.
ALTER TABLE signatures ADD COLUMN markdown INTEGER NOT NULL DEFAULT 0;
