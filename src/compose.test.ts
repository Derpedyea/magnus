import { describe, expect, it } from "vitest";
import { quote, withSignature } from "./compose";

describe("withSignature", () => {
	const reply = `Thanks!${quote({ date: 0, from: { address: "ann@example.com" }, text: "Hi" })}`;

	it("goes above a reply's quote, or at the end", () => {
		expect(withSignature("", null, "Ann")).toBe("\n\n-- \nAnn");
		expect(withSignature(reply, null, "Ann")).toBe(`Thanks!\n\n-- \nAnn${reply.slice("Thanks!".length)}`);
	});

	it("swaps one signature for another when From changes, or removes it", () => {
		const signed = withSignature(reply, null, "Ann");
		expect(withSignature(signed, "Ann", "Ann Lee")).toBe(withSignature(reply, null, "Ann Lee"));
		expect(withSignature(signed, "Ann", null)).toBe(reply);
	});

	it("leaves a signature edited by hand alone", () => {
		expect(withSignature("Hi\n\n-- \nAnn (edited)", "Ann", "Bob")).toBe("Hi\n\n-- \nAnn (edited)");
	});
});
