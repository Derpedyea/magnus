import { describe, expect, it } from "vitest";
import { blockPattern, formatAddress, labelFromTag, localRecipients, stripSubaddress } from "./address";

describe("stripSubaddress", () => {
	it("splits +tags", () => {
		expect(stripSubaddress("Me+GitHub@Example.com")).toEqual({ base: "me@example.com", tag: "github" });
	});
	it("passes plain addresses through", () => {
		expect(stripSubaddress("me@example.com")).toEqual({ base: "me@example.com", tag: null });
	});
});

describe("labelFromTag", () => {
	it("keeps long tags at 64 characters, as before", () => {
		expect(labelFromTag("a".repeat(70))).toBe("a".repeat(64));
	});
	it("gives tags named after a view a label of their own", () => {
		expect(["Spam", "screener", "drafts", "receipts"].map(labelFromTag)).toEqual(["spam-tag", "screener-tag", "drafts-tag", "receipts"]);
	});
});

describe("blockPattern", () => {
	it("keeps an address, and turns a domain however it's typed into *@domain", () => {
		expect(blockPattern(" Spam@Example.com ")).toBe("spam@example.com");
		expect(["example.com", "@example.com", "*@Example.com"].map(blockPattern)).toEqual(["*@example.com", "*@example.com", "*@example.com"]);
	});
	it("refuses anything else", () => {
		expect(["", "*", "example", "a@b", "a b@example.com"].map(blockPattern)).toEqual([null, null, null, null, null]);
	});
});

describe("formatAddress", () => {
	it("quotes names with specials", () => {
		expect(formatAddress({ address: "a@b.co", name: "Doe, Jane" })).toBe('"Doe, Jane" <a@b.co>');
	});
});

describe("localRecipients", () => {
	it("delivers in-mailbox recipients itself, labelled like inbound mail", () => {
		const local = localRecipients([{ address: "me+receipts@example.com", route: { kind: "deliver", mailboxIds: ["mbx_main"], subaddress: "receipts" } }], "mbx_main");
		expect(local).toEqual([{ address: "me+receipts@example.com", labels: ["inbox", "receipts"] }]);
	});
	it("leaves outside addresses and other mailboxes to Email Sending", () => {
		const local = localRecipients(
			[
				{ address: "friend@example.org", route: { kind: "reject" } },
				{ address: "family@example.com", route: { kind: "deliver", mailboxIds: ["mbx_main", "mbx_family"], subaddress: null } },
			],
			"mbx_main",
		);
		expect(local).toEqual([]);
	});
});
