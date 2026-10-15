-- Each archive's own id (worker/removals.ts), so deleting someone for good names exactly the archive the admin saw:
-- one restored and made again since has a new id, even in the same millisecond. Archives without one (from before, or
-- written by an older Worker still running) get a random one when the directory is next read (getDirectory()).
ALTER TABLE removed_people ADD COLUMN archive_id TEXT;
