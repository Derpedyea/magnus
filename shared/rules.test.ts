import { describe, expect, it } from "vitest";
import { matchConditions, type RuleFacts } from "./rules";
import type { RuleCondition, RuleInput } from "./types";

const facts: RuleFacts = {
	from: { address: "orders@shop.example", name: "Shop Orders" },
	to: [{ address: "me@example.com", name: "Me" }],
	cc: [{ address: "partner@example.com" }],
	envelopeTo: "me+shop@example.com",
	subject: "Your receipt #42",
	text: "Thanks for your order.",
	headers: [{ name: "list-id", value: "Shop news <news.shop.example>" }, { name: "x-priority", value: "1" }],
	attachments: [{ inline: true }],
	sender: { verified: "orders@shop.example" },
};

describe("matchConditions", () => {
	it.each<[string, RuleCondition, boolean]>([
		["a sender's address", { field: "from", op: "is", value: " ORDERS@shop.example " }, true],
		["a sender's name", { field: "from", op: "is", value: "shop orders" }, true],
		["a sender's address and name together", { field: "from", op: "contains", value: "orders <orders@" }, true],
		["a sender's domain", { field: "from", op: "ends-with", value: "@shop.example" }, true],
		["the start of a To name", { field: "to", op: "starts-with", value: "me" }, true],
		["Cc", { field: "cc", op: "is", value: "partner@example.com" }, true],
		["the address delivered to without its +tag", { field: "recipient", op: "is", value: "me@example.com" }, true],
		["the address delivered to with its +tag", { field: "recipient", op: "is", value: "me+shop@example.com" }, true],
		["Cc as a recipient", { field: "recipient", op: "is", value: "partner@example.com" }, true],
		["the subject", { field: "subject", op: "contains", value: "receipt" }, true],
		["the body", { field: "body", op: "contains", value: "ORDER" }, true],
		["a List-Id", { field: "list-id", op: "contains", value: "news.shop.example" }, true],
		["a header by name, whatever its case", { field: "header", name: "X-Priority", op: "is", value: "1" }, true],
		["a header that's there", { field: "header", name: "x-priority", op: "exists" }, true],
		["a header that isn't", { field: "header", name: "x-spam", op: "exists" }, false],
		["mail from a list", { field: "mailing-list" }, true],
		["a verified sender", { field: "verified-sender" }, true],
		["only inline files as attachments", { field: "has-attachment" }, false],
		["not the subject", { field: "subject", op: "contains", value: "receipt", not: true }, false],
		["not an attachment", { field: "has-attachment", not: true }, true],
		["half a word as the whole", { field: "subject", op: "is", value: "receipt" }, false],
	])("matches %s", (_, condition, expected) => {
		expect(matchConditions({ match: "all", conditions: [condition] }, facts)).toBe(expected);
	});

	it.each<[RuleInput["match"], boolean]>([["all", false], ["any", true]])("with match %s, needs every condition or one", (match, expected) => {
		const conditions: RuleCondition[] = [{ field: "subject", op: "contains", value: "receipt" }, { field: "has-attachment" }];
		expect(matchConditions({ match, conditions }, facts)).toBe(expected);
		expect(matchConditions({ match, conditions: [] }, facts)).toBe(true);
	});
});
