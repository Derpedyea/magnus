import { describe, expect, it } from "vitest";
import { isMbox, mboxBody, splitMbox } from "./mbox";

const MBOX = [
	"From 1848707889910060830@xxx Thu Nov 13 20:20:33 +0000 2025\r\n",
	"X-Gmail-Labels: Inbox,Opened\r\nSubject: one\r\n\r\nHi\r\n>From here\r\n>>From there\r\n> From a quote\r\n\r\n",
	"From - Mon Jan  1 00:00:00 2024\n",
	"Subject: two\n\nFrom the top, a line nobody escaped\n",
].join("");

/** A file read back a few bytes at a time, as a big one is: lines and `From ` lines cross chunks. */
function chunked(text: string, size: number): Blob {
	const bytes = new TextEncoder().encode(text);
	const blob = new Blob([bytes]);
	blob.stream = () => new ReadableStream({
		start(controller) {
			for (let at = 0; at < bytes.length; at += size) controller.enqueue(bytes.slice(at, at + size));
			controller.close();
		},
	});
	return blob;
}

async function split(blob: Blob) {
	const messages = [];
	for await (const message of splitMbox(blob)) messages.push({ headers: message.headers, escaped: message.escaped, body: await (await mboxBody(blob, message)).text() });
	return messages;
}

describe("splitMbox", () => {
	it.each([[1], [7], [1 << 20]])("splits messages read %i bytes at a time the same way", async (size) => {
		expect(await split(chunked(MBOX, size))).toEqual([
			{
				escaped: true,
				headers: "X-Gmail-Labels: Inbox,Opened\r\nSubject: one",
				// One `>` comes off each escaped line, and the blank line before the next message isn't this one's.
				body: "X-Gmail-Labels: Inbox,Opened\r\nSubject: one\r\n\r\nHi\r\nFrom here\r\n>From there\r\n> From a quote\r\n",
			},
			{ escaped: false, headers: "Subject: two", body: "Subject: two\n\nFrom the top, a line nobody escaped\n" },
		]);
	});

	it("tells an mbox by its first line", async () => {
		expect(await isMbox(new Blob([MBOX]))).toBe(true);
		expect(await isMbox(new Blob(["From the desk of\nnobody"]))).toBe(false);
		expect(await isMbox(new Blob(['{"Version":1}']))).toBe(false);
	});
});
