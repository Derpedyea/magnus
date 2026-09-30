import { describe, expect, it } from "vitest";
import { quote, withSignature } from "./compose";
import { normalizeMarkdown as normalize } from "./markdown";

describe("withSignature", () => {
	const reply = `Thanks!${quote({ date: 0, from: { address: "ann@example.com" }, text: "Hi" })}`;
	const signature = "Ann & Co\nhttps://ann.example";

	it("goes above a reply's quote, or at the end", () => {
		expect(withSignature("", null, "Ann")).toBe("\n\n-- \nAnn");
		expect(withSignature(reply, null, "Ann")).toBe(`Thanks!\n\n-- \nAnn${reply.slice("Thanks!".length)}`);
	});

	// The editor escapes the delimiter and "&", writes line breaks its own way, and links the URL.
	it("swaps one signature for another when From changes, or removes it, once the editor has rewritten both", () => {
		const signed = normalize(withSignature(reply, null, signature));
		expect(signed).toContain("\\--  \nAnn &amp; Co  \n[https://ann.example](https://ann.example)");
		expect(withSignature(signed, signature, "Ann Lee", normalize)).toBe(normalize(withSignature(reply, null, "Ann Lee")));
		expect(withSignature(signed, signature, null, normalize)).toBe(normalize(reply));
	});

	it("leaves a signature edited by hand alone", () => {
		const edited = normalize("Hi\n\n-- \nAnn (edited)");
		expect(withSignature(edited, "Ann", "Bob", normalize)).toBe(edited);
	});
});
