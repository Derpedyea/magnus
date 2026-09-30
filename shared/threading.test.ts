import { describe, expect, it } from "vitest";
import { buildReferences, MAX_HEADER_VALUE_BYTES, makeSnippet, normalizeSubject, parseMessageIds, replyParents } from "./threading";

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

describe("replyParents", () => {
	const msg = (id: string, messageIds: string[], inReplyTo: string[] = [], references: string[] = []) => ({ id, messageIds, inReplyTo, references });

	it("follows In-Reply-To, and falls back to the nearest Reference that's here", () => {
		const parents = replyParents([
			msg("a", ["<a@x>"]),
			msg("b", ["<b@x>"], ["<a@x>"], ["<a@x>"]),
			// Answers a message we never got; its References still reach b.
			msg("c", ["<c@x>"], ["<lost@x>"], ["<a@x>", "<b@x>", "<lost@x>"]),
		]);
		expect([...parents]).toEqual([
			["a", { parentId: null, hasDirectParent: false }],
			["b", { parentId: "a", hasDirectParent: true }],
			["c", { parentId: "b", hasDirectParent: false }],
		]);
	});
	it("matches a reply to any id the parent went out under", () => {
		const parents = replyParents([msg("sent", ["<retry@x>", "<first@x>"]), msg("reply", ["<r@y>"], ["<first@x>"])]);
		expect(parents.get("reply")).toEqual({ parentId: "sent", hasDirectParent: true });
	});
	it("leaves a message that answers nothing here at the top", () => {
		expect(replyParents([msg("a", ["<a@x>"]), msg("b", [], ["<elsewhere@y>"])]).get("b")).toEqual({ parentId: null, hasDirectParent: false });
	});
	it("keeps a References-only ancestor for layout without treating it as a direct parent", () => {
		const parents = replyParents([msg("a", ["<a@x>"]), msg("b", ["<b@x>"], [], ["<a@x>", "<lost@x>"])]);
		expect(parents.get("b")).toEqual({ parentId: "a", hasDirectParent: false });
	});
	it("breaks a loop of forged headers", () => {
		const parents = replyParents([msg("a", ["<a@x>"], ["<b@x>"]), msg("b", ["<b@x>"], ["<a@x>"])]);
		expect([...parents]).toEqual([
			["a", { parentId: null, hasDirectParent: false }],
			["b", { parentId: "a", hasDirectParent: true }],
		]);
	});
});
