import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, type Mailboxes, MIME, NOW } from "./runtime/fixture";
import { r2Keys } from "#shared";

describe("email() and inbound queue", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => { ids = await f.seed(); });
	const accept = (to = "alice@example.com", raw = MIME, from = "sender@outside.test") => f.worker.email({ from, to, raw });

	it("persists one raw copy before fan-out, with replayable jobs and the +tag", async () => {
		await accept("FAMILY+Receipts@Example.com");
		const { jobs } = await f.control.state();
		expect(jobs).toHaveLength(2);
		expect(jobs.map((j) => j.mailboxId)).toEqual([ids.alice, ids.bob]);
		for (const job of jobs) expect(job).toMatchObject({ v: 1, subaddress: "receipts", envelopeFrom: "sender@outside.test", envelopeTo: "FAMILY+Receipts@Example.com", receivedAt: NOW });
		const files = await f.env.MAIL.list();
		expect(files.objects).toHaveLength(1);
		const raw = await f.env.MAIL.get(jobs[0]!.rawKey);
		expect(await raw?.text()).toBe(MIME);
		expect(raw?.customMetadata).toEqual({ envelopeFrom: "sender@outside.test", envelopeTo: "FAMILY+Receipts@Example.com", mailboxes: `${ids.alice},${ids.bob}` });
		expect(jobs[1]!.rawKey).toBe(jobs[0]!.rawKey);
		expect(jobs[1]!.ingestId).toBe(jobs[0]!.ingestId);
	});

	it.each([
		["missing@example.com", "5.1.1 Mailbox unavailable"],
		["disabled@example.com", "5.1.1 Mailbox unavailable"],
		["alice@unknown.test", "5.1.2 Domain not handled here"],
	])("rejects %s during SMTP without storing or queuing it", async (to, reason) => {
		const result = await accept(to);
		expect(result).toMatchObject({ rejectReason: reason });
		expect((await f.env.MAIL.list()).objects).toEqual([]);
		expect((await f.control.state()).jobs).toEqual([]);
	});

	it("uses the catch-all for an unknown local part and rejects a domain whose receiving is off", async () => {
		await f.env.DIRECTORY.prepare("UPDATE domains SET catch_all_mailbox_id = ?1 WHERE name = 'example.com'").bind(ids.bob).run();
		await accept("unknown+News@example.com");
		expect((await f.control.state()).jobs).toMatchObject([{ mailboxId: ids.bob, subaddress: "news" }]);
		await f.env.DIRECTORY.prepare("UPDATE domains SET receiving = 0 WHERE name = 'example.com'").run();
		expect(await accept()).toMatchObject({ rejectReason: "5.1.2 Domain not handled here" });
	});

	it.each([
		["sender@outside.test", "sender@outside.test", MIME],
		["*@outside.test", "sender@outside.test", MIME],
		["blocked@header.test", "bounce@delivery.test", MIME.replace("Sender <sender@outside.test>", "Allowed <allowed@header.test>, Blocked <blocked@header.test>")],
	])("blocks %s against the envelope and every From header address", async (pattern, from, raw) => {
		await f.env.DIRECTORY.prepare("INSERT INTO sender_blocks (pattern) VALUES (?1)").bind(pattern).run();
		expect(await accept("alice@example.com", raw, from)).toMatchObject({ rejectReason: "5.7.1 Sender blocked" });
		expect((await f.env.MAIL.list()).objects).toEqual([]);
		expect((await f.control.state()).jobs).toEqual([]);
	});

	it.each(["directory", "put", "queue"] as const)("surfaces a %s failure; it never acknowledges acceptance without durable handoff", async (operation) => {
		await f.control.failNext(operation);
		expect(await accept()).toMatchObject({ outcome: "exception" });
		expect((await f.control.state()).jobs).toEqual([]);
		expect((await f.env.MAIL.list()).objects).toHaveLength(operation === "queue" ? 1 : 0);
	});

	it("acks successful jobs independently of a failing sibling and retries with bounded backoff", async () => {
		await accept("family@example.com");
		const { jobs } = await f.control.state();
		await f.control.failNext("put", r2Keys.mailbox(ids.bob));
		expect(await f.control.consume(jobs, 3)).toEqual({ acks: ["0"], retries: [{ id: "1", delaySeconds: 120 }] });
		expect(await f.env.MAILBOX.getByName(ids.alice).holding([jobs[0]!.ingestId])).toEqual([jobs[0]!.ingestId]);
		expect(await f.env.MAIL.head(jobs[0]!.rawKey)).not.toBeNull();
		await f.control.failNext("get", jobs[1]!.rawKey);
		expect(await f.control.consume([jobs[1]], 10)).toEqual({ acks: [], retries: [{ id: "0", delaySeconds: 3600 }] });
		expect(await f.control.consume([jobs[1]])).toEqual({ acks: ["0"], retries: [] });
	});
});
