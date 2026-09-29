import { describe, expect, it } from "vitest";
import { retryAddressing } from "./retry";

describe("retryAddressing", () => {
	const sent = {
		to: [{ address: "Bob@example.org", name: "Bob" }],
		cc: [{ address: "carol@example.io" }],
		bcc: [{ address: "dan@example.net" }, { address: "erin@example.net" }],
	};

	it("sends mail that never left to everyone, as addressed", () => {
		const retry = retryAddressing(sent, null);
		expect(retry).toMatchObject({ to: sent.to, cc: sent.cc, bcc: sent.bcc });
		expect([...retry.recipients]).toEqual(["bob@example.org", "carol@example.io", "dan@example.net", "erin@example.net"]);
	});

	it("sends mail that went out only to whoever refused it", () => {
		const retry = retryAddressing(sent, new Set(["bob@example.org", "erin@example.net"]));
		expect(retry).toMatchObject({ to: sent.to, cc: [], bcc: [{ address: "erin@example.net" }] });
	});

	it("moves Cc'd recipients to an empty To, but never Bcc'd ones", () => {
		expect(retryAddressing(sent, new Set(["carol@example.io"]))).toMatchObject({ to: sent.cc, cc: [], bcc: [] });
		expect(retryAddressing(sent, new Set(["dan@example.net", "erin@example.net"]))).toMatchObject({ to: [], cc: [], bcc: sent.bcc });
	});

	it("has nobody to send to when nobody refused it", () => {
		expect(retryAddressing(sent, new Set()).recipients.size).toBe(0);
	});
});
