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
	/** `html` makes it multipart/alternative, with `body` as its plain-text part. */
	/** `messageId: null` leaves the Message-ID header out. */
	async function store(stamped = VERIFIED, body = "Hello there", headers: { subject?: string; messageId?: string | null; replyTo?: string; html?: string } = {}) {
		const n = ++serial;
		const content = headers.html === undefined ? ["", body] : [
			'Content-Type: multipart/alternative; boundary="b"', "", "--b", "Content-Type: text/plain", "", body,
			"--b", "Content-Type: text/html", "", headers.html, "--b--",
		];
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${stamped}`, "X-CF-SpamH-Score: 1",
			"From: Stranger <stranger@outside.test>", "To: alice@example.com", `Subject: ${headers.subject ?? `Note ${n}`}`,
			...(headers.messageId === null ? [] : [`Message-ID: ${headers.messageId ?? `<check-${n}@outside.test>`}`]),
			...(headers.replyTo ? [`Reply-To: ${headers.replyTo}`] : []), ...content, "",
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

	it.each([["fails", "fail"], ["answers off-schema", "garbage"]] as const)("queues mail again when a model %s, then delivers it to Spam as unchecked on the third failure", async (_, quick) => {
		await f.control.setModels({ quick });
		let input = await store();
		for (const failures of [1, 2]) {
			expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
			expect(await box().getMessage(input.ingestId)).toBeNull();
			const queued = (await f.control.state()).jobs.at(-1);
			expect(queued).toEqual({ ...input, checkFailures: failures });
			if (queued) input = queued;
		}
		expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
		expect((await box().getMessage(input.ingestId))?.message).toMatchObject({ verdict: { kind: "unchecked" }, labels: ["spam"] });
	});

	it("doesn't count the queue's earlier failures against the checks", async () => {
		await f.control.setModels({ quick: "fail" });
		const input = await store();
		// Three tries already ended elsewhere, say R2 or D1 failing: this is the checks' first.
		await f.control.consume([input], 4);
		expect(await box().getMessage(input.ingestId)).toBeNull();
		expect((await f.control.state()).jobs.at(-1)).toMatchObject({ checkFailures: 1 });
	});

	it("leaves out HTML hidden from the recipient, so padding can't push what they see past what's read", async () => {
		await f.control.setModels({ quick: 0.5 });
		const padding = `<div style="display: none">${"Nothing to see. ".repeat(400)}</div><span hidden>${"More. ".repeat(400)}</span>`;
		await deliver(VERIFIED, "Lunch?", { html: `${padding}<p>Wire 4,000 USD to the account below.</p>` });
		const [quick] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state.body).toContain("Wire 4,000 USD");
		expect(quick.state.body).not.toContain("Nothing to see");
	});

	it.each([
		["a CSS comment", '<div style="/* display:none */">Wire the payment today.</div>'],
		["a custom property", '<div style="--note: display:none">Wire the payment today.</div>'],
		["over 200,000 characters of markup before it", `<!-- ${"x".repeat(250_000)} --><p>Wire the payment today.</p>`],
		["an unclosed hidden element in an earlier cell", '<table><tr><td><span style="display:none">gone</td><td>Wire the payment today.</td></tr></table>'],
		["a hidden image before it", '<img style="display:none" src="cid:x"><p>Wire the payment today.</p>'],
	])("reads visible text despite %s", async (_, html) => {
		await f.control.setModels({ quick: 0.5 });
		await deliver(VERIFIED, "Lunch?", { html });
		const [quick] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state.body).toContain("Wire the payment today.");
		expect(quick.state.body).not.toContain("gone");
	});

	it("records where links really go, and not links the recipient can't see", async () => {
		await f.control.setModels({ quick: 0.5 });
		const hiddenLinks = Array.from({ length: 50 }, (_, i) => `<a href="https://pad${i}.example/">.</a>`).join("");
		await deliver(VERIFIED, "See below", { html: `<div style="display:none">${hiddenLinks}</div>`
			+ '<a href="https://trusted.example@phish.example/login">Review</a><a href="https://&#112;hish2.example/x">e</a>'
			+ '<a href="https&colon;//phish3.example/">c</a><a hidden href="https://hidden.example/">h</a><a href="#top">top</a>' });
		const [quick] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state.linkDomains).toEqual(["phish.example", "phish2.example", "phish3.example"]);
	});

	it("doesn't show a deleted mailbox's mail to the models", async () => {
		const input = await store();
		// Deleted after the first check, while the message is read.
		await f.control.afterIO({ operation: "get", prefix: input.rawKey, mailboxId: ids.alice });
		await f.control.parse(input);
		expect(await calls()).toEqual([]);
	});

	it("finds protocol-relative links and bare IP hosts", async () => {
		await f.control.setModels({ quick: 0.5 });
		await deliver(VERIFIED, "See below", { html: '<a href="//phish.example/login">Review document</a> <a href="http://203.0.113.9/x">here</a> // not a link' });
		const [quick] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state.linkDomains).toEqual(["phish.example", "203.0.113.9"]);
	});

	it("doesn't check mail the queue redelivers after it was delivered, even without a Message-ID", async () => {
		const input = await store(VERIFIED, "Hello there", { messageId: null });
		await f.control.parse(input);
		await f.control.parse(input);
		expect(await calls()).toHaveLength(1);
	});

	it("checks the HTML the recipient sees, not a plain-text part that says something else", async () => {
		await f.control.setModels({ quick: 0.5 });
		await deliver(VERIFIED, "Lunch on Friday?", { html: "<p>Wire 4,000 USD to the account below before noon.</p>" });
		const [quick] = (await calls()).map((c) => JSON.parse(c.inputs));
		expect(quick.state.body).toContain("Wire 4,000 USD");
		expect(quick.state.body).not.toContain("Lunch");
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
		// Only providers that retain nothing.
		expect(deep.request.query.provider).toMatchObject({ zdr: true, data_collection: "deny" });
		expect(deep.request.headers).not.toHaveProperty("Authorization");
	});
});
