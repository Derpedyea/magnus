import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, job, type Mailboxes, STAMPED } from "./runtime/fixture";

describe("unsubscribing from list mail", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	let serial = 0;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	/** Delivers list mail to alice+news@ offering `list`, and returns its id. */
	async function deliver(list: string | null) {
		const n = ++serial;
		const raw = [
			`Authentication-Results: mx.cloudflare.net; ${STAMPED}`, "X-CF-SpamH-Score: 1",
			"From: News <news@outside.test>", "To: alice+news@example.com", `Subject: Issue ${n}`, `Message-ID: <issue-${n}@outside.test>`,
			...(list ? [`List-Unsubscribe: ${list}`] : []), "", `Issue ${n}`, "",
		].join("\r\n");
		const input = { ...job(ids.alice, `issue-${n}`), envelopeTo: "alice+news@example.com", subaddress: "news" };
		await f.env.MAIL.put(input.rawKey, raw, { customMetadata: { mailboxes: ids.alice } });
		await f.control.parse(input);
		return input.ingestId;
	}
	const unsubscribe = (messageId: string) =>
		f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/messages/${messageId}/unsubscribe`, { method: "POST", headers: { Cookie: cookie } });

	it("asks the list by email from the address the mail came to, once, and offers the page when that's all there is", async () => {
		const byMail = await deliver("<mailto:leave+t0k3n@outside.test?subject=Remove%20me>, <http://outside.test/leave>");
		expect((await box().getMessage(byMail))?.message.unsubscribe).toBe(true);
		for (let i = 0; i < 2; i++) {
			const res = await unsubscribe(byMail);
			expect(await res.json()).toEqual({ done: "mail" });
		}
		const sent = await box().getMessage(`unsubscribe-${byMail}`);
		expect(sent?.message).toMatchObject({ direction: "out", from: { address: "alice@example.com" }, to: [{ address: "leave+t0k3n@outside.test" }], subject: "Remove me" });

		const byPage = await deliver("<https://outside.test/leave?u=1>");
		expect(await (await unsubscribe(byPage)).json()).toEqual({ page: "https://outside.test/leave?u=1" });

		const none = await deliver(null);
		expect((await box().getMessage(none))?.message.unsubscribe).toBe(false);
		expect((await unsubscribe(none)).status).toBe(404);
	});
});
