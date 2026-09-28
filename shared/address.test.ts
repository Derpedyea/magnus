import { describe, expect, it } from "vitest";
import { formatAddress, localRecipients, stripSubaddress } from "./address";

describe("stripSubaddress", () => {
	it("splits +tags", () => {
		expect(stripSubaddress("Me+GitHub@Example.com")).toEqual({ base: "me@example.com", tag: "github" });
	});
	it("passes plain addresses through", () => {
		expect(stripSubaddress("me@example.com")).toEqual({ base: "me@example.com", tag: null });
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
