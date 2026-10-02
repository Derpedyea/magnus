import type { MailboxThread } from "#shared";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatDate } from "../dates";
import { useAccount } from "../hooks";
import { listQuery } from "../queries";
import { viewName } from "../views";
import { PermanentDelete } from "./PermanentDelete";

const route = getRouteApi("/_app/_mail/$view");

/** Below lg an open thread covers the list (routes/_app._mail.$view.tsx), which stays laid out so it keeps its scroll. */
export function ThreadList({ threadOpen }: { threadOpen: boolean }) {
	const { view } = route.useParams();
	const { scope, q } = route.useLoaderDeps();
	// Another list starts at the top, not at the last one's scroll offset.
	return <Threads key={`${view}/${scope.join()}/${q}`} view={view} scope={scope} q={q} threadOpen={threadOpen} />;
}

/** Only the rows near the viewport are rendered, and the next page loads as its placeholder row nears it. */
function Threads({ view, scope, q, threadOpen }: { view: string; scope: string[]; q: string; threadOpen: boolean }) {
	const account = useAccount();
	const { data, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = useSuspenseInfiniteQuery(listQuery(scope, view, q));
	const threads = data.pages.flatMap((p) => p.threads);
	// Per-row address dots, unless every row would show the same one.
	const colors = account.addresses.length > 1 && scope.length !== 1 ? account.colors : null;

	const scrollRef = useRef<HTMLElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const rows = useVirtualizer({
		count: hasNextPage ? threads.length + 1 : threads.length,
		getScrollElement: () => scrollRef.current,
		// Whatever sits above the rows in the scroller (the phone title, the empty note).
		scrollMargin: listRef.current?.offsetTop ?? 0,
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
		<section ref={scrollRef} className={cn("relative w-full min-w-0 overflow-y-auto max-md:pb-24 lg:w-96 lg:shrink-0 lg:border-r", threadOpen && "max-lg:invisible")}>
			{view === "trash" ? (
				<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-3">
					<h2 className="font-medium">Trash</h2>
					<PermanentDelete scope={scope} disabled={threads.length === 0} />
				</div>
			) : (
				// Phones keep the sidebar in a drawer, so the list says where you are. Trash's own header does that.
				<h1 className="flex min-w-0 items-baseline gap-2 px-4 pt-3 pb-1 md:hidden">
					<span className="shrink-0 font-heading text-lg font-semibold">{viewName(view)}</span>
					{scope.length ? <span className="truncate text-muted-foreground">{scope.join(", ")}</span> : null}
				</h1>
			)}
			{threads.length === 0 ? <p className="p-4 text-muted-foreground">{view === "search" ? "No matches." : view === "trash" ? "Trash is empty." : "Nothing here."}</p> : null}
			<ul ref={listRef} className="relative" style={{ height: rows.getTotalSize() }}>
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
							style={{ transform: `translateY(${item.start - rows.options.scrollMargin}px)` }}
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
