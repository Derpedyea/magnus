import { describe, expect, it } from "vitest";
import { buildReferences, MAX_HEADER_VALUE_BYTES, makeSnippet, normalizeSubject, parseMessageIds } from "./threading";

describe("normalizeSubject", () => {
	it("strips stacked reply/forward prefixes", () => {
		expect(normalizeSubject("Re: FWD: re[2]:  Hello   World")).toBe("hello world");
		expect(normalizeSubject("AW: Termin")).toBe("termin");
	});
	it("leaves prefixes that are not at the start", () => {
		expect(normalizeSubject("About re: stuff")).toBe("about re: stuff");
	});
});

describe("parseMessageIds", () => {
	it("extracts bracketed ids", () => {
		expect(parseMessageIds("<a@x> <b@y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
	});
	it("wraps a single bare id", () => {
		expect(parseMessageIds("abc@host")).toEqual(["<abc@host>"]);
	});
	it("handles empty input", () => {
		expect(parseMessageIds(null)).toEqual([]);
	});
});

describe("buildReferences", () => {
	it("appends the parent id", () => {
		expect(buildReferences(["<a@x>"], "<b@x>")).toEqual(["<a@x>", "<b@x>"]);
	});
	it("does not duplicate the parent id", () => {
		expect(buildReferences(["<a@x>", "<b@x>"], "<b@x>")).toEqual(["<a@x>", "<b@x>"]);
	});
	it("keeps root + newest ids under the header byte limit", () => {
		const refs = Array.from({ length: 100 }, (_, i) => `<message-${i}-${"x".repeat(30)}@example.com>`);
		const out = buildReferences(refs, "<parent@example.com>");
		expect(out[0]).toBe(refs[0]);
		expect(out.at(-1)).toBe("<parent@example.com>");
		expect(new TextEncoder().encode(out.join(" ")).length).toBeLessThanOrEqual(MAX_HEADER_VALUE_BYTES);
	});
});

describe("makeSnippet", () => {
	it("drops quoted lines", () => {
		expect(makeSnippet("Sounds good\n\n> On Monday you wrote:\n> hi")).toBe("Sounds good");
	});
});
