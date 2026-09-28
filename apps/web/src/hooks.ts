import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { Identity, Me } from "./api";
import { meQuery } from "./queries";

/** The signed-in user, plus what the UI derives from their mailboxes. The root route loads it, so it never suspends. */
export function useAccount() {
	return useSuspenseQuery({ ...meQuery, select: toAccount }).data;
}

function toAccount(me: Me) {
	// Views are per address, so an address routed to two of the user's mailboxes is listed once.
	const addresses = [...new Set(me.mailboxes.flatMap((m) => m.addresses.map((a) => a.address)))];
	const identities: Identity[] = me.mailboxes.flatMap((m) =>
		m.addresses.filter((a) => a.canSend).map((a) => ({ mailboxId: m.id, address: a.address, displayName: a.displayName })),
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

const app = getRouteApi("/_app");

/** The addresses in view, from `?in=a@x.com,b@y.com`. Empty = all of them, across every mailbox. */
export function useScope(): string[] {
	return parseScope(app.useSearch({ select: (s) => s.in }));
}

export const parseScope = (param: string | undefined) => param?.split(",").filter(Boolean) ?? [];
export const formatScope = (scope: string[]) => (scope.length ? scope.join(",") : undefined);

/** Subscribes to each mailbox's Durable Object and refetches mail whenever any of them changes. */
export function useLive(mailboxIds: string[]): boolean {
	const qc = useQueryClient();
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
	const key = mailboxIds.join(",");

	useEffect(() => {
		if (!key) return;
		const stops = key.split(",").map((id) =>
			subscribe(
				id,
				() => void qc.invalidateQueries({ queryKey: ["mail"] }),
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
			for (const stop of stops) stop();
		};
	}, [key, qc]);

	return mailboxIds.length > 0 && mailboxIds.every((id) => open.has(id));
}

/** One reconnecting WebSocket to a Mailbox DO. Returns a function that closes it for good. */
function subscribe(mailboxId: string, onChange: () => void, onStatus: (connected: boolean) => void): () => void {
	let ws: WebSocket | null = null;
	let stopped = false;
	let attempt = 0;
	let heartbeat: number | undefined;
	let reconnect: number | undefined;

	const connect = () => {
		const proto = location.protocol === "https:" ? "wss" : "ws";
		ws = new WebSocket(`${proto}://${location.host}/api/mailboxes/${mailboxId}/live`);
		ws.onopen = () => {
			attempt = 0;
			onStatus(true);
			heartbeat = window.setInterval(() => ws?.send("ping"), 30_000);
		};
		ws.onmessage = (e) => {
			if (e.data !== "pong") onChange();
		};
		ws.onclose = () => {
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
