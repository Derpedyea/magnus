import { describe, expect, it } from "vitest";
import { preview } from "./files";

describe("preview", () => {
	it("shows images, video, audio, and PDFs", () => {
		expect(preview({ contentType: "video/mp4", filename: "clip.mp4" })).toEqual({ type: "video/mp4", kind: "video" });
		expect(preview({ contentType: "application/pdf", filename: "a.pdf" })).toEqual({ type: "application/pdf", kind: "pdf" });
	});
	it("falls back to the extension for mail's usual application/octet-stream", () => {
		expect(preview({ contentType: "application/octet-stream", filename: "IMG_2041.JPG" })).toEqual({ type: "image/jpeg", kind: "image" });
	});
	it("never shows anything that can script, whatever it's called", () => {
		expect(preview({ contentType: "image/svg+xml", filename: "logo.svg" })).toBeNull();
		expect(preview({ contentType: "text/html", filename: "invoice.html" })).toBeNull();
		// A page dressed up as a photo is served as a photo, which browsers won't run.
		expect(preview({ contentType: "text/html", filename: "photo.png" })?.type).toBe("image/png");
	});
	it("downloads everything else", () => {
		expect(preview({ contentType: "application/zip", filename: "photos.zip" })).toBeNull();
	});
});
