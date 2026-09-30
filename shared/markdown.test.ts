import { describe, expect, it } from "vitest";
import { noteBody } from "./markdown";

// As the composer's editor writes it (src/markdown.ts): entities and markdown characters escaped, "  \n" line breaks.
const reply = [
	"Thanks for the **draft**, see [the doc](https://example.com/doc) &amp; snake\\_case.",
	"",
	"- one",
	"- two",
	"",
	"\\--  \nAnn  \nAcme",
	"",
	"On 9/28/2026, Sam wrote:",
	"",
	"> Lunch?",
].join("\n");

describe("noteBody", () => {
	it("sends plain text that reads like the editor showed it", () => {
		expect(noteBody(reply).text).toBe(
			[
				"Thanks for the draft, see the doc <https://example.com/doc> & snake_case.",
				"",
				"- one",
				"- two",
				"",
				// RFC 3676's delimiter gets back the space the editor can't keep.
				"-- \nAnn\nAcme",
				"",
				"On 9/28/2026, Sam wrote:",
				"",
				"> Lunch?",
			].join("\n"),
		);
	});

	it("renders the formatting as email HTML, the quote marked for clients that fold it", () => {
		const { html } = noteBody(reply);
		expect(html).toContain("<strong>draft</strong>");
		expect(html).toContain('<a href="https://example.com/doc">the doc</a> &amp; snake_case');
		expect(html).toMatch(/<ul style="[^"]*"><li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
		expect(html).toContain('<p style="margin:20px 0 0">--<br>Ann<br>Acme</p>\n<p style="margin:20px 0 0">On 9/28/2026, Sam wrote:</p>');
		expect(html).toMatch(/<blockquote type="cite"[^>]*><p style="margin:0">Lunch\?<\/p>/);
	});

	it("spaces blocks a line apart like the editor, blank lines it kept included", () => {
		expect(noteBody("One\n\n\n\nTwo").html).toContain(
			'<p style="margin:0">One</p>\n<p style="margin:20px 0 0"><br></p><p style="margin:20px 0 0">Two</p>',
		);
	});

	it("shows HTML and unsafe links as text", () => {
		const { html } = noteBody("<img src=x onerror=alert(1)> [click](javascript:alert(1))");
		expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; click");
		expect(html).not.toContain("<img");
		expect(html).not.toContain("javascript:");
	});

	it("puts linked files above the quote, and adds no HTML part to an empty note", () => {
		const file = { filename: "clip.mp4", contentType: "video/mp4", size: 12_800_000, url: "https://mail.example.com/f/x/y" };
		const { text, html = "" } = noteBody(reply, [file]);
		expect(text.indexOf(file.url)).toBeGreaterThan(text.indexOf("Acme"));
		expect(text.indexOf(file.url)).toBeLessThan(text.indexOf("Sam wrote"));
		expect(html.indexOf("clip.mp4")).toBeLessThan(html.indexOf("Sam wrote"));
		expect(noteBody("  \n")).toEqual({ text: "" });
	});
});
