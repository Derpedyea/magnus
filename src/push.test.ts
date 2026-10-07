import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetDevice } from "./push";

vi.mock("./api", () => ({ api: {} }));

/** A browser subscription whose unsubscribe() answers from `answers`, then true. */
function subscription(...answers: (boolean | Error)[]) {
	return {
		unsubscribe: vi.fn(async () => {
			const answer = answers.shift() ?? true;
			if (answer instanceof Error) throw answer;
			return answer;
		}),
	};
}

function browser(current: ReturnType<typeof subscription> | null) {
	const shown = { close: vi.fn() };
	const registration = {
		pushManager: { getSubscription: vi.fn(async () => current) },
		getNotifications: vi.fn(async () => [shown]),
	};
	Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => registration } });
	return {
		registration,
		shown,
		/** Someone signing in turns notifications on: the browser has a new subscription. */
		replace(next: ReturnType<typeof subscription>) {
			current = next;
		},
	};
}

describe("forgetDevice", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		Reflect.deleteProperty(navigator, "serviceWorker");
	});

	it("retries the subscription it started with, never one made meanwhile, then closes what's showing", async () => {
		const old = subscription(new Error("busy"), false);
		const b = browser(old);
		const done = forgetDevice();
		await vi.advanceTimersByTimeAsync(0);
		const theirs = subscription();
		b.replace(theirs);
		await vi.advanceTimersByTimeAsync(3000);
		await done;
		expect(old.unsubscribe).toHaveBeenCalledTimes(3);
		expect(theirs.unsubscribe).not.toHaveBeenCalled();
		expect(b.shown.close).toHaveBeenCalled();
	});

	it("runs once at a time: a call while one runs gets that one", async () => {
		const b = browser(subscription(new Error("busy")));
		const [first, second] = [forgetDevice(), forgetDevice()];
		expect(second).toBe(first);
		await vi.advanceTimersByTimeAsync(1000);
		await first;
		expect(b.registration.pushManager.getSubscription).toHaveBeenCalledTimes(1);
	});
});
