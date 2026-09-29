import { describe, expect, it } from "vitest";
import { type ForwardedMessage, forwardedPart, withForward } from "./forward";

const original: ForwardedMessage = {
	from: { address: "sam@example.org", name: "Sam Rivera" },
	to: [{ address: "me@example.com" }],
	cc: [],
	subject: "Trip receipts",
	date: Date.UTC(2026, 8, 29, 8, 15),
	text: "Receipts attached.",
	html: null,
};

describe("forwardedPart", () => {
	it("keeps text-only mail text-only, with Gmail's header in the sender's time zone", () => {
		const body = withForward({ text: "Can you file these?\n" }, forwardedPart(original, "Europe/Berlin"));
		expect(body).toEqual({
			text: [
				"Can you file these?",
				"",
				"---------- Forwarded message ---------",
				"From: Sam Rivera <sam@example.org>",
				"Date: Tue, Sep 29, 2026, 10:15 AM GMT+2",
				"Subject: Trip receipts",
				"To: me@example.com",
				"",
				"Receipts attached.",
			].join("\n"),
		});
	});

	it("puts the note and header at the top of the original's body, so its styles still apply", () => {
		const html = `<html><head><style>td{color:red}</style></head><body class="x"><table><tr><td>$412</td></tr></table></body></html>`;
		const body = withForward({ text: "See <below>" }, forwardedPart({ ...original, html }));
		expect(body.html).toMatch(/^<html><head><style>td\{color:red\}<\/style><\/head><body class="x"><div>See &lt;below&gt;<\/div><br><div>---------- Forwarded message ---------<br>From: Sam Rivera &lt;sam@example.org&gt;<br>/);
		expect(body.html).toContain("</div><br><table>");
	});

	it("adds nothing above the header when there's no note", () => {
		const body = withForward({ text: "  \n" }, forwardedPart({ ...original, html: "<p>hi</p>" }));
		expect(body.text.startsWith("---------- Forwarded message ---------")).toBe(true);
		expect(body.html?.startsWith("<div>---------- Forwarded message ---------")).toBe(true);
	});
});
