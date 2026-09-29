import { describe, expect, it } from "vitest";
import { type Branch, MAX_DEPTH, replyTree } from "./replies";

const m = (id: string, parentId: string | null = null) => ({ id, parentId });
/** Branches as ids: a branch's messages, then its forks in brackets. */
const ids = (branches: Branch<{ id: string }>[]): unknown[] =>
	branches.map((b) => (b.forks.length ? [...b.messages.map((x) => x.id), ids(b.forks)] : b.messages.map((x) => x.id)));

describe("replyTree", () => {
	it("keeps a conversation without forks as one branch", () => {
		expect(ids(replyTree([m("a"), m("b", "a"), m("c", "b")]))).toEqual([["a", "b", "c"]]);
	});
	it("branches where two replies answer the same message, each carrying its own follow-ups", () => {
		const tree = replyTree([m("a"), m("b", "a"), m("sam", "a"), m("c", "b")]);
		expect(ids(tree)).toEqual([["a", [["b", "c"], ["sam"]]]]);
	});
	it("starts a branch at the top for each message that answers nothing here", () => {
		expect(ids(replyTree([m("a"), m("b", "a"), m("x", "gone"), m("y")]))).toEqual([["a", "b"], ["x"], ["y"]]);
	});
	it(`stops indenting ${MAX_DEPTH} forks deep, continuing the branch in reading order`, () => {
		const messages = [m("r")];
		let parent = "r";
		for (let depth = 1; depth <= MAX_DEPTH + 1; depth++) {
			messages.push(m(`d${depth}`, parent), m(`side${depth}`, parent));
			parent = `d${depth}`;
		}
		messages.push(m("leaf", `d${MAX_DEPTH + 1}`));
		let branch = replyTree(messages)[0]!;
		for (let depth = 1; depth <= MAX_DEPTH; depth++) branch = branch.forks[0]!;
		expect(branch.forks).toEqual([]);
		expect(branch.messages.map((x) => x.id)).toEqual([`d${MAX_DEPTH}`, `d${MAX_DEPTH + 1}`, "leaf", `side${MAX_DEPTH + 1}`]);
	});
});
