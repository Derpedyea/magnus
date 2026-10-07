import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { throttle } from "./hooks";

describe("throttle", () => {
	beforeEach(() => vi.useFakeTimers({ now: 0 }));
	afterEach(() => vi.useRealTimers());

	it("runs a lone call at once and a burst once more when the time is up", () => {
		const run = vi.fn();
		const t = throttle(run, 1000);
		t.call();
		expect(run).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 50; i++) t.call();
		expect(run).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(999);
		expect(run).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(run).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(5000);
		t.call();
		expect(run).toHaveBeenCalledTimes(3);
	});

	it("drops the pending run when cancelled", () => {
		const run = vi.fn();
		const t = throttle(run, 1000);
		t.call();
		t.call();
		t.cancel();
		vi.advanceTimersByTime(2000);
		expect(run).toHaveBeenCalledTimes(1);
	});
});
