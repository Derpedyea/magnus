import { describe, expect, it } from "vitest";
import { encodedSize, insertBeforeQuote, isLinkToken, linkedMessageHtml, MAX_OUTBOUND_BYTES, newLinkToken, splitAttachments } from "./links";

const MB = 1_000_000;

describe("splitAttachments", () => {
	it("attaches everything that fits", () => {
		const files = [{ size: 1 * MB }, { size: 2 * MB }];
		expect(splitAttachments(files, 100)).toEqual({ attached: files, linked: [], fits: true });
	});
	it("links the largest files first, keeping the order of the rest", () => {
		const [pdf, video, photo] = [{ size: 0.2 * MB }, { size: 12 * MB }, { size: 3 * MB }];
		expect(splitAttachments([pdf, video, photo], 100)).toEqual({ attached: [pdf, photo], linked: [video], fits: true });
	});
	it("counts files as base64, so raw bytes under the limit can still be too big", () => {
		const photo = { size: 4.5 * MB };
		expect(photo.size).toBeLessThan(MAX_OUTBOUND_BYTES);
		expect(encodedSize(photo.size)).toBeGreaterThan(MAX_OUTBOUND_BYTES);
		expect(splitAttachments([photo], 0).linked).toEqual([photo]);
	});
	it("counts the body toward the limit", () => {
		const photo = { size: 3.5 * MB };
		expect(splitAttachments([photo], 0).linked).toEqual([]);
		expect(splitAttachments([photo], 0.5 * MB).linked).toEqual([photo]);
		expect(splitAttachments([photo], 5 * MB).fits).toBe(false);
	});
});

describe("insertBeforeQuote", () => {
	it("goes above a reply's quote, so Gmail doesn't fold it away", () => {
		const reply = "Here you go.\n\nOn 9/28/2026, Sam wrote:\n> can you send the video?\n> thanks";
		expect(insertBeforeQuote(reply, "LINKS")).toBe("Here you go.\n\nLINKS\n\nOn 9/28/2026, Sam wrote:\n> can you send the video?\n> thanks");
	});
	it("goes at the end when nothing is quoted below", () => {
		expect(insertBeforeQuote("Here you go.\n", "LINKS")).toBe("Here you go.\n\nLINKS");
		expect(insertBeforeQuote("On Monday, Sam wrote:\n> hi\n\nBottom-posted reply", "LINKS")).toBe(
			"On Monday, Sam wrote:\n> hi\n\nBottom-posted reply\n\nLINKS",
		);
	});
	it("stands alone in an empty message", () => {
		expect(insertBeforeQuote("", "LINKS")).toBe("LINKS");
	});
});

describe("newLinkToken", () => {
	it("is 128-bit base64url", () => {
		const token = newLinkToken();
		expect(isLinkToken(token)).toBe(true);
		expect(isLinkToken(`${token.slice(0, 21)}/`)).toBe(false);
	});
});

describe("linkedMessageHtml", () => {
	it("escapes what the sender wrote and puts the cards above the quote", () => {
		const html = linkedMessageHtml("See <this>\n\nOn Monday, Sam wrote:\n> hi", [
			{ filename: "clip.mp4", contentType: "video/mp4", size: 12_800_000, url: "https://mail.example.com/f/x/y" },
		]);
		expect(html).toContain("See &lt;this&gt;");
		expect(html.indexOf("clip.mp4")).toBeGreaterThan(html.indexOf("See"));
		expect(html.indexOf("clip.mp4")).toBeLessThan(html.indexOf("Sam wrote"));
	});
});
