import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUICK_MODEL } from "../worker/mail/checks";
import { fixture, type Fixture, inbound, job, type Mailboxes, sendInput } from "./runtime/fixture";

const VERIFIED = "dkim=pass header.d=outside.test; dmarc=pass header.from=outside.test; spf=pass smtp.mailfrom=bounce@outside.test";

describe("Screener", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let serial = 0;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		await box().updateSettings({ screener: true });
	});

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	/**
	 * `inReplyTo` threads it under that message; `stamped` replaces Email Routing's verdicts; `checkFailures` is how many
	 * checks of it already failed; `tag` is the +tag it was sent to.
	 */
	async function deliver(from = "new@outside.test", options: { inReplyTo?: string; stamped?: string; checkFailures?: number; tag?: string } = {}) {
		const n = ++serial;
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${options.stamped ?? VERIFIED}`, "X-CF-SpamH-Score: 1",
			`From: ${from}`, "To: alice@example.com", `Subject: Hello ${n}`, `Message-ID: <screen-${n}@outside.test>`,
			...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []), "", "Hi", "",
		].join("\r\n");
		const input = { ...job(ids.alice, `screen-${n}`), checkFailures: options.checkFailures, subaddress: options.tag ?? null };
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: ids.alice } });
		await f.control.parse(input);
		const stored = await box().getMessage(input.ingestId);
		if (!stored) throw new Error("Not delivered");
		return stored.message;
	}
	const labels = async (messageId: string) => (await box().getMessage(messageId))?.message.labels;

	it("holds first-time senders there, apart from account mail and spam", async () => {
		expect((await deliver()).labels).toEqual(["screener"]);
		await f.control.setModels({ quick: 0.5, deep: "transactional" });
		expect((await deliver()).labels).toEqual(["inbox"]);
		await f.control.setModels({ quick: 0.95 });
		expect((await deliver()).labels).toEqual(["spam"]);
		await f.control.setModels({ quick: "fail" });
		expect(await deliver("new@outside.test", { checkFailures: 2 })).toMatchObject({ verdict: { kind: "unchecked" }, labels: ["screener"] });
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "friend@outside.test" }] }));
		expect((await deliver("friend@outside.test")).labels).toEqual(["inbox"]);
	});

	it("lets all of a sender's held mail in at once, and their next mail goes to the inbox", async () => {
		const first = await deliver();
		const second = await deliver();
		const other = await deliver("other@outside.test");
		await box().modifyThreads({ threadIds: [first.threadId], add: ["inbox"], remove: ["screener"] });
		expect([await labels(first.id), await labels(second.id), await labels(other.id)]).toEqual([["inbox"], ["inbox"], ["screener"]]);
		expect(await deliver()).toMatchObject({ verdict: { kind: "trusted" }, labels: ["inbox"] });
	});

	it("sends all of a sender's held mail to Spam at once", async () => {
		const first = await deliver();
		const second = await deliver();
		await box().modifyThreads({ threadIds: [first.threadId], add: ["spam"] });
		expect([await labels(first.id), await labels(second.id)]).toEqual([["spam"], ["spam"]]);
		expect((await deliver()).labels).toEqual(["spam"]);
	});

	it.each(["trusted", "spam"] as const)("answers %s for one held message's sender only, not others in the thread", async (verdict) => {
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "bob@outside.test" }] }));
		const carol = await deliver("carol@outside.test");
		const bob = await deliver("bob@outside.test", { inReplyTo: carol.messageIdHeader ?? "" });
		const elsewhere = await deliver("carol@outside.test");
		expect([bob.labels, carol.labels]).toEqual([["inbox"], ["screener"]]);
		expect(carol.senderVerified).toBe(true);
		await box().judgeMessage({ messageId: carol.id, verdict });
		const place = verdict === "trusted" ? "inbox" : "spam";
		expect([await labels(bob.id), await labels(carol.id), await labels(elsewhere.id)]).toEqual([["inbox"], [place], [place]]);
		expect((await deliver("bob@outside.test")).verdict).toEqual({ kind: "trusted" });
	});

	it("doesn't hold a first-time sender's reply in a conversation already in the inbox or written in", async () => {
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "bob@outside.test" }] }));
		const bob = await deliver("bob@outside.test");
		expect((await deliver("carol@outside.test", { inReplyTo: bob.messageIdHeader ?? "" })).labels).toEqual(["inbox"]);
		const sent = await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "list@outside.test" }] }));
		// Sending gives it the Message-ID a reply names.
		await box().drain();
		const ours = await box().getMessage(sent?.id ?? "");
		await box().modifyThreads({ threadIds: [sent?.threadId ?? ""], remove: ["inbox"] });
		expect((await deliver("dave@outside.test", { inReplyTo: ours?.message.messageIdHeader ?? "" })).labels).toEqual(["inbox"]);
		// Their next conversation is new, so it's held.
		expect((await deliver("carol@outside.test")).labels).toEqual(["screener"]);
	});

	it("files a +screener or +spam tag as a label of its own, not a system view", async () => {
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "bob@outside.test" }] }));
		expect((await deliver("bob@outside.test", { tag: "Screener" })).labels.toSorted()).toEqual(["inbox", "screener-tag"]);
		expect((await deliver("bob@outside.test", { tag: "spam" })).labels.toSorted()).toEqual(["inbox", "spam-tag"]);
	});

	it("lets in all of a flood of held mail with one answer", async () => {
		const sender = { verified: "flood@outside.test", internal: false, spoofed: false };
		const check = { kind: "checked", category: "personal", spam: 0, model: QUICK_MODEL } as const;
		// All at once: one by one, 150 round trips can outlast the default timeout when every suite runs together.
		await Promise.all(Array.from({ length: 150 }, (_, i) =>
			box().ingest({ ...inbound(ids.alice, `flood-${i}`), messageIdHeader: `<flood-${i}@outside.test>`, subject: `Flood ${i}`, sender, check })));
		expect((await box().counts({})).labels.find((l) => l.label === "screener")?.threads).toBe(150);
		await box().judgeMessage({ messageId: "flood-0", verdict: "trusted" });
		const counts = (await box().counts({})).labels;
		expect([counts.find((l) => l.label === "screener"), counts.find((l) => l.label === "inbox")?.threads]).toEqual([undefined, 150]);
	}, 30_000);

	it("lets in only the message itself when its sender can't be verified", async () => {
		const unverified = "dkim=none; dmarc=none; spf=pass smtp.mailfrom=bounce@bulk.test";
		const held = await deliver("pal@nodkim.test", { stamped: unverified });
		expect(held).toMatchObject({ senderVerified: false, labels: ["screener"] });
		await box().judgeMessage({ messageId: held.id, verdict: "trusted" });
		expect(await labels(held.id)).toEqual(["inbox"]);
		expect((await deliver("pal@nodkim.test", { stamped: unverified })).labels).toEqual(["screener"]);
	});

	it("lets someone in once this mailbox writes to them", async () => {
		const held = await deliver();
		await box().enqueueSend(sendInput(ids.alice, { to: [{ address: "New@outside.test" }] }));
		expect(await labels(held.id)).toEqual(["inbox"]);
	});

	it("can only be seen or switched by the mailbox's members", async () => {
		await box().updateSettings({ screener: false });
		const call = async (user: "alice" | "bob", method: string, body?: unknown) =>
			f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/settings`, {
				method, headers: { Cookie: await f.login(user), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
			});
		expect((await call("bob", "PATCH", { screener: true })).status).toBe(404);
		expect((await call("bob", "GET")).status).toBe(404);
		expect(await box().settings()).toEqual({ screener: false });
		expect((await call("alice", "PATCH", { screener: true })).status).toBe(200);
		expect(await (await call("alice", "GET")).json()).toEqual({ screener: true });
		expect((await call("alice", "PATCH", { screener: "yes" })).status).toBe(400);
	});
});
