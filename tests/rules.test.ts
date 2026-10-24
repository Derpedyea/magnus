import type { IngestInput, Rule, RuleInput } from "#shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { QUICK_MODEL } from "../worker/mail/checks";
import { RULES_MODEL } from "../worker/mail/rules";
import { fixture, type Fixture, inbound, job, type Mailboxes, MIME } from "./runtime/fixture";

describe("Rules", () => {
	let f: Fixture;
	let ids: Mailboxes;
	let cookie: string;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		ids = await f.seed();
		cookie = await f.login("alice");
	});

	const box = () => f.env.MAILBOX.getByName(ids.alice);
	async function request(path: string, method = "GET", body?: unknown) {
		const response = await f.worker.fetch(`https://magnus.test/api${path}`, {
			method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: response.status === 204 ? null : await response.json() };
	}
	const rule = (input: Partial<RuleInput> & Pick<RuleInput, "name" | "actions">): RuleInput => ({ enabled: true, match: "all", conditions: [], ai: null, stop: false, ...input });
	async function create(input: RuleInput) {
		const created = await box().createRule(input, "user");
		if ("error" in created) throw new Error(created.error);
		return created as Rule;
	}
	async function deliver(id: string, change: Partial<IngestInput> = {}) {
		const result = await box().ingest({ ...inbound(ids.alice, id), ...change });
		if ("deleted" in result) throw new Error("Fixture message was deleted");
		return { ...result, message: (await box().getMessage(id))?.message };
	}
	const receipts = () => box().addLabelDefs([{ key: "receipts", name: "Receipts", parent: null, color: null }]);

	it("files new mail by the rules it matches, in order, until one stops, without judging senders or notifying for mail filed away", async () => {
		await receipts();
		const offers = await create(rule({ name: "Offers", conditions: [{ field: "subject", op: "contains", value: "offer" }], actions: [{ do: "spam" }], stop: true }));
		const filing = await create(rule({ name: "Receipts", conditions: [{ field: "subject", op: "contains", value: "receipt" }], actions: [{ do: "label", label: "receipts" }, { do: "skip-inbox" }, { do: "star" }] }));
		const read = await create(rule({ name: "Shop", conditions: [{ field: "from", op: "ends-with", value: "@outside.test" }], actions: [{ do: "mark-read" }], stop: true }));
		await create(rule({ name: "Mine", conditions: [{ field: "recipient", op: "is", value: "alice@example.com" }], actions: [{ do: "trash" }] }));
		const verified = { verified: "sender@outside.test", internal: false, spoofed: false };

		const filed = await deliver("receipt", { subject: "Your receipt", sender: verified });
		expect(filed.inbox).toBe(false);
		expect(filed.message).toMatchObject({ isRead: true, rules: [{ id: filing.id, name: "Receipts", reason: null }, { id: read.id, name: "Shop", reason: null }] });
		expect(filed.message?.labels.toSorted()).toEqual(["receipts", "starred"]);

		const spam = await deliver("offer", { subject: "An offer", sender: verified });
		expect(spam).toMatchObject({ inbox: false, message: { labels: ["spam"], rules: [{ id: offers.id }] } });
		const db = await f.worker.getDurableObjectStorage("MAILBOX", { name: ids.alice });
		expect(await db.exec("SELECT * FROM senders")).toEqual([]);

		const trashed = await deliver("hello", { from: { address: "friend@else.test" }, subject: "Hello" });
		expect(trashed).toMatchObject({ inbox: false, message: { labels: ["trash"], rules: [{ name: "Mine" }] } });
		// Elsewhere, no rule matches: it's new in the inbox, which notifies.
		expect(await deliver("family", { from: { address: "friend@else.test" }, subject: "Hello", envelopeTo: "family@example.com", to: [{ address: "family@example.com" }] })).toMatchObject({ inbox: true, message: { labels: ["inbox"], rules: [] } });
		// Forged mail goes to Spam whatever the rules say of it.
		expect(await deliver("forged", { subject: "Your receipt", sender: { verified: null, internal: false, spoofed: true } })).toMatchObject({ message: { labels: ["spam"], rules: [] } });

		await box().deleteTrash({});
		expect(await db.exec("SELECT message_id FROM rule_runs ORDER BY message_id")).toEqual([{ message_id: "offer" }, { message_id: "receipt" }, { message_id: "receipt" }]);
	});

	describe("with an AI condition", () => {
		async function queued() {
			const input = job(ids.alice);
			await f.env.MAIL.put(input.rawKey, MIME, { customMetadata: { mailboxes: ids.alice } });
			return input;
		}
		const models = async () => (await f.control.state()).modelCalls.map((c) => c.model);
		async function aiRules() {
			await receipts();
			// Its other condition matches a header of this mail; the second rule's doesn't match, so the model isn't asked about it.
			const bills = await create(rule({ name: "Bills", conditions: [{ field: "header", name: "Reply-To", op: "contains", value: "reply@outside.test" }], ai: "A receipt for something I bought", actions: [{ do: "label", label: "receipts" }] }));
			await create(rule({ name: "Invoices", conditions: [{ field: "subject", op: "contains", value: "invoice" }], ai: "An invoice", actions: [{ do: "star" }] }));
			return bills;
		}

		it.each([[true, ["inbox", "receipts"]], [false, ["inbox"]]])("files mail by the model's answer: %s", async (match, labels) => {
			const bills = await aiRules();
			await f.control.setModels({ rules: match });
			const input = await queued();
			await f.control.parse(input);
			const { message } = (await box().getMessage(input.ingestId))!;
			expect(message.labels.toSorted()).toEqual(labels);
			expect(message.rules).toEqual(match ? [{ id: bills.id, name: "Bills", reason: "Answer 1" }] : []);
			const call = (await f.control.state()).modelCalls.find((c) => c.model === RULES_MODEL)!;
			expect(JSON.parse(JSON.parse(call.inputs).messages[1].content).conditions).toEqual([{ rule: 1, condition: "A receipt for something I bought" }]);
		});

		it.each([["fails", "fail"], ["answers off-schema", "garbage"]] as const)("queues mail again when the model %s, without checking its sender again, then delivers it as if the rule didn't match", async (_, rules) => {
			await aiRules();
			await f.control.setModels({ rules });
			let input = await queued();
			for (const failures of [1, 2]) {
				expect(await f.control.consume([input])).toEqual({ acks: ["0"], retries: [] });
				expect(await box().getMessage(input.ingestId)).toBeNull();
				const again = (await f.control.state()).jobs.at(-1);
				expect(again).toMatchObject({ ruleFailures: failures, check: { kind: "checked", category: "personal" } });
				if (again) input = again;
			}
			await f.control.consume([input]);
			expect((await box().getMessage(input.ingestId))?.message).toMatchObject({ labels: ["inbox"], rules: [] });
			expect(await models()).toEqual([QUICK_MODEL, RULES_MODEL, RULES_MODEL, RULES_MODEL]);
		});

		it("doesn't show mail going to Spam to the model", async () => {
			await aiRules();
			await f.control.setModels({ quick: 0.95 });
			const input = await queued();
			await f.control.parse(input);
			expect((await box().getMessage(input.ingestId))?.message.labels).toEqual(["spam"]);
			expect(await models()).toEqual([QUICK_MODEL]);
		});
	});

	it("keeps a mailbox's rules for the people in it, with labels it has and within its limits", async () => {
		await receipts();
		const rules = `/mailboxes/${ids.alice}/rules`;
		const input = rule({ name: "Receipts", conditions: [{ field: "subject", op: "contains", value: "receipt" }], actions: [{ do: "label", label: "receipts" }] });
		expect(await request(`/mailboxes/${ids.bob}/rules`)).toMatchObject({ status: 404 });
		expect(await request(rules, "POST", { ...input, actions: [{ do: "label", label: "gone" }] })).toEqual({ status: 409, body: { error: "No label named “gone”" } });
		expect((await request(rules, "POST", { ...input, conditions: [] })).status).toBe(400);
		expect((await request(rules, "POST", { ...input, actions: [{ do: "star" }, { do: "star" }] })).status).toBe(400);

		const first = (await request(rules, "POST", input)).body as Rule;
		const second = (await request(rules, "POST", { ...input, name: "Stars", actions: [{ do: "star" }] })).body as Rule;
		expect((await request(`${rules}/${first.id}`, "PUT", { ...input, name: "Bought" })).body).toMatchObject({ id: first.id, name: "Bought", createdBy: "user" });
		expect((await request(`${rules}/order`, "POST", { ids: [second.id] })).status).toBe(409);
		expect((await request(`${rules}/order`, "POST", { ids: [second.id, first.id] })).status).toBe(204);
		expect(((await request(rules)).body as { rules: Rule[] }).rules.map((r) => r.name)).toEqual(["Stars", "Bought"]);
		expect((await request(`${rules}/${second.id}`, "DELETE")).status).toBe(204);
		expect((await request(`${rules}/${second.id}`, "DELETE")).status).toBe(404);

		for (let n = 0; n < 20; n++) await create(rule({ name: `AI ${n}`, ai: "Anything", actions: [{ do: "star" }] }));
		expect(await request(rules, "POST", { ...input, ai: "One more" })).toEqual({ status: 409, body: { error: "At most 20 rules can have an AI condition" } });
	});

	it("tries a rule on mail already here, and files what it matches", async () => {
		const receipt = await deliver("receipt", { subject: "Your receipt" });
		await deliver("news", { subject: "News", headers: [{ name: "list-id", value: "News <news.outside.test>" }] });
		await deliver("binned", { subject: "Old receipt", labels: ["trash"] });
		const rules = `/mailboxes/${ids.alice}/rules`;
		const input = rule({ name: "Receipts", conditions: [{ field: "subject", op: "contains", value: "receipt" }], actions: [{ do: "star" }] });

		expect((await request(`${rules}/preview`, "POST", input)).body).toMatchObject({ threads: [{ id: receipt.threadId }], matched: 1, scanned: 2, aiNotChecked: false });
		expect((await request(`${rules}/preview`, "POST", { ...input, conditions: [{ field: "mailing-list" }], ai: "Something I read" })).body).toMatchObject({ matched: 1, aiNotChecked: true });

		const saved = (await request(rules, "POST", input)).body as Rule;
		expect(await request(`${rules}/${saved.id}/apply`, "POST")).toEqual({ status: 200, body: { applied: 1 } });
		expect((await box().getMessage("receipt"))?.message).toMatchObject({ labels: ["inbox", "starred"], rules: [{ id: saved.id, name: "Receipts", reason: null }] });
		const ai = (await request(rules, "POST", { ...input, ai: "A receipt" })).body as Rule;
		expect((await request(`${rules}/${ai.id}/apply`, "POST")).status).toBe(409);
	});
});
