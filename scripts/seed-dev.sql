-- Local development only: an admin who can read one mailbox with a few addresses, so you can skip /setup.
-- Pair with DEV_USER_EMAIL=dev@localhost in .dev.vars (honored only on localhost).
INSERT INTO settings (key, value) VALUES ('install', '{"accountId":"local","workerName":"magnus"}');

INSERT INTO auth_users (id, name, email, emailVerified, role, createdAt, updatedAt)
VALUES ('usr_dev', 'Dev', 'dev@localhost', 1, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ'), strftime('%Y-%m-%dT%H:%M:%fZ'));

INSERT INTO mailboxes (id, name) VALUES ('mbx_dev', 'Dev');
INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES ('mbx_dev', 'usr_dev', 'owner');

INSERT INTO domains (name, receiving, sending, catch_all_mailbox_id) VALUES
	('example.com', 1, 1, 'mbx_dev'),
	('example.net', 1, 1, NULL);

INSERT INTO addresses (address, domain, display_name) VALUES
	('me@example.com', 'example.com', 'Dev'),
	('me@example.net', 'example.net', 'Dev'),
	('family@example.com', 'example.com', 'The Family');

INSERT INTO address_routes (address, mailbox_id, can_send) VALUES
	('me@example.com', 'mbx_dev', 1),
	('me@example.net', 'mbx_dev', 1),
	('family@example.com', 'mbx_dev', 1);
