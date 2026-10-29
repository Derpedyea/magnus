-- When the domain last started receiving here, which opens its hold window (worker/held.ts). NULL for a domain that
-- was receiving before holding existed: it's long past its move.
ALTER TABLE domains ADD COLUMN receiving_since INTEGER;

-- Mail to an address that didn't exist yet, held instead of bounced in the first 30 days after its domain's mail moved
-- here. Adding the address delivers it, an admin can deliver it elsewhere or discard it, and the hourly cron deletes
-- what's left once the window ends. No foreign keys: it outlives its domain's removal until then.
CREATE TABLE held_mail (
	-- The ingest id it's delivered with.
	id TEXT PRIMARY KEY,
	-- Without its +tag, as an address is added.
	address TEXT NOT NULL,
	domain TEXT NOT NULL,
	envelope_from TEXT NOT NULL,
	envelope_to TEXT NOT NULL,
	-- The From header's address and the subject, for an admin to tell real mail from guesses.
	sender TEXT NOT NULL,
	subject TEXT NOT NULL,
	raw_key TEXT NOT NULL,
	raw_size INTEGER NOT NULL,
	received_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX held_mail_address ON held_mail (address);
CREATE INDEX held_mail_domain ON held_mail (domain);
CREATE INDEX held_mail_expires_at ON held_mail (expires_at);
