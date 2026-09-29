import type { MailboxThread } from "#shared";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccount } from "../hooks";
import { listQuery } from "../queries";

const route = getRouteApi("/_app/_mail/$view");

export function ThreadList() {
	const { view } = route.useParams();
	const { scope, q } = route.useLoaderDeps();
	// Another list starts at the top, not at the last one's scroll offset.
	return <Threads key={`${view}/${scope.join()}/${q}`} view={view} scope={scope} q={q} />;
}

/** Only the rows near the viewport are rendered, and the next page loads as its placeholder row nears it. */
function Threads({ view, scope, q }: { view: string; scope: string[]; q: string }) {
	const account = useAccount();
	const { data, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = useSuspenseInfiniteQuery(listQuery(scope, view, q));
	const threads = data.pages.flatMap((p) => p.threads);
	// Per-row address dots, unless every row would show the same one.
	const colors = account.addresses.length > 1 && scope.length !== 1 ? account.colors : null;

	const scrollRef = useRef<HTMLElement>(null);
	const rows = useVirtualizer({
		count: hasNextPage ? threads.length + 1 : threads.length,
		getScrollElement: () => scrollRef.current,
		// Three lines of text; each row is measured once rendered.
		estimateSize: () => 85,
		overscan: 10,
		getItemKey: (i) => {
			const t = threads[i];
			return t ? `${t.mailboxId}/${t.id}` : "more";
		},
	});
	const items = rows.getVirtualItems();

	const placeholderNear = (items.at(-1)?.index ?? 0) >= threads.length;
	useEffect(() => {
		if (placeholderNear && hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
	}, [placeholderNear, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

	// When mail arrives (or leaves) above the rows you're reading, keep those rows still. Browsers do this
	// for ordinary lists but not for positioned rows. At the very top, new mail shows up as usual.
	// Runs after every commit so `layout` keeps up as rows get measured.
	const last = useRef({ data, layout: rows.measurementsCache });
	useLayoutEffect(() => {
		const top = scrollRef.current?.scrollTop ?? 0;
		if (last.current.data !== data && top > 0) {
			const was = last.current.layout.find((row) => row.end > top);
			const now = was && rows.measurementsCache.find((row) => row.key === was.key);
			if (now) rows.scrollToOffset(top + now.start - was.start);
		}
		last.current = { data, layout: rows.measurementsCache };
	});

	return (
		<section ref={scrollRef} className="w-96 shrink-0 overflow-y-auto border-r">
			{threads.length === 0 ? <p className="p-4 text-muted-foreground">{view === "search" ? "No matches." : "Nothing here."}</p> : null}
			<ul className="relative" style={{ height: rows.getTotalSize() }}>
				{items.map((item) => {
					const t = threads[item.index];
					return (
						<li
							key={item.key}
							ref={rows.measureElement}
							data-index={item.index}
							aria-posinset={item.index + 1}
							aria-setsize={hasNextPage ? -1 : threads.length}
							className="absolute inset-x-0 top-0"
							style={{ transform: `translateY(${item.start}px)` }}
						>
							{t ? (
								<ThreadRow thread={t} view={view} colors={colors} />
							) : (
								<div className="flex h-14 items-center justify-center gap-2 text-muted-foreground">
									{isFetchNextPageError ? (
										<>
											Couldn't load more.
											<Button variant="ghost" size="sm" onClick={() => void fetchNextPage()}>
												Retry
											</Button>
										</>
									) : (
										<Spinner />
									)}
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function ThreadRow({ thread: t, view, colors }: { thread: MailboxThread; view: string; colors: Map<string, string> | null }) {
	const unread = t.unreadCount > 0;
	const people = t.participants.map((p) => p.name || p.address.split("@")[0]).slice(0, 3).join(", ");
	return (
		<Link
			to="/$view/$mailboxId/$threadId"
			params={{ view, mailboxId: t.mailboxId, threadId: t.id }}
			search={true}
			activeProps={{ className: "bg-accent" }}
			inactiveProps={{ className: "hover:bg-muted/50" }}
			className="block w-full border-b px-4 py-3 text-left outline-none focus-visible:bg-accent"
		>
			<div className="flex items-baseline gap-2">
				<span className={`truncate ${unread ? "font-semibold" : "text-foreground/80"}`}>{people}</span>
				{t.messageCount > 1 ? <span className="text-xs text-muted-foreground">{t.messageCount}</span> : null}
				<span className="ml-auto flex shrink-0 items-center gap-2">
					{colors ? t.addresses.map((a) => <span key={a} title={a} className={`size-2 rounded-full ${colors.get(a) ?? "bg-muted-foreground"}`} />) : null}
					<time className="text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
				</span>
			</div>
			<div className={`truncate ${unread ? "font-semibold" : ""}`}>{t.subject}</div>
			<div className="truncate text-muted-foreground">{t.snippet}</div>
		</Link>
	);
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
	return d.toLocaleDateString();
}
