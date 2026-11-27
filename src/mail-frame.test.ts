import { afterEach, describe, expect, it, vi } from "vitest";
import { forwardKey } from "./mail-frame";

class FakeKeyboardEvent {
	constructor(public type: string, public init: unknown) {}
}

function event(target: object | null) {
	return { type: "keydown", target, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}
const frame = () => ({ dispatchEvent: vi.fn(() => true) }) as unknown as HTMLIFrameElement;

describe("forwardKey", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("doesn't redispatch keys typed into an editable control in the mail", () => {
		vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
		const typed = event({ closest: (selector: string) => (selector === "input,textarea,select,[contenteditable]" ? {} : null) });
		const target = frame();
		forwardKey(target, typed);
		expect(target.dispatchEvent).not.toHaveBeenCalled();
		expect(typed.preventDefault).not.toHaveBeenCalled();
	});

	it("redispatches keys from the mail document itself", () => {
		vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
		const pressed = event(null);
		const target = frame();
		forwardKey(target, pressed);
		expect(target.dispatchEvent).toHaveBeenCalledOnce();
		const forwarded = vi.mocked(target.dispatchEvent).mock.calls[0]?.[0] as unknown as FakeKeyboardEvent;
		expect(forwarded.type).toBe("keydown");
		expect(forwarded.init).toBe(pressed);
	});
});
