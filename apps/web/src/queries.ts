import { queryOptions } from "@tanstack/react-query";
import { api } from "./api";

// One definition per read, shared by route loaders (which prefetch) and components (which subscribe).
// Everything under ["mail"] is refetched when a mailbox's live socket reports a change.

export const meQuery = queryOptions({ queryKey: ["me"], queryFn: api.me });

/** A label's threads, or search results when the view is "search". */
export const listQuery = (scope: string[], view: string, q: string) =>
	queryOptions({
		queryKey: ["mail", view === "search" ? "search" : "threads", scope, view === "search" ? q : view],
		queryFn: () => (view === "search" ? api.search(scope, q) : api.threads(scope, view)),
	});

export const countsQuery = (scope: string[]) => queryOptions({ queryKey: ["mail", "counts", scope], queryFn: () => api.counts(scope) });

export const threadQuery = (mailboxId: string, threadId: string) =>
	queryOptions({ queryKey: ["mail", "thread", mailboxId, threadId], queryFn: () => api.thread(mailboxId, threadId) });
