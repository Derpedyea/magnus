import { cursorOf, mergePage, mergeThrough, parseCursor, THROUGH_MAX } from "#shared";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ListPlace } from "./api";
import { foldList, foldPages, listQuery } from "./queries";

const thread = (id: string, lastMessageAt: number) => ({
	id,
	lastMessageAt,
	mailboxId: "mbx",
	subject: "",
	snippet: "",
	messageCount: 1,
	unreadCount: 0,
	participants: [],
	labels: [],
	addresses: [],
});
const firstPage = { threads: [thread("c", 30), thread("b", 20)], next: "20.b" };
const twoPages = { pages: [firstPage, { threads: [thread("a", 10)], next: "10.a" }], pageParams: [{ after: "" }, { after: "20.b" }] };

describe("foldPages", () => {
	it("keeps the threads and next, as one page reread through the last thread", () => {
		expect(foldPages(twoPages)).toEqual({
			pages: [{ threads: [thread("c", 30), thread("b", 20), thread("a", 10)], next: "10.a" }],
			pageParams: [{ through: "10.a" }],
		});
	});

	it("leaves a single page as it is", () => {
		const one = { pages: [firstPage], pageParams: [{ after: "" }] };
		expect(foldPages(one)).toBe(one);
	});
});

describe("refetching a folded list", () => {
	type Thread = ReturnType<typeof thread>;
	/** The list API over one mailbox, answering with the server's own merges, and noting what it was asked for. */
	function server(mail: Thread[]) {
		const reads: ListPlace[] = [];
		const after = (cursor: string) => {
			const c = parseCursor(cursor);
			return c ? mail.filter((t) => t.lastMessageAt < c.at || (t.lastMessageAt === c.at && t.id < c.id)) : mail;
		};
		const queryFn = async ({ pageParam }: { pageParam: ListPlace }) => {
			reads.push(pageParam);
			if ("after" in pageParam) return mergePage([after(pageParam.after).slice(0, 51)], 50);
			const c = parseCursor(pageParam.through);
			if (!c) throw new Error(`Malformed through ${pageParam.through}`);
			const below = after(pageParam.through);
			return mergeThrough([[...mail.filter((t) => !below.includes(t)).slice(0, THROUGH_MAX + 1), ...below.slice(0, 1)]], c, THROUGH_MAX);
		};
		return { reads, queryFn };
	}
	const mail = Array.from({ length: 1500 }, (_, i) => thread(`t${i}`, 1500 - i));
	const ids = (qc: QueryClient) => qc.getQueryData(listQuery([], "inbox", "").queryKey)?.pages.flatMap((p) => p.threads.map((t) => t.id));

	it.each([
		[10, [{ through: cursorOf(thread("t499", 1001)) }]],
		[30, [{ through: cursorOf(thread("t999", 501)) }, ...Array.from({ length: 10 }, (_, i) => ({ after: cursorOf(thread(`t${999 + i * 50}`, 501 - i * 50)) }))]],
	])("rereads %i loaded pages in one request up to the most it returns, and drops nothing", async (pages, reads) => {
		const qc = new QueryClient();
		const api = server(mail);
		const list = { ...listQuery([], "inbox", ""), queryFn: api.queryFn };
		await qc.fetchInfiniteQuery({ ...list, pages });
		foldList(qc, [], "inbox", "");
		api.reads.length = 0;
		// Refetched with the list's own options: `pages` above would otherwise stick and set how many pages it refetches.
		await qc.fetchInfiniteQuery({ ...list, staleTime: 0 });
		expect(api.reads).toEqual(reads);
		expect(ids(qc)).toEqual(mail.slice(0, pages * 50).map((t) => t.id));
	});
});

describe("foldList", () => {
	const { queryKey } = listQuery([], "inbox", "");
	const loaded = (updatedAt: number) => {
		const qc = new QueryClient();
		qc.setQueryData(queryKey, twoPages, { updatedAt });
		return qc;
	};

	it("folds a settled list and keeps how old it is", () => {
		const qc = loaded(1000);
		foldList(qc, [], "inbox", "");
		expect(qc.getQueryData(queryKey)?.pageParams).toEqual([{ through: "10.a" }]);
		expect(qc.getQueryState(queryKey)?.dataUpdatedAt).toBe(1000);
	});

	it("leaves a list waiting on a refetch alone, so it still refetches", async () => {
		const qc = loaded(1000);
		await qc.invalidateQueries({ queryKey, refetchType: "none" });
		foldList(qc, [], "inbox", "");
		expect(qc.getQueryData(queryKey)).toEqual(twoPages);
		expect(qc.getQueryState(queryKey)?.isInvalidated).toBe(true);
	});

	it("leaves a list whose refetch failed alone, so the error stays", async () => {
		const qc = loaded(1000);
		await expect(qc.fetchInfiniteQuery({ ...listQuery([], "inbox", ""), staleTime: 0, retry: false, queryFn: () => Promise.reject(new Error("offline")) })).rejects.toThrow("offline");
		foldList(qc, [], "inbox", "");
		expect(qc.getQueryState(queryKey)?.status).toBe("error");
		expect(qc.getQueryData(queryKey)).toEqual(twoPages);
	});

	it("leaves a list being fetched alone", () => {
		const qc = loaded(1000);
		void qc.fetchInfiniteQuery({ ...listQuery([], "inbox", ""), staleTime: 0, queryFn: () => new Promise<never>(() => {}) });
		foldList(qc, [], "inbox", "");
		expect(qc.getQueryState(queryKey)?.fetchStatus).toBe("fetching");
		expect(qc.getQueryData(queryKey)).toEqual(twoPages);
	});
});
