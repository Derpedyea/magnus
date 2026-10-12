import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribe } from "./live";

/** Stands in for the browser's WebSocket; the test opens and closes each one by hand. */
class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	constructor() {
		FakeSocket.all.push(this);
	}
	send() {}
	close() {
		this.onclose?.();
	}
}

describe("subscribe", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeSocket);
		FakeSocket.all = [];
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	// Mail fetched before the first socket opened, at page load or during failed tries, missed what changed meanwhile.
	it.each([0, 2])("refetches when the first socket opens after %i failed tries", (failures) => {
		const onChange = vi.fn();
		const stop = subscribe("wss://mail.test/live", onChange, () => {});
		for (let i = 0; i < failures; i++) {
			FakeSocket.all.at(-1)?.close();
			vi.runOnlyPendingTimers();
		}
		expect(FakeSocket.all).toHaveLength(failures + 1);
		expect(onChange).not.toHaveBeenCalled();
		FakeSocket.all.at(-1)?.onopen?.();
		expect(onChange).toHaveBeenCalledTimes(1);
		stop();
	});
});
