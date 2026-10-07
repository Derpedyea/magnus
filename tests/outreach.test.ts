import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEEP_MODEL } from "../worker/mail/checks";
import { fixture, type Fixture, job, type Mailboxes } from "./runtime/fixture";

const VERIFIED = "dkim=pass header.d=outside.test; dmarc=pass header.from=outside.test; spf=pass smtp.mailfrom=bounce@outside.test";

describe("cold outreach", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let serial = 0;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		// Clef unsure, so Luna's category stands.
		await f.control.setModels({ quick: 0.5, deep: "outreach" });
	});

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	async function deliver() {
		const n = ++serial;
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${VERIFIED}`, "X-CF-SpamH-Score: 1",
			"From: Recruiter <hiring@outside.test>", "To: alice@example.com", `Subject: Role ${n}`, `Message-ID: <outreach-${n}@outside.test>`, "", "Open to a chat?", "",
		].join("\r\n");
		const input = job(ids.alice, `outreach-${n}`);
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: ids.alice } });
		await f.control.parse(input);
		return (await box().getMessage(input.ingestId))?.message;
	}

	it("goes to Spam unless the mailbox says otherwise, then arrives like other first-time mail", async () => {
		expect(await deliver()).toMatchObject({ verdict: { kind: "checked", category: "outreach", model: DEEP_MODEL }, labels: ["spam"] });
		await box().updateSettings({ outreachToSpam: false });
		expect((await deliver())?.labels).toEqual(["inbox"]);
		await box().updateSettings({ screener: true });
		expect((await deliver())?.labels).toEqual(["screener"]);
	});

	it("says the setting sent it to Spam only when it did, not when someone moved it there", async () => {
		expect((await deliver())?.verdict).toMatchObject({ category: "outreach", bySetting: true });
		await box().updateSettings({ outreachToSpam: false });
		const arrived = await deliver();
		await box().modifyThreads({ threadIds: [arrived?.threadId ?? ""], add: ["spam"] });
		const moved = (await box().getMessage(arrived?.id ?? ""))?.message;
		expect(moved?.labels).toEqual(["spam"]);
		expect(moved?.verdict).not.toHaveProperty("bySetting");
	});

	it("stops naming the setting once someone moves the mail out of Spam and back themselves", async () => {
		const placed = await deliver();
		expect(placed?.verdict).toMatchObject({ bySetting: true });
		await box().judgeMessage({ messageId: placed?.id ?? "", verdict: "trusted" });
		await box().modifyThreads({ threadIds: [placed?.threadId ?? ""], add: ["spam"] });
		const moved = (await box().getMessage(placed?.id ?? ""))?.message;
		expect(moved?.labels).toEqual(["spam"]);
		expect(moved?.verdict).toEqual({ kind: "checked", category: "outreach", spam: 0.5, model: DEEP_MODEL });
	});

	it("asks Luna when Clef is sure mail is unsolicited but not that it's only outreach", async () => {
		await box().updateSettings({ outreachToSpam: false });
		await f.control.setModels({ quick: { personal: 0.05, transactional: 0, newsletter: 0, outreach: 0.5, spam: 0, phishing: 0.45 }, deep: "phishing" });
		expect(await deliver()).toMatchObject({ verdict: { category: "phishing", model: DEEP_MODEL }, labels: ["spam"] });
	});

	it("changes one setting without undoing another", async () => {
		const patch = async (body: unknown) => (await f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/settings`, {
			method: "PATCH", headers: { Cookie: await f.login("alice"), "Content-Type": "application/json" }, body: JSON.stringify(body),
		})).json();
		expect(await patch({ screener: true })).toEqual({ screener: true, outreachToSpam: true });
		expect(await patch({ outreachToSpam: false })).toEqual({ screener: true, outreachToSpam: false });
	});
});
