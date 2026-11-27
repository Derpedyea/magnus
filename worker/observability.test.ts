import { describe, expect, it } from "vitest";
import type { EmailSendingEvent, InboundJob } from "#shared";
import { redactAddress, redactedInboundJob, redactedSendingEvent } from "./observability";

describe("observability redaction", () => {
	it("keeps an address useful for correlation without its local part", async () => {
		const redacted = await redactAddress("Sender+Tag@Example.com");
		expect(redacted).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{12}$/), domain: "example.com" });
		expect(await redactAddress("sender+tag@example.com")).toEqual(redacted);
	});

	it("keeps queue debugging fields without envelope or imported addresses", async () => {
		const job: InboundJob = {
			v: 1,
			ingestId: "inbound-1",
			rawKey: "raw/1",
			rawSize: 123,
			mailboxId: "mailbox-1",
			envelopeFrom: "sender@outside.test",
			envelopeTo: "alice+tag@example.com",
			subaddress: "tag",
			receivedAt: 1,
			check: { kind: "unchecked", error: "sender@outside.test" },
			imported: { labels: ["inbox"], read: true, sent: false, addresses: ["alice@example.com"] },
		};
		const redacted = await redactedInboundJob(job);
		expect(redacted).toMatchObject({ ingestId: "inbound-1", mailboxId: "mailbox-1", rawSize: 123, subaddress: "tag" });
		expect(redacted).not.toHaveProperty("check");
		expect(redacted.imported).not.toHaveProperty("addresses");
		const text = JSON.stringify(redacted);
		expect(text).not.toContain("sender@outside.test");
		expect(text).not.toContain("alice+tag@example.com");
		expect(text).not.toContain("alice@example.com");
		expect(text).toContain("outside.test");
	});

	it("summarizes sending events without recipients, subjects, or SMTP replies", async () => {
		const event: EmailSendingEvent = {
			type: "cf.email.sending.message.bounced",
			source: { type: "email.sending", zoneId: "zone", domain: "example.com" },
			payload: {
				eventId: "event-1",
				messageId: "provider-1",
				sender: "alice@example.com",
				recipient: "recipient@outside.test",
				subject: "Secret subject",
				terminal: true,
				delivery: { status: "bounced", smtpResponse: "recipient@outside.test rejected" },
			},
			metadata: { accountId: "account", eventTimestamp: "now" },
		};
		const redacted = await redactedSendingEvent(event);
		expect(redacted).toMatchObject({ type: event.type, messageId: "provider-1", status: "bounced" });
		const text = JSON.stringify(redacted);
		expect(text).not.toContain("alice@example.com");
		expect(text).not.toContain("recipient@outside.test");
		expect(text).not.toContain("Secret subject");
		expect(text).not.toContain("rejected");
	});
});
