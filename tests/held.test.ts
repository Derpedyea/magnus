import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, type Mailboxes, MIME, NOW } from "./runtime/fixture";

const ORIGIN = "https://magnus.test";
const DAY = 24 * 3600_000;

describe("holding mail for addresses not added yet", () => {
	let f: Fixture;
	let ids: Mailboxes;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		// example.com's mail moves here now, which opens its window.
		await f.control.setReceiving("example.com", false);
		await f.control.setReceiving("example.com", true);
	});

	const accept = (to: string) => f.worker.email({ from: "sender@outside.test", to, raw: MIME });
	const admin = async (path: string, method = "GET", body?: unknown) => f.worker.fetch(`${ORIGIN}/api/admin${path}`, {
		method, headers: { Cookie: await f.login("admin"), Origin: ORIGIN, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
	});
	const held = async () => (await f.env.DIRECTORY.prepare("SELECT address, raw_key, expires_at FROM held_mail ORDER BY address").all<{ address: string; raw_key: string; expires_at: number }>()).results;

	it("holds mail to an address not added yet in a domain's first 30 days, and adding the address delivers it", async () => {
		expect(await accept("New+Receipts@example.com")).not.toHaveProperty("rejectReason");
		// Turned off isn't the same as not added yet.
		expect(await accept("disabled@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
		const [row] = await held();
		expect(row).toMatchObject({ address: "new@example.com", expires_at: NOW + 30 * DAY });
		expect(await (await f.env.MAIL.get(row!.raw_key))?.text()).toBe(MIME);
		expect((await f.control.state()).jobs).toEqual([]);

		expect((await admin("/addresses", "POST", { localPart: "new", domain: "example.com", mailboxIds: [ids.alice] })).status).toBe(201);
		const { jobs } = await f.control.state();
		expect(jobs).toMatchObject([{ mailboxId: ids.alice, rawKey: row!.raw_key, envelopeTo: "New+Receipts@example.com", subaddress: "receipts", receivedAt: NOW }]);
		expect(await held()).toEqual([]);
		expect(await f.control.consume(jobs)).toEqual({ acks: ["0"], retries: [] });
		expect(await f.env.MAILBOX.getByName(ids.alice).holding([jobs[0]!.ingestId])).toEqual([jobs[0]!.ingestId]);
	});

	it("rejects again once the window ends, or once the domain holds its limit", async () => {
		await f.env.DIRECTORY.prepare("UPDATE domains SET receiving_since = ?1 WHERE name = 'example.com'").bind(NOW - 30 * DAY).run();
		expect(await accept("new@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
		await f.env.DIRECTORY.prepare("UPDATE domains SET receiving_since = ?1 WHERE name = 'example.com'").bind(NOW).run();
		await f.env.DIRECTORY.prepare(
			`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
			 INSERT INTO held_mail SELECT 'h' || i, 'guess' || i || '@example.com', 'example.com', 'x@outside.test', 'guess@example.com', 'x', '', 'held/h', 0, 0, ?1 FROM n`,
		).bind(NOW + DAY).run();
		expect(await accept("new@example.com")).toMatchObject({ rejectReason: "5.1.1 Mailbox unavailable" });
	});

	it("lets an admin deliver it elsewhere or discard it, and the cron delivers or deletes the rest", async () => {
		for (const to of ["elsewhere@example.com", "spam@example.com", "late@example.com", "expired@example.com"]) await accept(to);
		const listed = (await (await admin("/directory")).json()) as { held: { address: string; count: number; newest: { sender: string; subject: string } }[] };
		expect(listed.held).toHaveLength(4);
		expect(listed.held[0]).toMatchObject({ count: 1, newest: { sender: "sender@outside.test", subject: "Receipt" } });

		expect((await admin("/held/elsewhere@example.com/deliver", "POST", { mailboxIds: [ids.bob] })).status).toBe(204);
		expect((await f.control.state()).jobs).toMatchObject([{ mailboxId: ids.bob, envelopeTo: "elsewhere@example.com" }]);
		const spam = (await held()).find((h) => h.address === "spam@example.com")!;
		expect((await admin("/held/spam@example.com", "DELETE")).status).toBe(204);
		expect(await f.env.MAIL.head(spam.raw_key)).toBeNull();

		// Added without releasing it (say releasing failed), and one past its window.
		await f.env.DIRECTORY.batch([
			f.env.DIRECTORY.prepare("INSERT INTO addresses (address, domain) VALUES ('late@example.com', 'example.com')"),
			f.env.DIRECTORY.prepare("INSERT INTO address_routes VALUES ('late@example.com', ?1, 1)").bind(ids.alice),
			f.env.DIRECTORY.prepare("UPDATE held_mail SET expires_at = ?1 WHERE address = 'expired@example.com'").bind(NOW),
		]);
		const expired = (await held()).find((h) => h.address === "expired@example.com")!;
		await f.control.cleanHeld();
		expect((await f.control.state()).jobs.map((j) => j.envelopeTo)).toEqual(["elsewhere@example.com", "late@example.com"]);
		expect(await f.env.MAIL.head(expired.raw_key)).toBeNull();
		expect(await held()).toEqual([]);
	});
});
