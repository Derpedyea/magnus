import { describe, expect, it } from "vitest";
import { encodedSize, isLinkToken, MAX_OUTBOUND_BYTES, newLinkToken, planAttachments, splitAttachments } from "./links";
import { noteBody } from "./markdown";

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

describe("planAttachments", () => {
	it("budgets for the HTML part, which carries the text again", () => {
		const video = { filename: "clip.mp4", contentType: "video/mp4", size: 12 * MB };
		const text = "x".repeat(2.5 * MB);
		// The text alone fits once the video is linked, but not once it's also carried in the HTML part.
		expect(splitAttachments([video], text.length).fits).toBe(true);
		expect(planAttachments([video], noteBody(text), "https://mail.example.com/f/mbx_1/").fits).toBe(false);
	});
	it("leaves messages with nothing to link alone", () => {
		const pdf = { filename: "a.pdf", contentType: "application/pdf", size: MB };
		expect(planAttachments([pdf], { text: "hi" }, "https://mail.example.com/f/mbx_1/")).toEqual({ attached: [pdf], linked: [], fits: true });
	});
});

describe("newLinkToken", () => {
	it("is 128-bit base64url", () => {
		const token = newLinkToken();
		expect(isLinkToken(token)).toBe(true);
		expect(isLinkToken(`${token.slice(0, 21)}/`)).toBe(false);
	});
});
