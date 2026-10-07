import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUICK_MODEL } from "../worker/mail/checks";
import { fixture, type Fixture, job, type Mailboxes, sendInput } from "./runtime/fixture";

/** Verdicts Email Routing would stamp on mail that verifiably comes from outside.test. */
const VERIFIED = "dkim=pass header.d=outside.test; dmarc=pass header.from=outside.test; spf=pass smtp.mailfrom=bounce@outside.test";
/** Passes for the sending service only: anyone can write any From address this way. */
const FORGED = "dkim=pass header.d=bulk.test; dmarc=none; spf=pass smtp.mailfrom=bounce@bulk.test";
/** A sender the mailbox doesn't know, as the stand-in models judge everyone by default. */
const STRANGER = { kind: "checked", category: "personal", spam: 0, model: QUICK_MODEL };

describe("spam verdicts", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let serial = 0;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	/**
	 * Delivers mail from `from` with Email Routing's `stamped` verdicts, and returns it as stored. `inReplyTo` threads it
	 * under that message; `messageId` makes it a copy of one already sent.
	 */
	async function send(from: string, stamped: string, options: { inReplyTo?: string; messageId?: string } = {}) {
		const n = ++serial;
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${stamped}`, "X-CF-SpamH-Score: 1",
			`From: ${from}`, "To: alice@example.com", `Subject: Note ${n}`, `Message-ID: ${options.messageId ?? `<note-${n}@outside.test>`}`,
			...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []), "", `Body ${n}`, "",
		].join("\r\n");
		const input = job(ids.alice, `note-${n}`);
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: ids.alice } });
		await f.control.parse(input);
		return input.ingestId;
	}
	async function deliver(...args: Parameters<typeof send>) {
		const stored = await box().getMessage(await send(...args));
		if (!stored) throw new Error("Not delivered");
		return stored.message;
	}
	const writeTo = (address: string) => box().enqueueSend(sendInput(ids.alice, { to: [{ address }] }));
	const mark = (threadId: string, add: string[], remove: string[] = []) => box().modifyThreads({ threadIds: [threadId], add, remove });

	it("trusts verified mail from people this mailbox writes to, and not a forged From address", async () => {
		await writeTo("Friend@Outside.test");
		expect(await deliver("Friend <friend@outside.test>", VERIFIED)).toMatchObject({ verdict: { kind: "trusted" }, labels: ["inbox"] });
		expect(await deliver("Friend <friend@outside.test>", FORGED)).toMatchObject({ verdict: STRANGER, labels: ["inbox"] });
	});

	it("sends a sender's next mail to Spam once their mail is marked as spam, and back once it's taken out", async () => {
		const first = await deliver("pitch@outside.test", VERIFIED);
		expect(first.verdict).toEqual(STRANGER);
		await mark(first.threadId, ["spam"]);
		const second = await deliver("pitch@outside.test", VERIFIED);
		expect(second).toMatchObject({ verdict: { kind: "marked" }, labels: ["spam"] });
		await mark(second.threadId, ["inbox"], ["spam"]);
		expect(await deliver("pitch@outside.test", VERIFIED)).toMatchObject({ verdict: { kind: "trusted" }, labels: ["inbox"] });
	});

	it("reports a thread's one sender even if trusted, but not a trusted sender in a conversation with others", async () => {
		await writeTo("bob@outside.test");
		await writeTo("news@outside.test");
		const bob = await deliver("bob@outside.test", VERIFIED);
		await deliver("carol@outside.test", VERIFIED, { inReplyTo: bob.messageIdHeader ?? "" });
		await mark(bob.threadId, ["spam"]);
		expect((await deliver("bob@outside.test", VERIFIED)).verdict).toEqual({ kind: "trusted" });
		expect((await deliver("carol@outside.test", VERIFIED)).verdict).toEqual({ kind: "marked" });
		await mark((await deliver("news@outside.test", VERIFIED)).threadId, ["spam"]);
		expect((await deliver("news@outside.test", VERIFIED)).verdict).toEqual({ kind: "marked" });
	});

	it("doesn't report a trusted sender for unverified mail in their thread, even under their address", async () => {
		await writeTo("bob@outside.test");
		const bob = await deliver("bob@outside.test", VERIFIED);
		await deliver("Bob <bob@outside.test>", FORGED, { inReplyTo: bob.messageIdHeader ?? "" });
		await mark(bob.threadId, ["spam"]);
		expect((await deliver("bob@outside.test", VERIFIED)).verdict).toEqual({ kind: "trusted" });
	});

	it("takes Not spam mail out of Trash too", async () => {
		const pitch = await deliver("pitch@outside.test", VERIFIED);
		await mark(pitch.threadId, ["trash"]);
		await mark(pitch.threadId, ["spam"]);
		expect((await box().getMessage(pitch.id))?.message.labels.toSorted()).toEqual(["spam", "trash"]);
		await box().judgeMessage({ messageId: pitch.id, verdict: "trusted" });
		expect((await box().getMessage(pitch.id))?.message.labels).toEqual(["inbox"]);
	});

	it("takes one message out of Spam with Not spam, trusting only its sender", async () => {
		const first = await deliver("pitch@outside.test", VERIFIED);
		const reply = await deliver("other@outside.test", VERIFIED, { inReplyTo: first.messageIdHeader ?? "" });
		await mark(first.threadId, ["spam"]);
		expect(await box().judgeMessage({ messageId: reply.id, verdict: "trusted" })).toBe(true);
		expect((await box().getMessage(first.id))?.message.labels).toEqual(["spam"]);
		expect((await box().getMessage(reply.id))?.message.labels).toEqual(["inbox"]);
		expect((await deliver("other@outside.test", VERIFIED)).verdict).toEqual({ kind: "trusted" });
		expect((await deliver("pitch@outside.test", VERIFIED)).verdict).toEqual({ kind: "marked" });
		expect(await box().judgeMessage({ messageId: "nothing-here", verdict: "trusted" })).toBe(false);
	});

	it("keeps a message where its first copy went when a second copy arrives", async () => {
		const copy = await deliver("pitch@outside.test", VERIFIED);
		await mark((await deliver("pitch@outside.test", VERIFIED)).threadId, ["spam"]);
		await send("pitch@outside.test", VERIFIED, { messageId: copy.messageIdHeader ?? "" });
		expect((await box().getMessage(copy.id))?.message.labels).toEqual(["inbox"]);
	});

	it("trusts someone marked as spam again once this mailbox writes to them", async () => {
		await mark((await deliver("pitch@outside.test", VERIFIED)).threadId, ["spam"]);
		await writeTo("pitch@outside.test");
		expect((await deliver("pitch@outside.test", VERIFIED)).verdict).toEqual({ kind: "trusted" });
	});

	it("doesn't hold forged mail marked as spam against the address it claimed", async () => {
		await mark((await deliver("friend@outside.test", FORGED)).threadId, ["spam"]);
		expect(await deliver("friend@outside.test", VERIFIED)).toMatchObject({ verdict: STRANGER, labels: ["inbox"] });
	});

	it.each([
		["DMARC for its domain", "news@outside.test", VERIFIED, true],
		["DKIM for a parent domain", "news@mail.outside.test", "dkim=pass header.d=outside.test; dmarc=none", true],
		["SPF for the envelope sender's domain", "news@outside.test", "dkim=none; dmarc=none; spf=pass smtp.mailfrom=bounce@outside.test", true],
		["DKIM for a child domain, which could belong to anyone", "news@outside.test", "dkim=pass header.d=evil.outside.test; dmarc=none", false],
		["DMARC for another domain", "news@outside.test", "dmarc=pass header.from=other.test", false],
		["SPF for the HELO name only", "news@outside.test", "dmarc=none; spf=pass smtp.helo=outside.test", false],
	])("verifies the From address by %s: %s", async (_, from, stamped, verified) => {
		await writeTo(from);
		expect((await deliver(from, stamped)).verdict).toEqual(verified ? { kind: "trusted" } : STRANGER);
	});

	it("trusts verified mail from the install's own addresses", async () => {
		const ours = "dkim=pass header.d=example.com; dmarc=pass header.from=example.com";
		expect((await deliver("Bob <bob+notes@example.com>", ours)).verdict).toEqual({ kind: "trusted" });
		expect((await deliver("Bob <bob@example.com>", FORGED)).verdict).toEqual(STRANGER);
	});

	it("puts mail that fails its sender's authentication in Spam, even from someone trusted", async () => {
		await writeTo("friend@outside.test");
		expect(await deliver("friend@outside.test", "dkim=fail header.d=outside.test; dmarc=fail header.from=outside.test"))
			.toMatchObject({ verdict: { kind: "spoofed" }, labels: ["spam"] });
	});
});
