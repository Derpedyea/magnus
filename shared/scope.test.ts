import { describe, expect, it } from "vitest";
import { mergeCounts, mergePage, parseCursor, planScope } from "./scope";
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
});

describe("mergeCounts", () => {
	it("sums labels and addresses shared across mailboxes", () => {
		const merged = mergeCounts([
			{ labels: [{ label: "inbox", threads: 3, unread: 2 }], addresses: [{ address: "family@example.com", unread: 1 }] },
			{ labels: [{ label: "inbox", threads: 1, unread: 1 }], addresses: [{ address: "family@example.com", unread: 1 }] },
		]);
		expect(merged).toEqual({
			labels: [{ label: "inbox", threads: 4, unread: 3 }],
			addresses: [{ address: "family@example.com", unread: 2 }],
		});
	});
});
