import { describe, expect, it } from "vitest";
import { matchContacts, mergeContacts } from "./contacts";

describe("mergeContacts", () => {
	it("sums across mailboxes, keeps the newest name, and puts people you've written to first", () => {
		const merged = mergeContacts(
			[
				[
					{ address: "ann@example.com", name: "Ann", sent: 1, lastAt: 1 },
					{ address: "shop@example.org", name: null, sent: 0, lastAt: 9 },
				],
				[
					{ address: "ann@example.com", name: "Ann Lee", sent: 2, lastAt: 5 },
					{ address: "bob@example.com", name: null, sent: 1, lastAt: 3 },
				],
			],
			10,
		);
		expect(merged).toEqual([
			{ address: "ann@example.com", name: "Ann Lee" },
			{ address: "bob@example.com" },
			{ address: "shop@example.org" },
		]);
	});

	it("leaves out addresses nobody reads", () => {
		const lists = [["noreply@example.com", "no-reply@example.com", "mailer-daemon@example.com", "noreen@example.com"].map((address) => ({ address, name: null, sent: 0, lastAt: 1 }))];
		expect(mergeContacts(lists, 10)).toEqual([{ address: "noreen@example.com" }]);
	});
});

describe("matchContacts", () => {
	const contacts = [{ address: "john.smith@example.com", name: "John Smith" }, { address: "jo@example.org" }, { address: "anna@smithson.dev" }];

	it("matches the start of any word in the name or address", () => {
		expect(matchContacts(contacts, "jo sm", new Set(), 5)).toEqual([contacts[0]]);
		expect(matchContacts(contacts, "smith@ex", new Set(), 5)).toEqual([contacts[0]]);
		expect(matchContacts(contacts, "smith", new Set(), 5)).toEqual([contacts[0], contacts[2]]);
		expect(matchContacts(contacts, "mith", new Set(), 5)).toEqual([]);
	});

	it("skips addresses already added", () => {
		expect(matchContacts(contacts, "jo", new Set(["john.smith@example.com"]), 5)).toEqual([contacts[1]]);
	});
});
