import { noteBody } from "#shared/markdown";
import { describe, expect, it } from "vitest";
import type { Draft } from "./components/Composer";
import { closeDraft, compose, openDraft, quote, withSignature } from "./compose";
import { normalizeMarkdown as normalize } from "./markdown";

describe("openDraft", () => {
	const draft: Draft = { mailboxId: "mbx", from: "me@example.com", to: [], cc: [], bcc: [], subject: "", text: "", attachments: [] };
	it("gives every opening its own id, even of the same draft, as Undo send does", () => {
		openDraft(draft);
		const first = compose.state;
		openDraft(draft);
		expect(compose.state?.draft).toBe(draft);
		expect(compose.state?.id).not.toBe(first?.id);
	});
	it("closes only the opening it's given", () => {
		openDraft(draft);
		const earlier = compose.state?.id;
		openDraft(draft);
		closeDraft(earlier);
		expect(compose.state?.draft).toBe(draft);
		closeDraft(compose.state?.id);
		expect(compose.state).toBeNull();
	});
});

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

describe("quote", () => {
	it("quotes the message as it was received, not as markdown, through the editor too", () => {
		const draft = quote({ date: 0, from: { address: "ann@example.com", name: "Ann_Lee" }, text: "Please *do not alter*\n- or this" });
		expect(noteBody(normalize(draft)).text).toMatch(/Ann_Lee wrote:\n\n> Please \*do not alter\*\n> - or this$/);
	});
});
