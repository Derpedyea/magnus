import { describe, expect, it } from "vitest";
import { labelBatches, labelState } from "./labels";

describe("labeling several conversations", () => {
	const threads = [
		{ mailboxId: "a", id: "1", labels: ["work"] },
		{ mailboxId: "b", id: "2", labels: [] },
		...Array.from({ length: 501 }, (_, i) => ({ mailboxId: "a", id: `x${i}`, labels: [] })),
	];

	it("shows a label some have as mixed, and changes only the ones that differ, a mailbox and 500 at a time", () => {
		expect(labelState(threads, "work")).toBe("mixed");
		expect(labelState(threads.slice(0, 1), "work")).toBe("checked");
		expect(labelState(threads, "home")).toBe("unchecked");

		expect(labelBatches(threads, "work", false)).toEqual([{ mailboxId: "a", threadIds: ["1"] }]);
		const on = labelBatches(threads, "work", true);
		expect(on.map((b) => [b.mailboxId, b.threadIds.length])).toEqual([["b", 1], ["a", 500], ["a", 1]]);
	});
});
