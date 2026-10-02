/**
 * Per-mailbox SQLite schema. Append-only list: each entry runs once, in order,
 * and the applied count is tracked in `_meta.schema_version`.
 */
export const MIGRATIONS: string[] = [
	`
	CREATE TABLE threads (
		id TEXT PRIMARY KEY,
		subject TEXT NOT NULL,
		-- normalizeSubject(): fallback threading key when References don't match anything
		subject_key TEXT NOT NULL,
		snippet TEXT NOT NULL DEFAULT '',
		last_message_at INTEGER NOT NULL,
		participants TEXT NOT NULL DEFAULT '[]'
	);
	CREATE INDEX threads_last ON threads(last_message_at);
	CREATE INDEX threads_subject ON threads(subject_key, last_message_at);

	CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
		direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
		message_id_header TEXT,
		-- Id returned by Email Sending for outbound mail; matched against delivery events.
		provider_message_id TEXT,
		in_reply_to TEXT NOT NULL DEFAULT '[]',
		refs TEXT NOT NULL DEFAULT '[]',
		envelope_from TEXT,
		envelope_to TEXT,
		from_json TEXT NOT NULL,
		to_json TEXT NOT NULL DEFAULT '[]',
		cc_json TEXT NOT NULL DEFAULT '[]',
		bcc_json TEXT NOT NULL DEFAULT '[]',
		reply_to_json TEXT NOT NULL DEFAULT '[]',
		subject TEXT NOT NULL,
		snippet TEXT NOT NULL DEFAULT '',
		date INTEGER NOT NULL,
		received_at INTEGER NOT NULL,
		text_body TEXT,
		html_key TEXT,
		raw_key TEXT,
		is_read INTEGER NOT NULL DEFAULT 0,
		auth_json TEXT,
		delivery_status TEXT,
		delivery_detail TEXT
	);
	CREATE INDEX messages_thread ON messages(thread_id, date);
	CREATE INDEX messages_header ON messages(message_id_header);
	CREATE INDEX messages_provider ON messages(provider_message_id);

	CREATE TABLE message_labels (
		message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		label TEXT NOT NULL,
		PRIMARY KEY (message_id, label)
	);
	CREATE INDEX message_labels_label ON message_labels(label, message_id);

	CREATE TABLE attachments (
		id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		filename TEXT NOT NULL,
		content_type TEXT NOT NULL,
		size INTEGER NOT NULL,
		content_id TEXT,
		inline INTEGER NOT NULL DEFAULT 0,
		r2_key TEXT NOT NULL
	);
	CREATE INDEX attachments_message ON attachments(message_id);

	-- Every Message-ID we know (inbound and outbound) → its thread. Drives References threading.
	CREATE TABLE thread_refs (
		message_id_header TEXT PRIMARY KEY,
		thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE
	);

	-- Pending sends. The DO alarm drains rows whose send_at has passed.
	CREATE TABLE outbox (
		message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
		send_at INTEGER NOT NULL,
		attempts INTEGER NOT NULL DEFAULT 0,
		payload TEXT NOT NULL
	);
	CREATE INDEX outbox_send_at ON outbox(send_at);

	-- Per-recipient delivery state from Email Sending event subscriptions.
	CREATE TABLE deliveries (
		message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		recipient TEXT NOT NULL,
		status TEXT NOT NULL,
		detail TEXT,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (message_id, recipient)
	);

	-- rowid = messages.rowid
	CREATE VIRTUAL TABLE messages_fts USING fts5(subject, sender, recipients, body, tokenize = 'porter unicode61');
	`,
	`
	-- Which of our addresses each message was delivered to (inbound, +tag stripped) or sent from (outbound).
	-- Drives per-address views. A set rather than a column: mail sent to two of our addresses is stored once.
	CREATE TABLE message_addresses (
		message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
		address TEXT NOT NULL,
		PRIMARY KEY (message_id, address)
	);
	CREATE INDEX message_addresses_address ON message_addresses(address, message_id);

	-- Backfill with the same normalization as stripSubaddress().
	INSERT OR IGNORE INTO message_addresses (message_id, address)
	SELECT id, CASE WHEN plus > 1 THEN substr(addr, 1, plus - 1) || substr(addr, at) ELSE addr END
	FROM (
		SELECT id, addr, instr(addr, '@') AS at, instr(substr(addr, 1, instr(addr, '@')), '+') AS plus
		FROM (
			SELECT id, lower(trim(CASE direction WHEN 'in' THEN envelope_to ELSE json_extract(from_json, '$.address') END)) AS addr
			FROM messages
		)
		WHERE instr(addr, '@') > 1
	);
	`,
	`
	-- Files sent as download links because they didn't fit in the message. The token is the link's only
	-- credential; GET /f/<mailboxId>/<token> serves the file unless the sender has stopped sharing it.
	ALTER TABLE attachments ADD COLUMN link_token TEXT;
	ALTER TABLE attachments ADD COLUMN link_stopped INTEGER NOT NULL DEFAULT 0;
	CREATE UNIQUE INDEX attachments_link_token ON attachments(link_token);
	`,
	`
	-- People this mailbox has written to or heard from, for recipient suggestions (GET /api/contacts).
	-- ingest() and enqueueSend() keep it current; this fills it from the mail already here.
	CREATE TABLE contacts (
		address TEXT PRIMARY KEY,
		-- The newest display name seen with it.
		name TEXT,
		-- Messages sent to it: people you've written to are suggested first.
		sent INTEGER NOT NULL DEFAULT 0,
		last_at INTEGER NOT NULL
	);
	INSERT INTO contacts (address, name, sent, last_at)
	WITH seen AS (
		-- Everyone we've written to…
		SELECT p.value AS person, 1 AS sent, m.date FROM messages m, json_each(m.to_json) p WHERE m.direction = 'out'
		UNION ALL SELECT p.value, 1, m.date FROM messages m, json_each(m.cc_json) p WHERE m.direction = 'out'
		UNION ALL SELECT p.value, 1, m.date FROM messages m, json_each(m.bcc_json) p WHERE m.direction = 'out'
		-- …and everyone who's written to us, spam aside.
		UNION ALL SELECT m.from_json, 0, m.date FROM messages m WHERE m.direction = 'in'
			AND NOT EXISTS (SELECT 1 FROM message_labels l WHERE l.message_id = m.id AND l.label = 'spam')
	),
	people AS (
		SELECT lower(trim(json_extract(person, '$.address'))) AS address, nullif(trim(json_extract(person, '$.name')), '') AS name, sent, date
		FROM seen
	),
	-- The newest name each was seen with (SQLite takes a bare column from the max() row).
	named AS (SELECT address, name, max(date) FROM people WHERE name IS NOT NULL GROUP BY address)
	SELECT p.address, n.name, sum(p.sent), max(p.date) FROM people p LEFT JOIN named n USING (address)
	WHERE p.address LIKE '_%@_%' GROUP BY p.address;
	`,
	`
	-- Every id Email Sending gave an outbound message, in Message-ID form: its first send, then one per retry.
	-- Delivery events can name any of them, so this is where they're matched.
	CREATE TABLE sends (
		provider_message_id TEXT PRIMARY KEY,
		message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
	);
	INSERT OR IGNORE INTO sends (provider_message_id, message_id)
	SELECT message_id_header, id FROM messages
	WHERE direction = 'out' AND provider_message_id IS NOT NULL AND message_id_header IS NOT NULL;
	`,
	`
	-- R2 objects to delete (cancelled copies and completed uploads), kept until R2 has deleted them so a failure is tried
	-- again. One a forward still sends from waits until no message has it, which the index makes cheap to ask.
	CREATE TABLE trash (r2_key TEXT PRIMARY KEY);
	CREATE INDEX attachments_r2_key ON attachments(r2_key);
	`,
];
