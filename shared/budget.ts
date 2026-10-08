/**
 * Lets work run together while what it holds stays within `limit` bytes. Something bigger than what's left waits until
 * nothing else is held, then runs alone, so one message at the size limit never shares a Worker's memory with another.
 * Waiters go in the order they asked.
 */
export function byteBudget(limit: number) {
	let held = 0;
	const waiting: { bytes: number; start: () => void }[] = [];
	const fits = (bytes: number) => held === 0 || held + bytes <= limit;
	return {
		take(bytes: number): Promise<void> {
			if (waiting.length === 0 && fits(bytes)) {
				held += bytes;
				return Promise.resolve();
			}
			return new Promise((start) => waiting.push({ bytes, start }));
		},
		give(bytes: number): void {
			held -= bytes;
			while (waiting[0] && fits(waiting[0].bytes)) {
				const next = waiting.shift()!;
				held += next.bytes;
				next.start();
			}
		},
	};
}
