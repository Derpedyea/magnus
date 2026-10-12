import { LIVE_RECHECK } from "#shared";

/** One reconnecting WebSocket to a Mailbox DO at `url`. Returns a function that closes it for good. */
export function subscribe(url: string, onChange: () => void, onStatus: (connected: boolean) => void): () => void {
	let ws: WebSocket | null = null;
	let stopped = false;
	let attempt = 0;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let reconnect: ReturnType<typeof setTimeout> | undefined;

	const connect = () => {
		const socket = new WebSocket(url);
		ws = socket;
		socket.onopen = () => {
			// Whatever changed while there was no socket is refetched: since the page loaded or the last socket closed,
			// including the event a recheck held back.
			onChange();
			attempt = 0;
			onStatus(true);
			heartbeat = setInterval(() => socket.send("ping"), 30_000);
		};
		socket.onmessage = (e) => {
			if (e.data === "pong") return;
			if (e.data !== LIVE_RECHECK) return onChange();
			// Routine, so swap sockets and stay "live". If the sign-in is gone, the new one fails and shows it.
			socket.onclose = null;
			socket.close();
			clearInterval(heartbeat);
			connect();
		};
		socket.onclose = () => {
			onStatus(false);
			clearInterval(heartbeat);
			if (!stopped) reconnect = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 30_000));
		};
	};
	connect();

	return () => {
		stopped = true;
		clearInterval(heartbeat);
		clearTimeout(reconnect);
		ws?.close();
	};
}
