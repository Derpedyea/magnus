import { describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

describe("splitStatements", () => {
	it("splits on semicolons and drops comments, including ones inside a statement", () => {
		const sql = `-- header; with a semicolon
CREATE TABLE a (
	id TEXT PRIMARY KEY, -- trailing; note
	name TEXT
);

CREATE INDEX a_name ON a(name);
`;
		expect(splitStatements(sql)).toEqual(["CREATE TABLE a (\n\tid TEXT PRIMARY KEY, \n\tname TEXT\n)", "CREATE INDEX a_name ON a(name)"]);
	});
});
