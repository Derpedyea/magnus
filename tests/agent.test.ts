import type { AgentReply, PendingAction } from "#shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RULES_MODEL } from "../worker/mail/rules";
import { fixture, type Fixture, inbound, type Mailboxes } from "./runtime/fixture";

describe("Mail agent", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	async function request(path: string, body: unknown) {
		const response = await f.worker.fetch(`https://magnus.test/api${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
		return { status: response.status, body: await response.json() };
	}
	const box = (mailboxId: string) => f.env.MAILBOX.getByName(mailboxId);
	async function deliver(mailboxId: string, id: string, subject: string) {
		return ((await box(mailboxId).ingest({ ...inbound(mailboxId, id), subject })) as { threadId: string }).threadId;
	}
	const labelsOf = async (mailboxId: string, threadId: string) => (await box(mailboxId).getThread(threadId))?.messages[0]?.labels.toSorted();
	const ask = (content: string) => request("/agent", { messages: [{ role: "user", content }] });

	it("does what's safe at once, as the person, in their mailboxes only", async () => {
		await box(ids.alice).addLabelDefs([{ key: "receipts", name: "Receipts", parent: null, color: null }]);
		const mine = await deliver(ids.alice, "mine", "Your receipt");
		const theirs = await deliver(ids.bob, "theirs", "Bob's receipt");
		await f.control.setModels({
			agent: [
				{ content: "Looking.", calls: [{ name: "search_mail", args: { query: "receipt" } }] },
				{
					calls: [
						{ name: "modify_threads", args: { threads: [{ mailboxId: ids.alice, threadId: mine }], add: ["receipts"], remove: ["inbox"] } },
						// Mail can name anyone's ids: a call with one of them changes nothing, here either.
						{ name: "modify_threads", args: { threads: [{ mailboxId: ids.alice, threadId: mine }, { mailboxId: ids.bob, threadId: theirs }], add: ["starred"] } },
					],
				},
				{ content: "Filed it." },
			],
		});

		expect(await ask("File my receipts")).toMatchObject({
			status: 200,
			body: {
				pending: null,
				messages: [
					{ role: "assistant", content: "Looking.", toolCalls: [{ name: "search_mail" }] },
					{ role: "tool", name: "search_mail", summary: "Searched “receipt” · 1 conversation", threads: [{ mailboxId: ids.alice, id: mine }] },
					{ role: "assistant", toolCalls: [{ name: "modify_threads" }, { name: "modify_threads" }] },
					{ role: "tool", summary: "Labeled “Receipts”, archived · 1 conversation" },
					{ role: "tool", summary: "Couldn't do that: None of their mailboxes has that id" },
					{ role: "assistant", content: "Filed it." },
				],
			},
		});
		expect(await labelsOf(ids.alice, mine)).toEqual(["receipts"]);
		expect(await labelsOf(ids.bob, theirs)).toEqual(["inbox"]);

		// The model reads what the tools found as the answers to its calls, and mail as untrusted data.
		const calls = (await f.control.state()).modelCalls.filter((c) => c.model === RULES_MODEL).map((c) => JSON.parse(c.inputs).messages);
		expect(calls).toHaveLength(3);
		expect(calls[0][0].content).toContain("UNTRUSTED DATA");
		expect(calls[1].at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1-0" });
		expect(JSON.parse(calls[1].at(-1).content).threads).toEqual([expect.objectContaining({ mailboxId: ids.alice, threadId: mine, subject: "Your receipt" })]);
	});

	it("asks before what could lose mail, one thing at a time, and does it once approved", async () => {
		const mine = await deliver(ids.alice, "mine", "Old newsletter");
		// Safe on its own, but after a call that asks: run at once, it could change what the person approves.
		const rule = { name: "Skip them", conditions: [{ field: "subject", op: "contains", value: "newsletter" }], actions: [{ do: "skip-inbox" }] };
		await f.control.setModels({
			agent: [
				{
					content: "I'll move it to Trash.",
					calls: [
						{ name: "modify_threads", args: { threads: [{ mailboxId: ids.alice, threadId: mine }], add: ["trash"] } },
						{ name: "create_rule", args: { mailboxId: ids.alice, rule } },
					],
				},
			],
		});

		const { body } = (await ask("Bin my newsletters")) as { body: AgentReply };
		expect(body).toMatchObject({
			messages: [{ role: "assistant" }, { role: "tool", name: "create_rule", summary: "Not done yet: waiting for your answer" }],
			pending: { name: "modify_threads", summary: "Move to Trash: 1 conversation.", threads: [{ id: mine }] },
		});
		expect(await labelsOf(ids.alice, mine)).toEqual(["inbox"]);
		expect(await box(ids.alice).rules()).toEqual([]);
		// It waits for the person, not the model.
		expect((await f.control.state()).modelCalls.filter((c) => c.model === RULES_MODEL)).toHaveLength(1);

		const pending = body.pending as PendingAction;
		expect(await request("/agent/approve", { action: pending })).toMatchObject({ status: 200, body: { message: { role: "tool", toolCallId: pending.id, summary: "Moved to Trash · 1 conversation" } } });
		expect(await labelsOf(ids.alice, mine)).toEqual(["trash"]);

		// Approving is checked as the model's call is: it can't reach past what the person could do.
		const theirs = await deliver(ids.bob, "theirs", "Bob's newsletter");
		const forged = { ...pending, args: { threads: [{ mailboxId: ids.bob, threadId: theirs }], add: ["trash"] } };
		expect(await request("/agent/approve", { action: forged })).toMatchObject({ body: { message: { summary: "Couldn't do that: None of their mailboxes has that id" } } });
		expect(await labelsOf(ids.bob, theirs)).toEqual(["inbox"]);
	});
});
