import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEEP_MODEL, QUICK_MODEL } from "../worker/mail/checks";
import { fixture, type Fixture, job, type Mailboxes, sendInput } from "./runtime/fixture";

const VERIFIED = "dkim=pass header.d=outside.test; dmarc=pass header.from=outside.test; spf=pass smtp.mailfrom=bounce@outside.test";

describe("checks by Workers AI", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let serial = 0;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	async function store(stamped = VERIFIED, body = "Hello there", headers: { subject?: string; messageId?: string; replyTo?: string } = {}) {
		const n = ++serial;
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${stamped}`, "X-CF-SpamH-Score: 1",
			"From: Stranger <stranger@outside.test>", "To: alice@example.com", `Subject: ${headers.subject ?? `Note ${n}`}`,
			`Message-ID: ${headers.messageId ?? `<check-${n}@outside.test>`}`, ...(headers.replyTo ? [`Reply-To: ${headers.replyTo}`] : []), "", body, "",
		].join("\r\n");
		const input = job(ids.alice, `check-${n}`);
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: ids.alice } });
		return input;
	}
	async function deliver(...args: Parameters<typeof store>) {
		const input = await store(...args);
		await f.control.parse(input);
		return (await box().getMessage(input.ingestId))?.message;
	}
	const calls = async () => (await f.control.state()).modelCalls;

	it.each([
		[0.95, "spam", "spam"],
		[0.1, "personal", "inbox"],
	])("lets Clef alone decide when it's sure: %s", async (quick, category, label) => {
		await f.control.setModels({ quick });
		expect(await deliver()).toMatchObject({ verdict: { kind: "checked", category, spam: quick, model: QUICK_MODEL }, labels: [label] });
		expect((await calls()).map((c) => c.model)).toEqual([QUICK_MODEL]);
	});

	it.each([
		["phishing", "spam"],
		["transactional", "inbox"],
	] as const)("asks Luna when Clef isn't sure, and goes by its answer: %s", async (deep, label) => {
		await f.control.setModels({ quick: 0.5, deep });
		expect(await deliver()).toMatchObject({ verdict: { kind: "checked", category: deep, spam: 0.5, model: DEEP_MODEL }, labels: [label] });
		expect((await calls()).map((c) => c.model)).toEqual([QUICK_MODEL, DEEP_MODEL]);
	});

	it("doesn't show mail from known or forged senders to the models", async () => {
		await f.control.setModels({ quick: 0.95 });
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "stranger@outside.test" }] }));
		expect((await deliver())?.verdict).toEqual({ kind: "trusted" });
		expect((await deliver("dkim=fail header.d=outside.test; dmarc=fail header.from=outside.test"))?.verdict).toEqual({ kind: "spoofed" });
		expect(await calls()).toEqual([]);
	});

	it("doesn't check a second copy of a message again", async () => {
		const first = await deliver();
		await f.control.parse(await store(VERIFIED, "Hello there", { messageId: first?.messageIdHeader ?? "" }));
		expect(await calls()).toHaveLength(1);
	});

	it.each(["fail", "garbage"] as const)("retries a model that %ss, then delivers to Spam as unchecked on the last try", async (quick) => {
		await f.control.setModels({ quick });
		const input = await store();
		expect(await f.control.consume([input], 1)).toEqual({ acks: [], retries: [{ id: "0", delaySeconds: 30 }] });
		expect(await box().getMessage(input.ingestId)).toBeNull();
		expect(await f.control.consume([input], 3)).toEqual({ acks: ["0"], retries: [] });
		expect((await box().getMessage(input.ingestId))?.message).toMatchObject({ verdict: { kind: "unchecked" }, labels: ["spam"] });
	});

	it("bounds what a message costs to check, and points out where its links go", async () => {
		await f.control.setModels({ quick: 0.5 });
		const replyTo = Array.from({ length: 50 }, (_, i) => `r${i}@outside.test`).join(", ");
		await deliver(VERIFIED, `Log in at https://Paypa1-secure.test/login now. ${"x".repeat(10_000)}`, { subject: "s".repeat(10_000), replyTo });
		const [quick, deep] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state).toMatchObject({ verifiedSender: true, linkDomains: ["paypa1-secure.test"] });
		expect(quick.state.body.length).toBe(4001);
		expect(quick.state.subject.length).toBe(201);
		expect(quick.state.replyTo).toHaveLength(5);
		expect(JSON.parse(deep.request.query.messages[1].content)).toEqual(quick.state);
		// Through the gateway's stored OpenRouter key, and out of its logs.
		expect(deep).toMatchObject({ id: "default", request: { provider: "openrouter", headers: { "cf-aig-collect-log": false } } });
		expect(deep.request.headers).not.toHaveProperty("Authorization");
	});
});
