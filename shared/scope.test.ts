import { describe, expect, it } from "vitest";
import { cursorOf, mergeCounts, mergePage, mergeThrough, parseCursor, planScope } from "./scope";
import type { ListCursor, ThreadSummary } from "./types";

const mailboxes = [
	{ id: "mbx_main", addresses: ["me@example.com", "me@example.net"] },
	{ id: "mbx_family", addresses: ["family@example.com"] },
];

describe("planScope", () => {
	it("queries every mailbox unfiltered when nothing is selected", () => {
		expect(planScope(mailboxes, [])).toEqual([{ mailboxId: "mbx_main" }, { mailboxId: "mbx_family" }]);
	});
	it("narrows each mailbox to its own selected addresses and ignores foreign ones", () => {
		expect(planScope(mailboxes, ["me@example.net", "someone@else.com"])).toEqual([
			{ mailboxId: "mbx_main", addresses: ["me@example.net"] },
			{ mailboxId: "mbx_family", addresses: [] },
		]);
	});
});

describe("mergePage", () => {
	const thread = (id: string, lastMessageAt: number): ThreadSummary => ({
		id,
		lastMessageAt,
		subject: "",
		snippet: "",
		messageCount: 1,
		unreadCount: 0,
		participants: [],
		labels: [],
		addresses: [],
	});
	// Two mailboxes in list order, with timestamps tied within and across them, and some before 1970.
	const mailboxes = [
		[thread("A3", 30), thread("A2", 20), thread("A1", 20), thread("A0", -10)],
		[thread("B2", 30), thread("B1", 20), thread("B0", -20)],
	];
	/** What a Mailbox DO answers: threads past the cursor, up to the limit. */
	const read = (list: ThreadSummary[], before: ListCursor | undefined, limit: number) =>
		list.filter((t) => !before || t.lastMessageAt < before.at || (t.lastMessageAt === before.at && t.id < before.id)).slice(0, limit);

	it("pages through every mailbox without skipping or repeating threads", () => {
		const pages: string[][] = [];
		let cursor: string | undefined;
		do {
			const page = mergePage(mailboxes.map((list) => read(list, parseCursor(cursor), 3)), 2);
			pages.push(page.threads.map((t) => t.id));
			cursor = page.next ?? undefined;
		} while (cursor && pages.length < 10);
		expect(pages).toEqual([["B2", "A3"], ["B1", "A2"], ["A1", "A0"], ["B0"]]);
	});

	/** What a Mailbox DO answers to a `through` read: threads down to the cursor, up to the limit, then one more. */
	const readThrough = (list: ThreadSummary[], through: ListCursor, limit: number) => {
		const after = read(list, through, list.length);
		return [...list.filter((t) => !after.includes(t)).slice(0, limit), ...after.slice(0, 1)];
	};
	const ids = (page: { threads: ThreadSummary[] }) => page.threads.map((t) => t.id);
	const through = (id: string, at: number) => ({ id, at });

	it("rereads loaded pages in one, and the next page carries on after them without a gap or repeat", () => {
		const first = mergePage(mailboxes.map((list) => read(list, undefined, 3)), 2);
		const second = mergePage(mailboxes.map((list) => read(list, parseCursor(first.next ?? ""), 3)), 2);
		const reread = mergeThrough(mailboxes.map((list) => readThrough(list, through("A2", 20), 3)), through("A2", 20), 2 * 2);
		expect(ids(reread)).toEqual([...ids(first), ...ids(second)]);
		expect(reread.next).toBe(second.next);
		const third = mergePage(mailboxes.map((list) => read(list, parseCursor(reread.next ?? ""), 3)), 2);
		expect(ids(third)).toEqual(["A1", "A0"]);
	});

	it("picks up mail that arrived above, drops threads that left, and keeps its place when the last one shown is gone", () => {
		const now = [[thread("A4", 40), thread("A3", 30), thread("A1", 20), thread("A0", -10)], [thread("B2", 30), thread("B1", 20), thread("B0", -20)]];
		const reread = mergeThrough(now.map((list) => readThrough(list, through("A2", 20), 10)), through("A2", 20), 10);
		expect(ids(reread)).toEqual(["A4", "B2", "A3", "B1"]);
		expect(reread.next).toBe("20.A2");
		expect(ids(mergePage(now.map((list) => read(list, parseCursor(reread.next ?? ""), 3)), 2))).toEqual(["A1", "A0"]);
	});

	it("stops at the most it returns, and the rest pages in after it", () => {
		const reread = mergeThrough(mailboxes.map((list) => readThrough(list, through("B0", -20), 4)), through("B0", -20), 3);
		expect(ids(reread)).toEqual(["B2", "A3", "B1"]);
		expect(reread.next).toBe(cursorOf(thread("B1", 20)));
		expect(ids(mergePage(mailboxes.map((list) => read(list, parseCursor(reread.next ?? ""), 5)), 4))).toEqual(["A2", "A1", "A0", "B0"]);
	});

	it("says there's nothing more when the list ends at the last thread shown", () => {
		expect(mergeThrough(mailboxes.map((list) => readThrough(list, through("B0", -20), 10)), through("B0", -20), 10).next).toBeNull();
	});
});

describe("mergeCounts", () => {
	it("sums labels, addresses, and failed mail across mailboxes", () => {
		const merged = mergeCounts([
			{ labels: [{ label: "inbox", threads: 3, unread: 2 }], addresses: [{ address: "family@example.com", unread: 1 }], failed: 1 },
			{ labels: [{ label: "inbox", threads: 1, unread: 1 }], addresses: [{ address: "family@example.com", unread: 1 }], failed: 2 },
		]);
		expect(merged).toEqual({
			labels: [{ label: "inbox", threads: 4, unread: 3 }],
			addresses: [{ address: "family@example.com", unread: 2 }],
			failed: 3,
		});
	});
});
