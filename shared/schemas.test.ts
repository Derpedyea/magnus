import { describe, expect, it } from "vitest";
import { toBase64Url } from "./base64url";
import { DraftSchema } from "./drafts";
import { ComposeSchema, PushSubscriptionSchema } from "./schemas";

const compose = {
	from: "alice@example.com",
	to: [{ address: "friend@outside.test" }],
	subject: "Hi",
	text: "Hi",
};

describe("outbound schemas", () => {
	it("turns control characters in a subject or name into spaces", () => {
		const parsed = ComposeSchema.parse({ ...compose, subject: "Re: Hi\r\nBcc: evil@outside.test", to: [{ address: "friend@outside.test", name: "\nFriend\tBcc: evil" }] });
		expect(parsed.subject).toBe("Re: Hi Bcc: evil@outside.test");
		expect(parsed.to[0]?.name).toBe("Friend Bcc: evil");
	});

	it("turns control characters in an attachment's name and type into spaces, so a draft saved with them still loads", () => {
		const parsed = DraftSchema.parse({ mailboxId: "mbx", from: "alice@example.com", to: [], cc: [], bcc: [], subject: "", text: "", attachments: [{ r2Key: "uploads/a", filename: "a\r\nb.pdf", contentType: "application/pdf\u0000", size: 1 }] });
		expect(parsed.attachments[0]).toMatchObject({ filename: "a b.pdf", contentType: "application/pdf " });
	});

	it("still accepts ordinary text", () => {
		expect(ComposeSchema.safeParse(compose).success).toBe(true);
	});
});

describe("push subscription endpoints", () => {
	const keys = { p256dh: toBase64Url(new Uint8Array(65).fill(4)), auth: toBase64Url(new Uint8Array(16).fill(1)) };
	const valid = (endpoint: string) => PushSubscriptionSchema.safeParse({ endpoint, keys }).success;

	it.each([
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://wns2-db5p.notify.windows.com/w/?token=abc",
		"https://web.push.apple.com/abc",
	])("accepts browser push service %s", (endpoint) => {
		expect(valid(endpoint)).toBe(true);
	});

	it.each([
		"https://push.example.net/abc",
		"https://fcm.googleapis.com.evil.test/abc",
		"https://evilfcm.googleapis.com/abc",
		"https://evil.notify.windows.com.evil.test/abc",
		"http://fcm.googleapis.com/fcm/send/abc",
	])("rejects non-service endpoint %s", (endpoint) => {
		expect(valid(endpoint)).toBe(false);
	});
});
