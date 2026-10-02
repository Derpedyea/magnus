import assert from "node:assert/strict";
import { test } from "node:test";
import { setupFixture } from "./setup-fixture.mjs";

const account = { token: "fixture-token", zoneId: "zone", name: "Setup test", localPart: "me", email: "owner@example.net", moveMail: false };

async function client(fixture) {
	let cookies = "";
	return async (path, body) => {
		const res = await fixture.mf.dispatchFetch(`http://localhost/api${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), Cookie: cookies },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const set = res.headers.getSetCookie();
		if (set.length) cookies = set.map((cookie) => cookie.split(";")[0]).join("; ");
		return res;
	};
}

test("fresh install: ownership, atomic account, pending DNS, lost response, resume and finish", async (t) => {
	const fixture = await setupFixture();
	t.after(() => fixture.close());
	const request = await client(fixture);
	assert.equal((await (await request("/config")).json()).setupRequired, true);
	assert.equal((await request("/setup/verify", { token: "wrong-token" })).status, 400);
	assert.equal((await request("/setup/verify", { token: account.token })).status, 200);
	assert.equal((await request("/setup/complete", { ...account, email: "me@setup.example" })).status, 400);
	const created = await request("/setup/complete", account);
	assert.equal(created.status, 200, await created.clone().text());
	assert.equal((await (await request("/me")).json()).user.isAdmin, true);
	assert.equal((await (await request("/config")).json()).setupRequired, true);
	for (const step of ["routing", "catch-all", "sending", "events"]) {
		const res = await request(`/admin/domains/setup.example/steps/${step}`, { moveMail: false });
		assert.equal(res.status, 200, await res.clone().text());
	}
	assert.equal((await request("/setup/finish", { token: account.token })).status, 409);
	assert.equal((await request("/admin/domains/setup.example/steps/sending", {})).status, 200);
	assert.equal(fixture.state.sendingCreates, 1);
	await fixture.restart();
	// A new browser has no session cookie; the ownership token recovers the original committed account.
	const resumed = await client(fixture);
	const verified = await resumed("/setup/verify", { token: account.token });
	assert.equal(verified.status, 200, await verified.clone().text());
	assert.deepEqual((await verified.json()).claimed, { domain: "setup.example", address: "me@setup.example", moveMail: false });
	assert.equal((await resumed("/me")).status, 200);
	assert.equal((await resumed("/setup/complete", account)).status, 200);
	const directory = await (await resumed("/admin/directory")).json();
	assert.equal(directory.people.length, 1);
	assert.equal(directory.mailboxes.length, 1);
	assert.equal(directory.addresses.length, 1);
	fixture.state.dnsReady = true;
	assert.equal((await resumed("/setup/finish", { token: account.token })).status, 204);
	assert.equal((await resumed("/setup/finish", { token: account.token })).status, 204);
	assert.equal((await (await resumed("/config")).json()).setupRequired, false);
	assert.equal((await resumed("/setup/complete", account)).status, 409);
	assert.equal(fixture.state.subscriptions, 1);
});

test("session creation failure preserves setup and ownership can resume after a runtime restart", async (t) => {
	const fixture = await setupFixture();
	t.after(() => fixture.close());
	const request = await client(fixture);
	await request("/config");
	const db = await fixture.mf.getD1Database("DIRECTORY");
	await db.exec(`CREATE TRIGGER fail_session BEFORE INSERT ON auth_sessions BEGIN SELECT RAISE(ABORT, 'injected session failure'); END`);
	assert.equal((await request("/setup/complete", account)).status, 500);
	assert.equal((await db.prepare("SELECT count(*) AS n FROM auth_users").first()).n, 1);
	assert.equal((await (await request("/config")).json()).setupRequired, true);
	await db.exec("DROP TRIGGER fail_session");
	await fixture.restart();
	const resumed = await client(fixture);
	assert.equal((await resumed("/setup/verify", { token: account.token })).status, 200);
	assert.equal((await resumed("/me")).status, 200);
});

test("concurrent account creation leaves one complete directory; unconfirmed routing cannot finish", async (t) => {
	const fixture = await setupFixture();
	t.after(() => fixture.close());
	const first = await client(fixture);
	const second = await client(fixture);
	const results = await Promise.all([
		first("/setup/complete", account),
		second("/setup/complete", { ...account, email: "other@example.net", localPart: "other" }),
	]);
	assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
	const request = await client(fixture);
	assert.equal((await request("/setup/verify", { token: account.token })).status, 200);
	const directory = await (await request("/admin/directory")).json();
	assert.equal(directory.people.length, 1);
	assert.equal(directory.mailboxes.length, 1);
	assert.equal(directory.addresses.length, 1);
	fixture.state.ignoreCatchAll = true;
	assert.equal((await request(`/admin/domains/setup.example/steps/routing`, {})).status, 200);
	const res = await request(`/admin/domains/setup.example/steps/catch-all`, {});
	assert.equal((await res.json()).state, "todo");
	assert.equal((await request("/setup/finish", { token: account.token })).status, 409);
});

test("failed bootstrap rolls back all rows and can retry; foreign MX requires consent", async (t) => {
	const fixture = await setupFixture();
	t.after(() => fixture.close());
	const request = await client(fixture);
	await request("/config");
	const db = await fixture.mf.getD1Database("DIRECTORY");
	// Force a failure after the install/user/domain inserts, inside the real D1 transaction.
	await db.exec(`CREATE TRIGGER fail_mailbox BEFORE INSERT ON mailboxes BEGIN SELECT RAISE(ABORT, 'injected mailbox failure'); END`);
	assert.equal((await request("/setup/complete", account)).status, 500);
	assert.equal((await db.prepare("SELECT count(*) AS n FROM auth_users").first()).n, 0);
	assert.equal((await db.prepare("SELECT count(*) AS n FROM domains").first()).n, 0);
	assert.equal((await (await request("/config")).json()).setupRequired, true);
	await db.exec("DROP TRIGGER fail_mailbox");
	assert.equal((await request("/setup/complete", account)).status, 200);
	fixture.state.foreignMx = true;
	const blocked = await request(`/admin/domains/setup.example/steps/routing`, { moveMail: false });
	assert.equal((await blocked.json()).needsMoveMail, true);
	assert.equal(fixture.state.foreignMx, true);
	assert.equal((await request(`/admin/domains/setup.example/steps/routing`, { moveMail: true })).status, 200);
	assert.equal(fixture.state.foreignMx, false);
});
