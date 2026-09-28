const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit ms timestamp + 80 bits of CSPRNG randomness. Lexicographically sortable by time. */
export function ulid(now: number = Date.now()): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let rand = "";
	for (const b of bytes) rand += CROCKFORD[b % 32];
	return time + rand;
}
