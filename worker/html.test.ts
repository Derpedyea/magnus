import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { parseRange, rangeBounds } from "./html";

describe("email HTML sanitizing", () => {
	const server = createTestHarness({ workers: [{ config: { name: "html-renderer", main: "tests/runtime/html-renderer.ts", compatibility_date: "2026-09-26" } }] });
	beforeAll(async () => { await server.listen(); }, 30_000);
	afterAll(async () => { await server.close(); });

	async function render(html: string): Promise<string> {
		const response = await server.fetch("https://magnus.test/", { method: "POST", body: html });
		expect(response.status).toBe(200);
		return response.text();
	}

	it.each([
		["hex entity javascript", `<a href="jav&#x61;script:alert(1)">x</a>`],
		["hex entity javascript without a semicolon", `<a href="jav&#x61script:alert(1)">x</a>`],
		["decimal entity javascript", `<a href="jav&#97;script:alert(1)">x</a>`],
		["entity tab in javascript", `<a href="java&#x09;script:alert(1)">x</a>`],
		["literal tab in javascript", `<a href="java\tscript:alert(1)">x</a>`],
		["literal LF in javascript", `<a href="java\nscript:alert(1)">x</a>`],
		["named tab in javascript", `<a href="java&Tab;script:alert(1)">x</a>`],
		["named newline in javascript", `<a href="java&NewLine;script:alert(1)">x</a>`],
		["entity CR in javascript", `<a href="java&#x0D;script:alert(1)">x</a>`],
		["entity letter and colon in javascript", `<a href="jav&#x61;script&colon;alert(1)">x</a>`],
		["leading control before javascript", `<a href="\x01javascript:alert(1)">x</a>`],
		["entity vbscript", `<a href="vb&#x73;cript:msgbox(1)">x</a>`],
		["entity data HTML", `<a href="d&#x61;ta:text/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+">x</a>`],
		["entity colon in data HTML", `<a href="data&colon;text/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+">x</a>`],
		["entity tab in data HTML", `<a href="data:te&#x09;xt/html;base64,PHNjcmlwdD4xPC9zY3JpcHQ+">x</a>`],
		["SVG link", `<svg><a href="jav&#x61;script:alert(1)"><text>x</text></a></svg>`],
		["SVG xlink", `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="jav&#x61;script:alert(1)"><text>x</text></a></svg>`],
		["MathML link", `<math><a href="jav&#x61;script:alert(1)"><mtext>x</mtext></a></math>`],
		["image map area", `<map name="m"><area shape="rect" coords="0,0,1,1" href="jav&#x61;script:alert(1)"></map>`],
		["a custom scheme", `<a href="web+demo:payload">x</a>`],
		["an uppercase custom-scheme attribute", `<a HREF="web+demo:payload">x</a>`],
		["an SVG xlink custom scheme", `<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="web+demo:payload"><text>x</text></a></svg>`],
	])("drops %s navigation after URL canonicalization", async (_, html) => {
		expect(await render(html)).not.toMatch(/\s(?:xlink:)?href=/i);
	});

	it("keeps navigation schemes mail uses, plus relative and fragment links", async () => {
		const html = await render(`
			<a href="https://example.com/x?a=1&amp;b=2">https</a><a href="http://example.com/x">http</a>
			<a href="mailto:me@example.com">mail</a><a href="tel:+15551212">tel</a><a href="cid:part">cid</a>
			<a href="#quote">fragment</a><a href="/inbox">relative</a>`);
		for (const start of ["https:", "http:", "mailto:", "tel:", "cid:", "#", "/"]) expect(html).toContain(`href="${start}`);
	});

	it("removes form controls, including one with an encoded formaction", async () => {
		const html = await render(`
			<input value="x"><textarea>x</textarea><select><option>x</option></select>
			<button formaction="jav&#x61;script:alert(1)">Pay now</button><p>keep</p>`);
		expect(html).not.toMatch(/<(input|textarea|select|button)\b|formaction/);
		expect(html).toContain(">Pay now</span><p>keep</p>");
	});

	it("keeps a hidden button's contents hidden", async () => {
		const html = await render(`<button hidden>Phish</button><button style="display:none">Phish</button>`);
		expect(html).toBe(`<span hidden>Phish</span><span style="display:none">Phish</span>`);
	});
});

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
