-- What the composer adds below each person's messages, per address they send as. Personal even on a shared
-- address, and gone with the address or the person.
CREATE TABLE signatures (
	user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
	address TEXT NOT NULL REFERENCES addresses(address) ON DELETE CASCADE,
	text TEXT NOT NULL,
	PRIMARY KEY (user_id, address)
);
