import type { Label } from "#shared";
import { describe, expect, it } from "vitest";
import { labelBatches, labelMove, labelState } from "./labels";

const label = (key: string, position: number, parent: string | null = null): Label => ({ key, name: key, parent, color: null, position, hidden: false });

describe("labelMove", () => {
	it("goes between neighbours, a step past the ends, or last inside, renumbering ties, and nowhere when it's already there", () => {
		const labels = [label("a", 1), label("b", 2), label("c", 3), label("d", 1, "c")];
		expect(labelMove(labels, "c", "b", "before")).toEqual([{ key: "c", change: { position: 1.5 } }]);
		expect(labelMove(labels, "a", "c", "after")).toEqual([{ key: "a", change: { position: 4 } }]);
		expect(labelMove(labels, "a", "c", "inside")).toEqual([{ key: "a", change: { parent: "c", position: 2 } }]);
		expect(labelMove(labels, "d", "a", "before")).toEqual([{ key: "d", change: { parent: null, position: 0 } }]);
		expect(labelMove([label("a", 1), label("b", 1), label("c", 2)], "c", "b", "before")).toEqual([
			{ key: "c", change: { position: 2 } },
			{ key: "b", change: { position: 3 } },
		]);
		expect(labelMove(labels, "a", "b", "before")).toEqual([]);
		expect(labelMove(labels, "d", "c", "inside")).toEqual([]);
	});
});


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
