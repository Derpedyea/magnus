import { noteBody } from "#shared/markdown";
import { describe, expect, it } from "vitest";
import type { Draft } from "./components/Composer";
import { answerFrom, closeDraft, compose, isOutgoing, openDraft, quote, replyRecipients, withSignature } from "./compose";
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

describe("answerFrom", () => {
	const ctx = {
		mailboxId: "mbx", identities: [{ mailboxId: "mbx", address: "me@example.com", displayName: null, signature: null }],
		delivered: [], outgoing: true, inView: () => true,
	};
	it("answers sent mail from the address it went out from", () => {
		expect(answerFrom({ from: { address: "Me@Example.com" }, to: [{ address: "pal@outside.test" }], cc: [] }, ctx)).toBe("me@example.com");
	});
	it("answers sent mail imported from an old address from one this mailbox can send as", () => {
		expect(answerFrom({ from: { address: "me@proton.test" }, to: [{ address: "pal@outside.test" }], cc: [] }, ctx)).toBe("me@example.com");
	});
});

describe("isOutgoing", () => {
	// The mailbox's addresses, receive-only ones included.
	const ours = ["me@example.com", "me@example.net", "inbox-only@example.com"];
	const inView = (address: string) => address === "me@example.net";
	it("reads mail one of our addresses sent another as received, when only the recipient is in view", () => {
		expect(isOutgoing({ direction: "out", from: { address: "me@example.com" } }, ours, inView)).toBe(false);
		expect(isOutgoing({ direction: "out", from: { address: "me@example.net" } }, ours, inView)).toBe(true);
	});
	it("counts an address that can only receive as ours", () => {
		expect(isOutgoing({ direction: "out", from: { address: "Inbox-Only@example.com" } }, ours, inView)).toBe(false);
	});
	it("keeps sent mail imported from an old address sent, whatever is in view", () => {
		expect(isOutgoing({ direction: "out", from: { address: "me@proton.test" } }, ours, inView)).toBe(true);
		expect(isOutgoing({ direction: "in", from: { address: "me@proton.test" } }, ours, inView)).toBe(false);
	});
});

describe("replyRecipients", () => {
	const pal = { address: "pal@outside.test" };
	const quiet = { address: "quiet@outside.test" };
	const message = { from: { address: "me@example.com" }, replyTo: [], to: [], cc: [], bcc: [] };
	it("answers received mail to its sender, or where it asks", () => {
		expect(replyRecipients({ ...message, from: pal }, false)).toEqual({ to: [pal], bcc: [] });
		expect(replyRecipients({ ...message, from: pal, replyTo: [quiet] }, false)).toEqual({ to: [quiet], bcc: [] });
	});
	it("answers sent mail to whom it went to, keeping Bcc'd people hidden", () => {
		expect(replyRecipients({ ...message, to: [pal], bcc: [quiet] }, true)).toEqual({ to: [pal], bcc: [] });
		expect(replyRecipients({ ...message, cc: [pal] }, true)).toEqual({ to: [pal], bcc: [] });
		expect(replyRecipients({ ...message, bcc: [pal, quiet] }, true)).toEqual({ to: [], bcc: [pal, quiet] });
	});
});
