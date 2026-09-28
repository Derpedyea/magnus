import { describe, expect, it } from "vitest";
import { interleave, mergeCounts, planScope } from "./scope";

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

describe("interleave", () => {
	it("alternates between lists so no mailbox's best hits are buried", () => {
		expect(interleave([["a1", "a2", "a3"], ["b1"]], 3)).toEqual(["a1", "b1", "a2"]);
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
