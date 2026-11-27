import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixture, type Fixture, type Mailboxes } from "./runtime/fixture";

describe("outbound burst limits", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => {
		f = await fixture();
		ids = await f.seed();
		cookie = await f.login("alice");
	}, 30_000);
	afterAll(async () => { await f?.server.close(); });

	it("allows thirty sends a minute per user and refuses the next", async () => {
		const send = () => f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/send`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/json" },
			body: JSON.stringify({ from: "alice@example.com", to: [{ address: "friend@outside.test" }], subject: "Hi", text: "Hi" }),
		});
		for (let i = 0; i < 30; i++) expect((await send()).status).toBe(202);
		const refused = await send();
		expect(refused.status).toBe(429);
		expect(refused.headers.get("Retry-After")).toBe("60");
		expect(await refused.json()).toEqual({ error: "Too many sends. Try again in a minute." });
	}, 30_000);

	it("limits uploads separately", async () => {
		const upload = () => f.worker.fetch(`https://magnus.test/api/mailboxes/${ids.alice}/uploads`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "text/plain", "X-Filename": encodeURIComponent("note.txt") },
			body: "x",
		});
		for (let i = 0; i < 30; i++) expect((await upload()).status).toBe(201);
		const refused = await upload();
		expect(refused.status).toBe(429);
		expect(await refused.json()).toEqual({ error: "Too many uploads. Try again in a minute." });
	}, 30_000);
});
