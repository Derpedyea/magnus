import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_IMPORT_BYTES } from "#shared/import";
import { PROTON_JOB_PHASES } from "#shared/proton-export";
import { fixture, type Fixture, type Mailboxes, NOW } from "./runtime/fixture";

const Job = z.object({
	id: z.string(),
	phase: z.enum(PROTON_JOB_PHASES),
	mine: z.boolean(),
	prompt: z.number().nullable(),
	verifyUrl: z.string().nullable(),
	error: z.string().nullable(),
	percent: z.number(),
	imported: z.number(),
	drafts: z.number(),
	tooBig: z.number(),
	unreadable: z.number(),
	unexported: z.number(),
	refusedCount: z.number(),
});
const Body = z.object({ job: Job.nullable() });

/** A message as Proton's Export Tool writes it, and its details beside it (go-lib/internal/mail in proton-mail-export). */
function message(id: string, overrides: { from?: string; subject?: string; labels?: string[]; unread?: 0 | 1; flags?: number } = {}) {
	const eml = [
		`From: ${overrides.from ?? "Sender <sender@outside.test>"}`, "To: Alice <alice@example.com>", `Subject: ${overrides.subject ?? id}`,
		"Date: Sun, 02 May 2021 09:00:00 +0000", `Message-ID: <${id}@outside.test>`, "Content-Type: text/plain; charset=utf-8", "", `Hello from ${id}`, "",
	].join("\r\n");
	const metadata = JSON.stringify({
		Version: 1,
		Payload: { ID: id, LabelIDs: overrides.labels ?? ["0", "5"], Unread: overrides.unread ?? 0, Flags: overrides.flags ?? 1, Time: 1619946000 },
	});
	return { eml, metadata };
}
const LABELS = JSON.stringify({ Version: 1, Payload: [{ ID: "custom==", Name: "Clients", Path: "Work/Clients", Type: 3 }] });

describe("importing from Proton on the server", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let alice: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		alice = await f.login("alice");
	});

	const url = (mailboxId: string, path = "") => `https://magnus.test/api/mailboxes/${mailboxId}/proton-import${path}`;
	const json = (cookie: string, body: unknown) => ({ method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const start = (mailboxId = ids.alice, cookie = alice) => f.worker.fetch(url(mailboxId), json(cookie, { login: "alice@proton.test", password: "hunter2" }));
	async function status(mailboxId = ids.alice, cookie = alice) {
		const res = await f.worker.fetch(url(mailboxId), { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		return Body.parse(await res.json()).job;
	}
	/** The import running now, as every action names it. */
	const current = async (mailboxId = ids.alice) => (await status(mailboxId))?.id ?? "00000000-0000-4000-8000-000000000000";
	const answer = async (prompt: number, value: string, mailboxId = ids.alice, cookie = alice, job?: string) =>
		f.worker.fetch(url(mailboxId, "/answer"), json(cookie, { job: job ?? (await current(mailboxId)), prompt, value }));
	const cancel = async (mailboxId = ids.alice, cookie = alice) => f.worker.fetch(url(mailboxId, "/cancel"), json(cookie, { job: await current(mailboxId) }));
	const clear = async (mailboxId = ids.alice, cookie = alice) =>
		f.worker.fetch(url(mailboxId, `?job=${await current(mailboxId)}`), { method: "DELETE", headers: { Cookie: cookie } });
	const drain = (mailboxId = ids.alice) => f.env.PROTON_IMPORT.getByName(mailboxId).drain();
	/** Started, signed in, and exporting. */
	async function exporting(mailboxId = ids.alice, cookie = alice) {
		expect((await start(mailboxId, cookie)).status).toBe(202);
		await f.control.setExport({ labels: LABELS, state: { phase: "exporting", percent: 10 } });
	}

	it("refuses people outside the mailbox", async () => {
		const bob = await f.login("bob");
		expect((await start(ids.alice, "")).status).toBe(401);
		expect((await start(ids.alice, bob)).status).toBe(404);
		expect((await f.worker.fetch(url(ids.alice), { headers: { Cookie: bob } })).status).toBe(404);
		expect((await f.control.exportState()).requests).toEqual([]);
	});

	it("hands the password to the container alone, and files each message where it was in Proton", async () => {
		const res = await start();
		expect(res.status).toBe(202);
		expect(Body.parse(await res.json()).job).toMatchObject({ phase: "signing-in", mine: true });
		const sent = (await f.control.exportState()).requests.find((r) => r.path === "/start");
		expect(sent?.body).toBe(JSON.stringify({ login: "alice@proton.test", password: "hunter2" }));
		// Nothing of the sign-in is kept: not the password, not the Proton address.
		const stored = JSON.stringify(await (await f.worker.getDurableObjectStorage("PROTON_IMPORT", { name: ids.alice })).exec("SELECT * FROM job"));
		expect(stored).not.toMatch(/hunter2|proton\.test/);

		await f.control.setExport({ labels: LABELS, state: { phase: "exporting", percent: 40 } });
		const inbox = message("inbox==", { labels: ["0", "5", "custom=="], unread: 1 });
		const sentMail = message("sent==", { from: "Alice <alice@example.com>", labels: ["2", "7", "5"], flags: 2 });
		const draft = message("draft==", { labels: ["1", "8"], flags: 0 });
		const other = message("other==");
		await f.control.exportMessage("inbox==", inbox.eml, inbox.metadata);
		await f.control.exportMessage("sent==", sentMail.eml, sentMail.metadata);
		await f.control.exportMessage("draft==", draft.eml, draft.metadata);
		// Details naming another message aren't this one's.
		await f.control.exportMessage("mismatch==", other.eml, other.metadata);
		await f.control.exportMessage("huge==", other.eml, message("huge==").metadata, MAX_IMPORT_BYTES + 1);
		await drain();

		const jobs = (await f.control.state()).jobs;
		expect(jobs.map((j) => j.imported)).toEqual(
			expect.arrayContaining([
				{ labels: ["inbox", "work-clients"], paths: ["Work/Clients"], read: false, sent: false, addresses: ["alice@example.com"] },
				{ labels: ["sent"], read: true, sent: true, addresses: ["alice@example.com"] },
			]),
		);
		expect(jobs).toHaveLength(2);
		// Its folder comes in as it was named there, inside the one it was in.
		await f.control.parse(jobs.find((j) => j.imported?.paths)!);
		const labels = await f.env.MAILBOX.getByName(ids.alice).labels();
		expect(labels.map((l) => [l.key, l.name, l.parent]).sort()).toEqual([["work", "Work", null], ["work-clients", "Clients", "work"]]);
		expect((await f.control.exportState()).messages).toEqual([]);
		expect(await status()).toMatchObject({ phase: "exporting", percent: 40, imported: 2, drafts: 1, unreadable: 1, tooBig: 1 });

		// The tool finishes; once nothing's left to file, the job ends and its container goes.
		await f.control.setExport({ state: { phase: "exported", percent: 100, unexported: 3 } });
		await drain();
		expect(await status()).toMatchObject({ phase: "done", percent: 100, imported: 2, unexported: 3 });
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(1);
		expect(await f.env.PROTON_IMPORT.getByName(ids.alice).alarmAt()).toBeNull();
		// Finished jobs are cleared from the page, and then another can start.
		expect((await clear()).status).toBe(200);
		expect(await status()).toBeNull();
	});

	it("runs one import per mailbox, and refuses a sixth sign-in in an hour", async () => {
		await exporting();
		expect((await start()).status).toBe(409);

		// Starts that fail still count: each was a sign-in to someone's Proton account.
		await f.control.setExport({ running: false, startFails: true });
		await drain();
		expect(await status()).toMatchObject({ phase: "failed" });
		await drain();
		for (let i = 0; i < 4; i++) {
			expect((await clear()).status).toBe(200);
			expect((await start()).status).toBe(202);
			expect(await status()).toMatchObject({ phase: "failed", error: "Couldn't start Proton's export tool. Try again in a few minutes." });
			await drain();
		}
		expect((await clear()).status).toBe(200);
		const refused = await start();
		expect(refused.status).toBe(429);
		await f.control.setNow(NOW + 3_600_001);
		expect((await start()).status).toBe(202);
	});

	it("asks only the starter Proton's questions, and refuses stale answers", async () => {
		const bob = await f.login("bob");
		expect((await start(ids.shared)).status).toBe(202);
		await f.control.setExport({ state: { phase: "needs-code", prompt: 1, error: "Incorrect code" } });
		await drain(ids.shared);
		expect(await status(ids.shared)).toMatchObject({ phase: "needs-code", prompt: 1, error: "Incorrect code", mine: true });
		expect(await status(ids.shared, bob)).toMatchObject({ phase: "needs-code", prompt: null, mine: false });

		expect((await answer(1, "123456", ids.shared, bob)).status).toBe(403);
		expect((await cancel(ids.shared, bob)).status).toBe(403);
		expect((await answer(2, "123456", ids.shared)).status).toBe(409);
		expect((await answer(1, "", ids.shared)).status).toBe(400);
		const ok = await answer(1, "123456", ids.shared);
		expect(ok.status).toBe(200);
		expect(Body.parse(await ok.json()).job).toMatchObject({ phase: "signing-in", prompt: null });
		// The same answer again (another tab) isn't passed on twice.
		expect((await answer(1, "123456", ids.shared)).status).toBe(409);
		expect((await f.control.exportState()).requests.filter((r) => r.path === "/answer").map((r) => r.body)).toEqual([JSON.stringify({ prompt: 1, value: "123456" })]);
	});

	it("stops when Proton's question goes unanswered for 15 minutes", async () => {
		await start();
		await f.control.setExport({ state: { phase: "needs-verification", prompt: 1, verifyUrl: "https://verify.proton.me/?token=t" } });
		await drain();
		expect(await status()).toMatchObject({ phase: "needs-verification", verifyUrl: "https://verify.proton.me/?token=t" });
		await f.control.setNow(NOW + 15 * 60_000 + 1);
		await drain();
		expect(await status()).toMatchObject({ phase: "cancelled", error: "Stopped: Proton's question went unanswered for 15 minutes.", verifyUrl: null });
		await drain();
		expect((await f.control.exportState()).requests.at(-1)?.path).toBe("/stop");
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(1);
	});

	it("files nothing more once cancelled, and lets the tool sign out before its container goes", async () => {
		await exporting();
		const m = message("waiting==");
		await f.control.exportMessage("waiting==", m.eml, m.metadata);
		expect((await cancel()).status).toBe(200);
		await drain();
		expect((await f.control.exportState()).requests.at(-1)?.path).toBe("/stop");
		expect((await f.control.state()).jobs).toEqual([]);
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(1);
		expect(await status()).toMatchObject({ phase: "cancelled", imported: 0 });
	});

	it("destroys a container whose tool won't say it stopped, once it's had time to sign out", async () => {
		await exporting();
		await cancel();
		await drain();
		await f.control.setExport({ state: { phase: "exporting" } });
		// The wrapper still says it's exporting.
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(0);
		await f.control.setNow(NOW + 30_001);
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(1);
	});

	it("keeps what was exported when the export fails partway", async () => {
		await exporting();
		const m = message("before==");
		await f.control.exportMessage("before==", m.eml, m.metadata);
		await f.control.setExport({ state: { phase: "failed", error: "write: no space left on device" } });
		await drain();
		expect((await f.control.state()).jobs).toHaveLength(1);
		await drain();
		expect(await status()).toMatchObject({ phase: "failed", error: "write: no space left on device", imported: 1 });
	});

	it("files a message again after a lost delete without counting or queuing it twice", async () => {
		await exporting();
		const m = message("once==");
		await f.control.exportMessage("once==", m.eml, m.metadata);
		await f.control.setExport({ deleteFailures: 1 });
		await drain();
		expect((await f.control.exportState()).messages).toEqual(["once=="]);
		await drain();
		expect((await f.control.exportState()).messages).toEqual([]);
		expect((await f.control.state()).jobs).toHaveLength(1);
		expect(await status()).toMatchObject({ phase: "exporting", imported: 1 });
	});

	it("fails as interrupted when the container is gone or came back fresh", async () => {
		await exporting();
		await f.control.setExport({ running: false });
		await drain();
		expect(await status()).toMatchObject({ phase: "failed", error: "The export was interrupted. Start again: mail that's already here is skipped." });
		await drain();

		expect((await clear()).status).toBe(200);
		await f.control.setExport({ running: true, state: { phase: "idle" } });
		await start();
		await f.control.setExport({ state: { phase: "idle" } });
		await drain();
		expect(await status()).toMatchObject({ phase: "failed", error: "The export was interrupted. Start again: mail that's already here is skipped." });
	});

	it("starting again files the same messages under the same ids", async () => {
		const m = message("again==");
		for (let round = 0; round < 2; round++) {
			await exporting();
			await f.control.exportMessage("again==", m.eml, m.metadata);
			await drain();
			await f.control.setExport({ state: { phase: "exported" } });
			await drain();
			await drain();
			expect((await clear()).status).toBe(200);
			await f.control.setExport({ state: { phase: "idle" } });
		}
		const queued = (await f.control.state()).jobs.map((j) => j.ingestId);
		expect(queued).toHaveLength(2);
		expect(queued[0]).toBe(queued[1]);
	});

	it("tries message details that fail on the way again, rather than taking them for unreadable", async () => {
		await exporting();
		const m = message("flaky==");
		await f.control.exportMessage("flaky==", m.eml, m.metadata);
		await f.control.setExport({ bodyFailures: 1 });
		await drain();
		expect((await f.control.exportState()).messages).toEqual(["flaky=="]);
		await drain();
		expect((await f.control.exportState()).messages).toEqual([]);
		expect(await status()).toMatchObject({ imported: 1, unreadable: 0 });
	});

	it("refuses an answer meant for an earlier import, even to the same question", async () => {
		await start();
		await f.control.setExport({ state: { phase: "needs-mailbox-password", prompt: 1 } });
		await drain();
		const earlier = await current();
		await cancel();
		await f.control.setExport({ running: false });
		await drain();
		expect((await clear()).status).toBe(200);
		await f.control.setExport({ state: { phase: "idle", prompt: 0 } });
		await start();
		await f.control.setExport({ state: { phase: "needs-mailbox-password", prompt: 1 } });
		await drain();
		expect(await current()).not.toBe(earlier);
		expect((await answer(1, "the other account's", ids.alice, alice, earlier)).status).toBe(409);
		expect((await f.control.exportState()).requests.filter((r) => r.path === "/answer")).toEqual([]);
	});

	it.each([
		["it was stopped", () => cancel()],
		["its starter left the mailbox", () => f.env.DIRECTORY.prepare("DELETE FROM mailbox_members WHERE user_id = 'alice'").run()],
	])("files nothing that was on its way when %s", async (_, act) => {
		await exporting();
		const m = message("inflight==");
		await f.control.exportMessage("inflight==", m.eml, m.metadata);
		await f.control.setExport({ hold: ["/eml"] });
		// Calls through the harness go out once something waits on them.
		const draining = drain().then(() => undefined);
		// Waits on the condition, not a clock: the message is on its way once its .eml has been asked for.
		for (let i = 0; i < 100 && !(await f.control.exportState()).requests.some((r) => r.path.endsWith("/eml")); i++) await new Promise((r) => setTimeout(r, 10));
		expect((await f.control.exportState()).requests.some((r) => r.path.endsWith("/eml"))).toBe(true);
		await act();
		await f.control.releaseExport();
		await draining;
		expect((await f.control.state()).jobs).toEqual([]);
	});

	it("finishes every message on its way before going on, even when one of them fails", async () => {
		await exporting();
		for (const id of ["first", "late"]) {
			const m = message(id);
			await f.control.exportMessage(id, m.eml, m.metadata);
		}
		// The first's delete fails while the other is still on its way.
		await f.control.setExport({ deleteFailures: 1, hold: ["/messages/late/metadata"] });
		let settled = false;
		const draining = drain().then(() => { settled = true; });
		const asked = async (method: string, path: string) => (await f.control.exportState()).requests.some((r) => r.method === method && r.path === path);
		for (let i = 0; i < 100 && !((await asked("DELETE", "/messages/first")) && (await asked("GET", "/messages/late/metadata"))); i++) await new Promise((r) => setTimeout(r, 10));
		expect(await asked("DELETE", "/messages/first")).toBe(true);
		// Still held, so the alarm can't have gone on (and let the job end and another start) without it.
		for (let i = 0; i < 20 && !settled; i++) await new Promise((r) => setTimeout(r, 10));
		expect(settled).toBe(false);
		await f.control.releaseExport();
		await draining;
		expect(await status()).toMatchObject({ imported: 2 });
	});

	it("refuses to start where no container can run, rather than leave a job nothing can clean up", async () => {
		await f.control.setExport({ unavailable: true });
		const refused = await start();
		expect(refused.status).toBe(503);
		expect(await status()).toBeNull();
		await f.control.setExport({ unavailable: false });
		expect((await start()).status).toBe(202);
	});

	it("destroys the container once it's had time to sign out, even when the wrapper stops answering", async () => {
		await exporting();
		await cancel();
		await f.control.setExport({ hang: ["/stop", "/state"] });
		// Each request is given up on (limits), so the alarm can't be held.
		await drain();
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(0);
		await f.control.setNow(NOW + 30_001);
		await drain();
		expect((await f.control.exportState()).destroyed).toBe(1);
	});

	it("passes a mailbox password on exactly as typed, and a code trimmed", async () => {
		await start();
		await f.control.setExport({ state: { phase: "needs-mailbox-password", prompt: 1 } });
		await drain();
		expect((await answer(1, " spaced out ")).status).toBe(200);
		await f.control.setExport({ state: { phase: "needs-code", prompt: 2 } });
		await drain();
		expect((await answer(2, " 123456 ")).status).toBe(200);
		expect((await f.control.exportState()).requests.filter((r) => r.path === "/answer").map((r) => JSON.parse(r.body).value)).toEqual([" spaced out ", "123456"]);
		expect((await answer(2, "123456\nyes")).status).toBe(400);
	});

	it("stops for someone no longer in the mailbox", async () => {
		await exporting(ids.shared);
		const m = message("shared==");
		await f.control.exportMessage("shared==", m.eml, m.metadata);
		await f.env.DIRECTORY.prepare("DELETE FROM mailbox_members WHERE mailbox_id = ?1 AND user_id = 'alice'").bind(ids.shared).run();
		await drain(ids.shared);
		expect(await status(ids.shared, await f.login("bob"))).toMatchObject({ phase: "cancelled", error: "Stopped: whoever started it is no longer in this mailbox." });
		expect((await f.control.state()).jobs).toEqual([]);
	});
});
