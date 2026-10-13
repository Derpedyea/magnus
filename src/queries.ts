import { cursorOf, THROUGH_MAX } from "#shared";
import { type InfiniteData, infiniteQueryOptions, type QueryClient, queryOptions } from "@tanstack/react-query";
import { adminApi, api, type ListPlace } from "./api";
import { passkeys } from "./passkeys";

// One definition per read, shared by route loaders (which prefetch) and components (which subscribe).
// Everything under ["mail"] is refetched when a mailbox's live socket reports a change.

/** Only changes when setup finishes, which navigates away anyway. */
export const configQuery = queryOptions({ queryKey: ["config"], queryFn: api.config, staleTime: Number.POSITIVE_INFINITY });

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: api.me });

/** Recipient suggestions. Up to a thousand, so it's kept for a while rather than refetched on every mail event. */
export const contactsQuery = queryOptions({ queryKey: ["contacts"], queryFn: api.contacts, staleTime: 5 * 60_000, select: (r) => r.contacts });

/** Account-private drafts. Focus/reconnect refresh immediately; polling brings other devices' edits into view. */
export const draftsQuery = queryOptions({ queryKey: ["drafts"], queryFn: api.drafts, staleTime: 5000, refetchInterval: 10_000 });

const TOP: ListPlace = { after: "" };

/**
 * A label's threads, or search results when the view is "search", a page at a time. Refetching refetches every page
 * loaded, one after another, so the list folds its pages into one (foldList) that refetches in a single request.
 */
export const listQuery = (scope: string[], view: string, q: string) =>
	infiniteQueryOptions({
		queryKey: ["mail", view === "search" ? "search" : "threads", scope, view === "search" ? q : view],
		queryFn: ({ pageParam }: { pageParam: ListPlace }) => (view === "search" ? api.search(scope, q, pageParam) : api.threads(scope, view, pageParam)),
		initialPageParam: TOP,
		getNextPageParam: (page): ListPlace | null => (page.next === null ? null : { after: page.next }),
	});

/**
 * The leading pages that one `through` read can return (THROUGH_MAX threads) as one page, with the same threads and
 * `next`, read back by that one request. Pages past them stay as they are and refetch one by one, so nothing loaded is
 * dropped. Returns `data` itself when there's nothing to fold.
 */
export function foldPages<Page extends { threads: { lastMessageAt: number; id: string }[]; next: string | null }, Param>(
	data: InfiniteData<Page, Param>,
): InfiniteData<Page, Param | ListPlace> {
	let fits = 0;
	let count = 0;
	for (const page of data.pages) {
		count += page.threads.length;
		if (count > THROUGH_MAX) break;
		fits++;
	}
	const threads = data.pages.slice(0, fits).flatMap((p) => p.threads);
	const last = data.pages[fits - 1];
	const end = threads.at(-1);
	if (fits < 2 || !last || !end) return data;
	return { pages: [{ ...last, threads }, ...data.pages.slice(fits)], pageParams: [{ through: cursorOf(end) }, ...data.pageParams.slice(fits)] };
}

/**
 * Folds a list's loaded pages (foldPages), but only while nothing is fetching it and its data is current. Setting data
 * marks a query fresh and error-free, which would hide a refetch in flight or one that failed; this keeps its age too.
 * Data is set only when folding changes it, so folding settles instead of setting data on every render.
 */
export function foldList(qc: QueryClient, scope: string[], view: string, q: string): void {
	const { queryKey } = listQuery(scope, view, q);
	const state = qc.getQueryState(queryKey);
	if (state?.status !== "success" || state.fetchStatus !== "idle" || state.isInvalidated || !state.data) return;
	const folded = foldPages(state.data);
	if (folded !== state.data) qc.setQueryData(queryKey, folded, { updatedAt: state.dataUpdatedAt });
}

/** Incoming mail that couldn't be read. Under ["mail"], so it refreshes when one lands or a retry delivers it. */
export const failedQuery = (scope: string[]) => queryOptions({ queryKey: ["mail", "failed", scope], queryFn: () => api.failed(scope), select: (r) => r.failed });

/** How a mailbox filters mail from senders it doesn't know (Settings › Spam). */
export const mailSettingsQuery = (mailboxId: string) => queryOptions({ queryKey: ["mail-settings", mailboxId], queryFn: () => api.settings(mailboxId) });

export const countsQuery = (scope: string[]) => queryOptions({ queryKey: ["mail", "counts", scope], queryFn: () => api.counts(scope) });

export const threadQuery = (mailboxId: string, threadId: string) =>
	queryOptions({ queryKey: ["mail", "thread", mailboxId, threadId], queryFn: () => api.thread(mailboxId, threadId) });

/** Your passkeys. */
export const passkeysQuery = queryOptions({ queryKey: ["passkeys"], queryFn: passkeys.list });

/** Domains, people, mailboxes, and addresses. Admin changes invalidate ["admin"]. */
export const directoryQuery = queryOptions({ queryKey: ["admin", "directory"], queryFn: adminApi.directory });
