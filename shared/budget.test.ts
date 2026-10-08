import { describe, expect, it } from "vitest";
import { byteBudget } from "./budget";

describe("byteBudget", () => {
	it("lets work run together under the limit, something bigger only alone, and everyone in turn", async () => {
		const budget = byteBudget(10);
		const order: string[] = [];
		await budget.take(4);
		await budget.take(4);
		const big = budget.take(20).then(() => order.push("big"));
		const small = budget.take(2).then(() => order.push("small"));
		await Promise.resolve();
		// The big one waits for everything held; the small one waits its turn behind it.
		expect(order).toEqual([]);
		budget.give(4);
		budget.give(4);
		await big;
		expect(order).toEqual(["big"]);
		budget.give(20);
		await small;
		expect(order).toEqual(["big", "small"]);
	});
});
