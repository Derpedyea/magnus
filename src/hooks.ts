import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LIVE_RECHECK, type Me, parseScope } from "#shared";
import type { Identity } from "./api";
import { countsQuery, meQuery } from "./queries";
import { throttle } from "./throttle";

/** The signed-in user, plus what the UI derives from their mailboxes. The root route loads it, so it never suspends. */
export function useAccount() {
	return useSuspenseQuery({ ...meQuery, select: toAccount }).data;
}

function toAccount(me: Me) {
	// Views are per address, so an address routed to two of the user's mailboxes is listed once.
	const addresses = [...new Set(me.mailboxes.flatMap((m) => m.addresses.map((a) => a.address)))];
	const identities: Identity[] = me.mailboxes.flatMap((m) =>
		m.addresses.filter((a) => a.canSend).map((a) => ({ mailboxId: m.id, address: a.address, displayName: a.displayName, signature: a.signature })),
	);
	return {
		...me,
		/** Every address, in sidebar order. */
		addresses,
		/** Dot colour class per address. */
		colors: new Map(addresses.map((a, i) => [a, DOT_COLORS[i % DOT_COLORS.length] ?? ""])),
		identities,
	};
}

// Assigned in sidebar order, so a colour stays put unless addresses are added or removed.
// No green: the header's live indicator owns it.
const DOT_COLORS = ["bg-sky-500", "bg-amber-500", "bg-violet-500", "bg-rose-500", "bg-teal-600", "bg-orange-500", "bg-fuchsia-500", "bg-slate-500"];

const mail = getRouteApi("/_app/_mail");

/** The addresses in view, from `?in=a@x.com,b@y.com`. Empty = all of them, across every mailbox. */
export function useScope(): string[] {
	return parseScope(mail.useSearch({ select: (s) => s.in }));
}

const TITLE = document.title;

/**
 * "(3) Magnus Mail" while the inbox in view has unread mail, so a background tab or window shows it. The same count
 * as the Inbox badge, from the same query, so it follows the addresses in view and live updates.
 */
export function useUnreadTitle(scope: string[]) {
	const unread = useQuery({ ...countsQuery(scope), select: (c) => c.labels.find((l) => l.label === "inbox")?.unread ?? 0 }).data ?? 0;
	useEffect(() => {
		document.title = unread > 0 ? `(${unread}) ${TITLE}` : TITLE;
		return () => {
			document.title = TITLE;
		};
	}, [unread]);
}

/**
 * How often changes refetch mail at most. One change refetches at once; a burst (an import announces every message it
 * files) refetches once more when it's over, instead of once per message.
 */
const REFRESH_MS = 1000;

/** Subscribes to each mailbox's Durable Object and refetches mail whenever any of them changes. */
export function useLive(mailboxIds: string[]): boolean {
	const qc = useQueryClient();
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const key = mailboxIds.join(",");

	useEffect(() => {
		if (!key) return;
		const refresh = throttle(() => void qc.invalidateQueries({ queryKey: ["mail"] }), REFRESH_MS);
		const stops = key.split(",").map((id) =>
			subscribe(
				id,
				refresh.call,
				(up) =>
					setOpen((prev) => {
						const next = new Set(prev);
						if (up) next.add(id);
						else next.delete(id);
						return next;
					}),
			),
		);
		return () => {
			refresh.cancel();
			for (const stop of stops) stop();
		};
	}, [key, qc]);

	return mailboxIds.length > 0 && mailboxIds.every((id) => open.has(id));
}

/** One reconnecting WebSocket to a Mailbox DO. Returns a function that closes it for good. */
function subscribe(mailboxId: string, onChange: () => void, onStatus: (connected: boolean) => void): () => void {
	let ws: WebSocket | null = null;
	let stopped = false;
	let opened = false;
	let attempt = 0;
	let heartbeat: number | undefined;
	let reconnect: number | undefined;

	const connect = () => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const socket = new WebSocket(`${proto}://${location.host}/api/mailboxes/${mailboxId}/live`);
		ws = socket;
		socket.onopen = () => {
			// Whatever changed while there was no socket is refetched, including the event a recheck held back.
			if (opened) onChange();
			opened = true;
			attempt = 0;
			onStatus(true);
			heartbeat = window.setInterval(() => socket.send("ping"), 30_000);
		};
		socket.onmessage = (e) => {
			if (e.data === "pong") return;
			if (e.data !== LIVE_RECHECK) return onChange();
			// Routine, so swap sockets and stay "live". If the sign-in is gone, the new one fails and shows it.
			socket.onclose = null;
			socket.close();
			window.clearInterval(heartbeat);
			connect();
		};
		socket.onclose = () => {
			onStatus(false);
			window.clearInterval(heartbeat);
			if (!stopped) reconnect = window.setTimeout(connect, Math.min(1000 * 2 ** attempt++, 30_000));
		};
	};
	connect();

	return () => {
		stopped = true;
		window.clearInterval(heartbeat);
		window.clearTimeout(reconnect);
		ws?.close();
	};
}
