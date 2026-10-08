const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * ULID: 48-bit ms timestamp + 80 bits of CSPRNG randomness. Lexicographically sortable by time. Pass the 16 bytes of
 * randomness to derive an id from content instead (imports do, so one file always gets the same id).
 */
export function ulid(now: number = Date.now(), bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16))): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let rand = "";
	for (const b of bytes) rand += CROCKFORD[b % 32];
	return time + rand;
}
