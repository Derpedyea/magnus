import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, job, type Mailboxes, MIME, NOW } from "./runtime/fixture";
import type { InboundJob } from "#shared";

const HOUR = 3600 * 1000;

describe("Failed", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	/** An original queued for these mailboxes, and alice's job for it. */
	async function store(mailboxes = [ids.alice]) {
		const input = job(ids.alice);
		await f.env.MAIL.put(input.rawKey, MIME, { customMetadata: { mailboxes: mailboxes.join(",") } });
		return input;
	}
	/** The job's last try fails reading the original. */
	async function giveUp(input: InboundJob) {
		await f.control.failNext("get", input.rawKey);
		return f.control.consume([input], 10);
	}
	const alice = () => f.env.MAILBOX.getByName(ids.alice);
	const inbox = (mailboxId = ids.alice) => f.env.MAILBOX.getByName(mailboxId).listThreads({ label: "inbox", limit: 50 });
	const request = (path: string, method = "GET") => f.worker.fetch(`https://magnus.test/api${path}`, { method, headers: { Cookie: cookie } });

	it("lists mail under Failed after its last try instead of dropping it", async () => {
		const input = await store();
		await f.control.failNext("get", input.rawKey);
		expect(await f.control.consume([input], 9)).toEqual({ acks: [], retries: [{ id: "0", delaySeconds: 3600 }] });
		expect(await alice().listFailed({})).toEqual([]);
		expect(await giveUp(input)).toEqual({ acks: ["0"], retries: [] });
		expect(await alice().listFailed({})).toEqual([
			{ id: input.ingestId, from: "sender@outside.test", to: "alice@example.com", size: 0, receivedAt: NOW, error: "Error: Injected get failure", retrying: false },
		]);
		expect((await alice().counts({})).failed).toBe(1);
		expect(await f.env.MAIL.head(input.rawKey)).not.toBeNull();
	});

	it("lists mail whose earlier tries ended without reporting, without parsing it again", async () => {
		const input = await store();
		expect(await f.control.consume([input], 11)).toEqual({ acks: ["0"], retries: [] });
		expect(await alice().listFailed({})).toMatchObject([{ id: input.ingestId, error: null }]);
		expect(await inbox()).toEqual([]);
	});

	it("keeps the job when listing it fails too, and lists it on the next try", async () => {
		const input = await store();
		await f.control.failNext("directory", "SELECT 1 AS ok FROM mailboxes", 2);
		expect(await f.control.consume([input], 10)).toEqual({ acks: [], retries: [{ id: "0", delaySeconds: 3600 }] });
		expect(await alice().listFailed({})).toEqual([]);
		expect(await f.control.consume([input], 11)).toEqual({ acks: ["0"], retries: [] });
		expect(await alice().listFailed({})).toMatchObject([{ id: input.ingestId }]);
	});

	it("retries from Failed, lists it again if that fails, and delivers it once it parses", async () => {
		const input = await store();
		await giveUp(input);
		expect((await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}/retry`, "POST")).status).toBe(204);
		expect((await f.control.state()).jobs).toEqual([input]);
		expect(await alice().listFailed({})).toMatchObject([{ retrying: true }]);

		await giveUp(input);
		expect(await alice().listFailed({})).toMatchObject([{ retrying: false }]);

		expect((await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}/retry`, "POST")).status).toBe(204);
		expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
		expect(await alice().listFailed({})).toEqual([]);
		expect((await alice().counts({})).failed).toBe(0);
		expect(await inbox()).toMatchObject([{ subject: "Receipt" }]);
	});

	it("serves the original, then deletes it for good once no mailbox holds it", async () => {
		const input = await store();
		await giveUp(input);
		const raw = await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}/raw`);
		expect(raw.headers.get("Content-Disposition")).toBe(`attachment; filename="${input.ingestId}.eml"`);
		expect(await raw.text()).toBe(MIME);

		expect((await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}`, "DELETE")).status).toBe(204);
		expect((await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}`, "DELETE")).status).toBe(404);
		expect(await alice().listFailed({})).toEqual([]);
		// A retry still in the queue can't bring it back.
		expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
		expect(await inbox()).toEqual([]);
		// The original waits out the inbound window, like any permanently deleted message's.
		await f.control.setNow(NOW + 25 * HOUR);
		await alice().drain();
		expect(await f.env.MAIL.head(input.rawKey)).toBeNull();
	});

	it("keeps a shared original another mailbox deletes while it's under Failed here", async () => {
		const input = await store([ids.alice, ids.bob]);
		await f.control.parse({ ...input, mailboxId: ids.bob });
		await giveUp(input);
		const bob = f.env.MAILBOX.getByName(ids.bob);
		const [thread] = await inbox(ids.bob);
		await bob.modifyThreads({ threadIds: [thread!.id], add: ["trash"] });
		await bob.deleteTrash({ threadId: thread!.id });
		await f.control.setNow(NOW + 25 * HOUR);
		await bob.drain();
		expect(await f.env.MAIL.head(input.rawKey)).not.toBeNull();
		expect(await (await request(`/mailboxes/${ids.alice}/failed/${input.ingestId}/raw`)).text()).toBe(MIME);
	});

	it("deletes the originals of a deleted mailbox's failed mail", async () => {
		const input = await store();
		await giveUp(input);
		await f.env.DIRECTORY.prepare("DELETE FROM mailboxes WHERE id = ?1").bind(ids.alice).run();
		await alice().destroy();
		expect(await f.env.MAIL.head(input.rawKey)).toBeNull();
	});

	it("lists only the mailboxes and addresses the request may see", async () => {
		const own = await store();
		await giveUp(own);
		const bobs = { ...job(ids.bob, "bob-1"), envelopeTo: "bob@example.com" };
		await f.env.MAILBOX.getByName(ids.bob).recordFailed(bobs, "boom");
		expect(await (await request("/failed")).json()).toMatchObject({ failed: [{ id: own.ingestId, mailboxId: ids.alice }] });
		expect(await (await request("/failed?in=alice@receive.test")).json()).toEqual({ failed: [] });
		expect(await (await request("/failed?in=bob@example.com")).json()).toEqual({ failed: [] });
		expect(await (await request("/counts?in=alice@receive.test")).json()).toMatchObject({ failed: 0 });
		expect((await request(`/mailboxes/${ids.bob}/failed/bob-1/raw`)).status).toBe(404);
	});
});
