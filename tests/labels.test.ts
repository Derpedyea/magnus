import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixture, type Fixture, inbound, type Mailboxes } from "./runtime/fixture";

describe("Labels", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	async function request(path: string, method = "GET", body?: unknown, session = cookie) {
		const response = await f.worker.fetch(`https://magnus.test/api${path}`, {
			method, headers: { Cookie: session, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: response.status === 204 ? null : await response.json() };
	}
	const labels = async (session = cookie) => ((await request("/labels", "GET", undefined, session)).body as { labels: { key: string; name: string; parent: string | null }[] }).labels;

	it("lists a label's mail with its sublabels', and moves sublabels up when it's deleted", async () => {
		expect((await request("/labels?in=alice%40example.com", "POST", { name: "Work" })).body).toMatchObject({ key: "work" });
		const clients = (await request("/labels?in=alice%40example.com", "POST", { name: "Clients", parent: "work", color: "blue" })).body;
		expect(clients).toEqual({ key: "work-clients", name: "Clients", parent: "work", color: "blue" });
		expect((await request("/labels?in=alice%40example.com", "POST", { name: "clients", parent: "work" })).status).toBe(409);

		const { threadId } = await f.env.MAILBOX.getByName(ids.alice).ingest(inbound(ids.alice)) as { threadId: string };
		expect((await request(`/mailboxes/${ids.alice}/threads/modify`, "POST", { threadIds: [threadId], add: ["work-clients"] })).status).toBe(204);
		const listed = (await request("/threads?label=work")).body as { threads: { id: string }[] };
		expect(listed.threads.map((t) => t.id)).toEqual([threadId]);
		const counts = (await request("/counts")).body as { labels: { label: string; unread: number }[] };
		expect(counts.labels.filter((c) => c.label.startsWith("work"))).toEqual(expect.arrayContaining([
			expect.objectContaining({ label: "work", unread: 1 }), expect.objectContaining({ label: "work-clients", unread: 1 }),
		]));

		expect((await request("/labels/work-clients", "PATCH", { parent: "work-clients" })).status).toBe(409);
		expect((await request("/labels/work", "DELETE")).status).toBe(204);
		expect(await labels()).toEqual([expect.objectContaining({ key: "work-clients", name: "Clients", parent: null })]);
		expect(((await request("/threads?label=work-clients")).body as { threads: unknown[] }).threads).toHaveLength(1);
	});

	it("takes a label into another mailbox when mail there gets it, where everyone sharing that mailbox sees it", async () => {
		await request("/labels?in=alice%40example.com", "POST", { name: "Receipts", color: "green" });
		const bob = await f.login("bob");
		expect(await labels(bob)).toEqual([]);

		const { threadId } = await f.env.MAILBOX.getByName(ids.shared).ingest(inbound(ids.shared)) as { threadId: string };
		const define = [{ key: "receipts", name: "Receipts", parent: null, color: "green" }];
		expect((await request(`/mailboxes/${ids.shared}/threads/modify`, "POST", { threadIds: [threadId], add: ["receipts"], define })).status).toBe(204);
		expect(await labels(bob)).toEqual([expect.objectContaining({ key: "receipts", name: "Receipts", color: "green" })]);
	});

	it.each([["outbox"], ["sent"], ["failed"]])("won't put mail under %s", async (label) => {
		expect((await request(`/mailboxes/${ids.alice}/threads/modify`, "POST", { threadIds: ["any"], add: [label] })).status).toBe(400);
	});
});
