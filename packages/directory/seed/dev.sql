-- Local development seed. Replace the placeholder local parts with real ones for production
-- (run the same statements with `wrangler d1 execute magnus-directory --remote`).
INSERT INTO mailboxes (id, name) VALUES ('mbx_main', 'Main');

INSERT INTO users (id, login_email, display_name, is_admin)
VALUES ('usr_owner', 'dev@localhost', 'Owner', 1);

INSERT INTO mailbox_members (mailbox_id, user_id, role) VALUES ('mbx_main', 'usr_owner', 'owner');

INSERT INTO domains (name, receiving, sending, catch_all_mailbox_id) VALUES
	('example.com', 1, 1, 'mbx_main'),
	('example.net', 1, 1, NULL);

INSERT INTO addresses (address, domain, display_name) VALUES
	('me@example.com', 'example.com', 'Me'),
	('me@example.net', 'example.net', 'Me'),
	('family@example.com', 'example.com', 'The Family');

INSERT INTO address_routes (address, mailbox_id, can_send) VALUES
	('me@example.com', 'mbx_main', 1),
	('me@example.net', 'mbx_main', 1),
	('family@example.com', 'mbx_main', 1);
