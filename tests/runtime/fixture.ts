import { createTestHarness } from "wrangler";
import type { TestEnv } from "./worker";
import { NOW } from "./clock";
import type * as WorkerModule from "./worker";
import { type InboundJob, type IngestInput, r2Keys, type SendInput } from "#shared";

export { NOW };

// Each suite owns a runtime; each case gets fresh D1 rows, R2 objects, and distinct DO names.
export async function fixture() {
	const server = createTestHarness({ workers: [{ config: {
		name: "magnus-tests", main: "tests/runtime/worker.ts", compatibility_date: "2026-09-26", compatibility_flags: ["nodejs_compat"],
		d1_databases: [{ binding: "DIRECTORY", database_name: "test-directory", database_id: "test-directory", migrations_dir: "migrations" }],
		r2_buckets: [{ binding: "MAIL", bucket_name: "test-mail" }],
		durable_objects: { bindings: [{ name: "MAILBOX", class_name: "Mailbox" }, { name: "VAULT", class_name: "Vault" }] },
		migrations: [{ tag: "v1", new_sqlite_classes: ["Mailbox", "Vault"] }],
		version_metadata: { binding: "CF_VERSION_METADATA" },
		vars: { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", DEV_USER_EMAIL: "" },
	} }] });
	const worker = server.getWorker<TestEnv, typeof WorkerModule>();
	async function open() {
		await server.listen();
		await worker.applyD1Migrations("DIRECTORY");
		return { env: await worker.getEnv(), control: await worker.getExport() };
	}
	let { env, control } = await open().catch(async (error: unknown) => {
		await server.close();
		throw error;
	});
	let serial = 0;
	let generation = 0;

	async function restart() {
		// Reload the whole Worker so cached RPC references cannot keep the old DO instance alive.
		// Wrangler retains local storage across update(), unlike reset().
		await server.update((options) => ({ ...options, workers: options.workers.map((input) => "config" in input
			? { config: { ...input.config, vars: { ...input.config.vars, TEST_GENERATION: ++generation } } }
			: input) }));
		env = await worker.getEnv();
		control = await worker.getExport();
	}

	async function seed() {
		await control.reset();
		await env.DIRECTORY.batch(["domains", "mailboxes", "auth_users", "settings", "sender_blocks"].map((table) => env.DIRECTORY.prepare(`DELETE FROM ${table}`)));
		const files = await env.MAIL.list();
		if (files.objects.length) await env.MAIL.delete(files.objects.map((o) => o.key));
		const ids = { alice: `alice-${++serial}`, bob: `bob-${serial}`, shared: `shared-${serial}` };
		await env.DIRECTORY.batch([
			...[
				["alice", "Alice", "alice@login.test", "user"], ["bob", "Bob", "bob@login.test", "user"], ["admin", "Admin", "admin@login.test", "admin"],
			].map(([id, name, email, role]) => env.DIRECTORY.prepare("INSERT INTO auth_users (id, name, email, role, emailVerified, createdAt, updatedAt) VALUES (?1, ?2, ?3, ?4, 1, 1, 1)").bind(id, name, email, role)),
			...Object.entries(ids).map(([name, id]) => env.DIRECTORY.prepare("INSERT INTO mailboxes (id, name) VALUES (?1, ?2)").bind(id, name)),
			...[ [ids.alice, "alice", "owner"], [ids.bob, "bob", "owner"], [ids.shared, "alice", "member"], [ids.shared, "bob", "member"] ]
				.map(([mailbox, user, role]) => env.DIRECTORY.prepare("INSERT INTO mailbox_members VALUES (?1, ?2, ?3)").bind(mailbox, user, role)),
			env.DIRECTORY.prepare("INSERT INTO domains (name, receiving, sending) VALUES ('example.com', 1, 1), ('receive.test', 1, 0)"),
			...["alice@example.com", "bob@example.com", "family@example.com", "readonly@example.com", "disabled@example.com", "alice@receive.test"]
				.map((address) => env.DIRECTORY.prepare("INSERT INTO addresses (address, domain, enabled) VALUES (?1, ?2, ?3)").bind(address, address.split("@")[1], address !== "disabled@example.com" ? 1 : 0)),
			...[ ["alice@example.com", ids.alice, 1], ["bob@example.com", ids.bob, 1], ["family@example.com", ids.alice, 1], ["family@example.com", ids.bob, 1],
				["readonly@example.com", ids.alice, 0], ["disabled@example.com", ids.alice, 1], ["alice@receive.test", ids.alice, 1] ]
				.map(([address, mailbox, canSend]) => env.DIRECTORY.prepare("INSERT INTO address_routes VALUES (?1, ?2, ?3)").bind(address, mailbox, canSend)),
		]);
		return ids;
	}

	async function login(user: "alice" | "bob" | "admin") {
		return (await control.login(`${user}@login.test`)).map((cookie) => cookie.split(";")[0]).join("; ");
	}

	return { server, worker, get env() { return env; }, get control() { return control; }, seed, login, restart };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Mailboxes = Awaited<ReturnType<Fixture["seed"]>>;

export function inbound(mailboxId: string, id = "inbound-1"): IngestInput {
	return {
		id, rawKey: r2Keys.raw(id, NOW), envelopeFrom: "sender@outside.test", envelopeTo: "alice@example.com", receivedAt: NOW,
		messageIdHeader: `<${id}@outside.test>`, inReplyTo: [], references: [], from: { address: "sender@outside.test" }, to: [{ address: "alice@example.com" }],
		cc: [], replyTo: [], subject: "Secret letter", date: NOW, text: "Secret content", htmlKey: r2Keys.html(mailboxId, id), attachments: [], auth: null,
		sender: { verified: null, internal: false, spoofed: false }, check: null, labels: [],
	};
}

export function sendInput(mailboxId: string, overrides: Partial<SendInput> = {}): SendInput {
	return {
		mailboxId, from: { address: "alice@example.com", name: "Alice" }, to: [{ address: "recipient@outside.test" }], cc: [], bcc: [],
		subject: "Hello", markdown: "Hello **world**", attachments: [], links: [], linkBase: `https://magnus.test/f/${mailboxId}/`, delayMs: 0, localRecipients: [], localOnly: false, ...overrides,
	};
}

export function job(mailboxId: string, id = "inbound-1"): InboundJob {
	return { v: 1, ingestId: id, rawKey: r2Keys.raw(id, NOW), rawSize: 0, mailboxId, envelopeFrom: "sender@outside.test", envelopeTo: "alice@example.com", subaddress: null, receivedAt: NOW };
}

/** Email Routing's verdicts, as it stamps them above the sender's headers. */
export const STAMPED = "dkim=pass header.d=outside.test; dmarc=pass header.from=outside.test; spf=pass smtp.mailfrom=sender@outside.test";

export const MIME = [
	`Authentication-Results: mx.cloudflare.net; ${STAMPED}`, "X-CF-SpamH-Score: 1",
	"From: Sender <sender@outside.test>", "To: Alice <alice@example.com>", "Cc: Friend <friend@outside.test>", "Reply-To: Replies <reply@outside.test>",
	"Subject: Receipt", "Date: Tue, 01 Jan 2030 00:00:00 +0000", "Message-ID: <receipt@outside.test>", "In-Reply-To: <parent@outside.test>",
	"References: <root@outside.test> <parent@outside.test>",
	"MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="parts"', "", "--parts", 'Content-Type: multipart/alternative; boundary="body"', "",
	"--body", "Content-Type: text/plain; charset=utf-8", "", "Your receipt", "--body", "Content-Type: text/html; charset=utf-8", "", "<p>Your <b>receipt</b></p>",
	"--body--", "--parts", 'Content-Type: application/pdf; name="receipt.pdf"', 'Content-Disposition: attachment; filename="receipt.pdf"', "Content-Transfer-Encoding: base64", "", "JVBERg==",
	"--parts", 'Content-Type: image/png; name="logo.png"', "Content-Disposition: inline", "Content-ID: <logo>", "Content-Transfer-Encoding: base64", "", "cG5n", "--parts--", "",
].join("\r\n");
