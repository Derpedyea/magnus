import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { adminApi, api } from "./api";
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

/** A label's threads, or search results when the view is "search", a page at a time. Refetching refetches every page loaded. */
export const listQuery = (scope: string[], view: string, q: string) =>
	infiniteQueryOptions({
		queryKey: ["mail", view === "search" ? "search" : "threads", scope, view === "search" ? q : view],
		queryFn: ({ pageParam }) => (view === "search" ? api.search(scope, q, pageParam) : api.threads(scope, view, pageParam)),
		initialPageParam: "",
		getNextPageParam: (page) => page.next,
	});

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
