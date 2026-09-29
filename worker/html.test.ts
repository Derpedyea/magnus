import { describe, expect, it } from "vitest";
import { parseRange, rangeBounds } from "./html";

describe("Range", () => {
	const size = 1000;
	const bounds = (header: string) => {
		const range = parseRange(header);
		return range && rangeBounds(range, size);
	};
	it("covers the forms media players send", () => {
		expect(bounds("bytes=0-99")).toEqual([0, 99]);
		expect(bounds("bytes=900-")).toEqual([900, 999]);
		expect(bounds("bytes=-100")).toEqual([900, 999]);
	});
	it("clamps to the file", () => {
		expect(bounds("bytes=900-5000")).toEqual([900, 999]);
		expect(bounds("bytes=-5000")).toEqual([0, 999]);
	});
	it("marks ranges past the end as unsatisfiable", () => {
		const [start, end] = bounds("bytes=1000-") ?? [0, 0];
		expect(start).toBeGreaterThan(end);
	});
	it("ignores what it can't serve, so the whole file goes out", () => {
		expect(parseRange("bytes=0-1,5-6")).toBeNull();
		expect(parseRange("bytes=5-2")).toBeNull();
		expect(parseRange("items=0-1")).toBeNull();
		expect(parseRange(null)).toBeNull();
	});
});
