import { describe, expect, it } from "vitest";
import { quote } from "./compose";
import { splitQuote } from "./quotes";

describe("splitQuote", () => {
	it("folds the quote our own replies add, keeping the signature above it", () => {
		const reply = `Sounds good.\n\n-- \nDerped${quote({ date: 0, from: { name: "Sam", address: "sam@x.com" }, text: "Lunch?\n\nSam" })}`;
		expect(splitQuote(reply)).toEqual({ body: "Sounds good.\n\n-- \nDerped", quote: expect.stringMatching(/^On .+, Sam wrote:\n> Lunch\?/) });
	});
	it("takes an attribution wrapped onto a second line", () => {
		const text = "Ok. Can you attach it?\n\nOn Tue, Sep 29, 2026 at 2:15 PM Derped <me@derped.dev>\nwrote:\n\n> This is a test.\n>\n";
		expect(splitQuote(text)).toEqual({ body: "Ok. Can you attach it?", quote: expect.stringMatching(/^On Tue.+\nwrote:\n\n> This is a test\.\n>$/) });
	});
	it("folds Outlook's unprefixed original", () => {
		const text = "Thanks!\n\n________________________________\nFrom: Derped <me@derped.dev>\nSent: Tuesday\n\nOriginal text";
		expect(splitQuote(text).body).toBe("Thanks!");
	});
	it("leaves answers written between quoted lines alone", () => {
		const text = "> Lunch?\nYes.\n> Where?\nThe usual.";
		expect(splitQuote(text)).toEqual({ body: text, quote: "" });
	});
	it("keeps a reply's own line that ends in a colon", () => {
		expect(splitQuote("Details below:\n\n> Lunch?").body).toBe("Details below:");
	});
	it("leaves a message that's all quote, and a forward", () => {
		expect(splitQuote("> Lunch?").quote).toBe("");
		expect(splitQuote("FYI\n\nBegin forwarded message:\n\n> From: Sam\n> Lunch?").quote).toBe("");
	});
});
