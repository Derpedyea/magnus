import { isOwnLabel, type Label, type MailboxThread } from "#shared";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { formatDate } from "../dates";
import { useAccount, useStacked } from "../hooks";
import { useLabels } from "../labels";
import { foldList, listQuery } from "../queries";
import { viewName } from "../views";
import { LabelChip } from "./LabelPicker";
import { PermanentDelete } from "./PermanentDelete";
import { SelectionBar } from "./SelectionBar";

const route = getRouteApi("/_app/_mail/$view");

const keyOf = (t: { mailboxId: string; id: string }) => `${t.mailboxId}/${t.id}`;

/** Below lg an open thread covers the list (routes/_app._mail.$view.tsx), which stays laid out so it keeps its scroll. */
export function ThreadList({ threadOpen }: { threadOpen: boolean }) {
	const { view } = route.useParams();
	const { scope, q } = route.useLoaderDeps();
	// Another list starts at the top, not at the last one's scroll offset, and with nothing selected.
	return <Threads key={`${view}/${scope.join()}/${q}`} view={view} scope={scope} q={q} threadOpen={threadOpen} />;
}

/**
 * How many rows below the screen are left when the next page starts loading: about 2,500px, so a page (half a second
 * or so) usually lands before a quick scroll gets there. Under a page (50) less a screen, so opening a list loads one.
 */
const LEAD = 30;

/** Only the rows near the viewport are rendered, and the next page loads while LEAD rows are still to go. */
function Threads({ view, scope, q, threadOpen }: { view: string; scope: string[]; q: string; threadOpen: boolean }) {
	const account = useAccount();
	const { data, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = useSuspenseInfiniteQuery(listQuery(scope, view, q));
	const threads = data.pages.flatMap((p) => p.threads);
	// Per-row address dots, unless every row would show the same one.
	const colors = account.addresses.length > 1 && scope.length !== 1 ? account.colors : null;
	const { byKey: labels } = useLabels();

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
			return t ? keyOf(t) : "more";
		},
	});
	const items = rows.getVirtualItems();

	// J and K open the conversation below or above the open one, or the first when none is.
	const navigate = useNavigate();
	const open = useParams({ strict: false, select: (p) => `${p.mailboxId}/${p.threadId}` });
	const step = (by: 1 | -1) => {
		const at = threads.findIndex((t) => keyOf(t) === open);
		const index = at === -1 ? 0 : at + by;
		const t = threads[index];
		if (!t) return;
		rows.scrollToIndex(index);
		void navigate({ to: "/$view/$mailboxId/$threadId", params: { view, mailboxId: t.mailboxId, threadId: t.id }, search: true });
	};
	const hotkeys = useAppHotkeys();
	useHotkey(hotkeys["thread.next"], () => step(1));
	useHotkey(hotkeys["thread.previous"], () => step(-1));

	// The conversations selected, by key. Only those still listed count, so one a refetch or an action takes out of the
	// list is dropped, and moving them all out ends the selection.
	const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
	const selected = [...new Map(threads.filter((t) => picked.has(keyOf(t))).map((t) => [keyOf(t), t])).values()];
	if (selected.length !== picked.size) setPicked(new Set(selected.map(keyOf)));
	// The row Shift-click selects from: the last one toggled.
	const anchor = useRef<string | null>(null);
	/** Selects a row or unselects it; with `range`, every row from the anchor to it goes the same way. */
	const toggle = (t: MailboxThread, range = false) => {
		const at = threads.indexOf(t);
		const from = range ? threads.findIndex((r) => keyOf(r) === anchor.current) : -1;
		const rows = from === -1 || at === -1 ? [t] : threads.slice(Math.min(from, at), Math.max(from, at) + 1);
		anchor.current = keyOf(t);
		setPicked((prev) => {
			const on = !prev.has(keyOf(t));
			const next = new Set(prev);
			for (const r of rows) {
				if (on) next.add(keyOf(r));
				else next.delete(keyOf(r));
			}
			return next;
		});
	};
	useHotkey(hotkeys["thread.select"], () => {
		const t = threads.find((r) => keyOf(r) === open);
		if (t) toggle(t);
	});
	const stacked = useStacked();
	// As after ThreadView's own Archive, Trash, Spam, and Mark unread, the open conversation closes when it's one of them.
	const onDone = (done: readonly MailboxThread[]) => {
		if (done.some((t) => keyOf(t) === open)) void navigate({ to: "/$view", params: { view }, search: true });
	};

	const nearEnd = (rows.calculateRange()?.endIndex ?? 0) >= threads.length - LEAD;
	useEffect(() => {
		if (nearEnd && hasNextPage && !isFetching && !isFetchNextPageError) void fetchNextPage();
	}, [nearEnd, hasNextPage, isFetching, isFetchNextPageError, fetchNextPage]);

	// Each page that lands joins the rest, so a refetch (on any mail change) is one request however far down this is,
	// and the next page waits on it for one round trip rather than one per page.
	const qc = useQueryClient();
	useEffect(() => foldList(qc, scope, view, q), [data, qc, scope, view, q]);

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
			{selected.length > 0 ? (
				<SelectionBar
					threads={selected}
					view={view}
					all={threads.every((t) => picked.has(keyOf(t)))}
					keys={!(threadOpen && stacked)}
					onSelectAll={() => setPicked(new Set(threads.map(keyOf)))}
					onClear={() => setPicked(new Set())}
					onDone={onDone}
				/>
			) : view === "trash" ? (
				<div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-background px-4 py-3">
					<h2 className="font-medium">Trash</h2>
					<PermanentDelete scope={scope} disabled={threads.length === 0} />
				</div>
			) : (
				// Phones keep the sidebar in a drawer, so the list says where you are. Trash's own header does that.
				<h1 className="flex min-w-0 items-baseline gap-2 px-4 pt-3 pb-1 md:hidden">
					<span className="shrink-0 font-heading text-lg font-semibold">{viewName(view, labels)}</span>
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
								<ThreadRow
									thread={t}
									view={view}
									colors={colors}
									labels={labels}
									selected={picked.has(keyOf(t))}
									selecting={selected.length > 0}
									onToggle={(range) => toggle(t, range)}
								/>
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

function ThreadRow(props: {
	thread: MailboxThread;
	view: string;
	colors: Map<string, string> | null;
	labels: ReadonlyMap<string, Label>;
	selected: boolean;
	/** Whether any row is. */
	selecting: boolean;
	/** `range`: from the last row toggled (Shift-click). */
	onToggle: (range: boolean) => void;
}) {
	const { thread: t, view, colors, labels, selecting, onToggle } = props;
	const unread = t.unreadCount > 0;
	const people = t.participants.map((p) => p.name || p.address.split("@")[0]).slice(0, 3).join(", ");
	// The view's own label goes without saying.
	const own = t.labels.filter((l) => isOwnLabel(l) && l !== view);
	const hold = useLongPress(() => onToggle(false));
	return (
		// The box is beside the link, over its left edge, so ticking it doesn't open the conversation. With a mouse it
		// shows on hover; on a phone, once a row's held.
		<div className="group/row relative" {...hold}>
			<Checkbox
				checked={props.selected}
				// Here rather than in onCheckedChange, whose event doesn't say whether Shift was held.
				onClick={(e) => {
					e.preventBaseUIHandler();
					onToggle(e.shiftKey);
				}}
				// Shift-click would otherwise select the text of the rows between too.
				onMouseDown={(e) => e.shiftKey && e.preventDefault()}
				aria-label={`Select “${t.subject}”`}
				className={cn("absolute top-4 left-3", !selecting && "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:hidden")}
			/>
			<Link
				to="/$view/$mailboxId/$threadId"
				params={{ view, mailboxId: t.mailboxId, threadId: t.id }}
				search={true}
				activeProps={{ className: "bg-accent" }}
				inactiveProps={{ className: "hover:bg-muted/50" }}
				className={cn("block w-full border-b py-3 pr-4 pl-4 text-left outline-none [-webkit-touch-callout:none] focus-visible:bg-accent pointer-fine:pl-10", selecting && "pl-10")}
				onClick={(e) => {
					// Once selecting on a phone, a tap selects too.
					if (selecting && matchMedia("(pointer: coarse)").matches) {
						e.preventDefault();
						onToggle(false);
					}
				}}
			>
				<div className="flex items-baseline gap-2">
					<span className={`truncate ${unread ? "font-semibold" : "text-foreground/80"}`}>{people}</span>
					{t.messageCount > 1 ? <span className="text-xs text-muted-foreground">{t.messageCount}</span> : null}
					<span className="ml-auto flex shrink-0 items-center gap-2">
						{colors ? t.addresses.map((a) => <span key={a} title={a} className={`size-2 rounded-full ${colors.get(a) ?? "bg-muted-foreground"}`} />) : null}
						<time className="text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
					</span>
				</div>
				<div className="flex items-center gap-2">
					<span className={`truncate ${unread ? "font-semibold" : ""}`}>{t.subject}</span>
					{own.length > 0 ? (
						<span className="ml-auto flex shrink-0 items-center gap-1">
							{own.slice(0, 2).map((key) => <LabelChip key={key} labelKey={key} label={labels.get(key)} />)}
							{own.length > 2 ? <span className="text-xs text-muted-foreground">+{own.length - 2}</span> : null}
						</span>
					) : null}
				</div>
				<div className="truncate text-muted-foreground">{t.snippet}</div>
			</Link>
		</div>
	);
}

/**
 * Holding a finger on a row selects it, as phone mail apps do, rather than opening the browser's link menu or preview.
 * The tap it ends in, if any, goes nowhere: not to the link, nor to the box that's just shown under the finger.
 * Scrolling cancels the pointer, and with it the hold.
 */
function useLongPress(onHold: () => void) {
	const timer = useRef<number | undefined>(undefined);
	const touch = useRef(false);
	const held = useRef(false);
	const hold = () => {
		window.clearTimeout(timer.current);
		if (held.current) return;
		held.current = true;
		onHold();
	};
	const cancel = () => window.clearTimeout(timer.current);
	return {
		onPointerDown: (e: React.PointerEvent) => {
			held.current = false;
			touch.current = e.pointerType === "touch";
			if (touch.current) timer.current = window.setTimeout(hold, 500);
		},
		onPointerUp: cancel,
		onPointerCancel: cancel,
		// Android's own long press, which would open the link menu. iOS has none (the row's CSS turns its menu off).
		onContextMenu: (e: React.MouseEvent) => {
			if (!touch.current) return;
			e.preventDefault();
			hold();
		},
		onClickCapture: (e: React.MouseEvent) => {
			if (!held.current) return;
			e.preventDefault();
			e.stopPropagation();
		},
	};
}
