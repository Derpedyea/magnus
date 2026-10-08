/** Runs `run` at once, then at most once per `ms`: calls in between become one more run when the time is up. */
export function throttle(run: () => void, ms: number): { call: () => void; cancel: () => void } {
	let last = -Infinity;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const fire = () => {
		timer = undefined;
		last = Date.now();
		run();
	};
	return {
		call: () => {
			if (timer !== undefined) return;
			const wait = last + ms - Date.now();
			if (wait <= 0) fire();
			else timer = setTimeout(fire, wait);
		},
		cancel: () => clearTimeout(timer),
	};
}
