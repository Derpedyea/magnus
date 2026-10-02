import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { dirname, resolve } from "node:path";
import { readFile, readdir } from "node:fs/promises";

/** Real Worker/D1/Vault/auth, with only Cloudflare's external API replaced by injected, controllable I/O. */
export async function setupFixture({ root = process.cwd(), port = 0 } = {}) {
	const state = {
		routing: false,
		catchAll: false,
		sending: false,
		dnsReady: false,
		events: false,
		sendingCreates: 0,
		subscriptions: 0,
		foreignMx: false,
		ignoreCatchAll: false,
		failPath: null,
	};
	const calls = [];
	// Cloudflare's button may rename the Worker. Follow Vite's generated deploy path instead of its default name.
	const deployPath = resolve(root, ".wrangler/deploy/config.json");
	const deploy = JSON.parse(await readFile(deployPath, "utf8"));
	if (typeof deploy.configPath !== "string") throw new Error("Vite didn't write a Worker deploy path");
	const workerRoot = dirname(resolve(dirname(deployPath), deploy.configPath));
	const modules = (await readdir(workerRoot, { recursive: true })).filter((path) => path.endsWith(".js"));
	const options = convertV4MiniflareOptions({
		name: "magnus-fixture",
		host: "127.0.0.1",
		port,
		modules: ["index.js", ...modules.filter((path) => path !== "index.js")].map((path) => ({ type: "ESModule", path: resolve(workerRoot, path) })),
		modulesRoot: workerRoot,
		compatibilityDate: "2026-09-26",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DIRECTORY: "fresh-directory" },
		r2Buckets: { MAIL: "fresh-mail" },
		durableObjects: { VAULT: { className: "Vault", useSQLite: true }, MAILBOX: { className: "Mailbox", useSQLite: true } },
		queueProducers: { INBOUND: "fresh-inbound" },
		queueConsumers: { "fresh-inbound": {}, "fresh-events": {} },
		versionMetadata: "CF_VERSION_METADATA",
		email: { send_email: [{ name: "EMAIL" }] },
		assets: {
			directory: resolve(root, "dist/client"),
			routerConfig: { has_user_worker: true },
			run_worker_first: ["/api/*", "/f/*"],
			assetConfig: { not_found_handling: "single-page-application" },
		},
		outboundService: async (request) => {
			const { pathname } = new URL(request.url);
			const path = pathname.replace("/client/v4", "");
			calls.push({ method: request.method, path });
			const ok = (result) => Response.json({ success: true, errors: [], result });
			const failure = (status, message) => Response.json({ success: false, errors: [{ code: 9999, message }], result: null }, { status });
			if (request.headers.get("Authorization") !== "Bearer fixture-token") return failure(401, "Invalid token");
			if (path === state.failPath) return failure(503, "Injected API outage");
			if (path === "/accounts") return ok([{ id: "account", name: "Setup test" }]);
			if (path === "/accounts/account/workers/scripts") return ok([{ id: "magnus-fixture" }]);
			if (path.startsWith("/accounts/account/workers/scripts/magnus-fixture/versions/")) return ok({});
			if (path === "/zones") return ok([{ id: "zone", name: "setup.example" }]);
			if (path === "/zones/zone") return ok({ id: "zone", name: "setup.example", account: { id: "account" } });
			if (path === "/zones/zone/dns_records") return ok(state.foreignMx ? [{ id: "foreign", content: "mx.google.com" }] : []);
			if (path === "/zones/zone/dns_records/foreign" && request.method === "DELETE") {
				state.foreignMx = false;
				return ok({});
			}
			if (path === "/zones/zone/email/routing/enable") {
				state.routing = true;
				return ok({});
			}
			if (path === "/zones/zone/email/routing") return ok({ enabled: state.routing, status: state.routing ? "ready" : "unconfigured" });
			if (path === "/zones/zone/email/routing/rules/catch_all") {
				if (request.method === "PUT" && !state.ignoreCatchAll) state.catchAll = true;
				return ok({ enabled: state.catchAll, actions: [{ type: "worker", value: ["magnus-fixture"] }] });
			}
			if (path === "/zones/zone/email/sending/subdomains") {
				if (request.method === "POST") {
					state.sending = true;
					state.sendingCreates++;
					return ok({});
				}
				return ok(state.sending ? [{ tag: "sending", name: "setup.example", enabled: true }] : []);
			}
			if (path === "/zones/zone/email/sending/subdomains/sending/dns/status") return ok({ errors: state.dnsReady ? [] : [{ code: "dkim.missing" }] });
			if (path === "/accounts/account/queues") return ok([{ queue_id: "events", consumers: [{ script: "magnus-fixture" }], producers: [] }]);
			if (path === "/accounts/account/event_subscriptions/subscriptions") {
				if (request.method === "POST") {
					state.events = true;
					state.subscriptions++;
					return ok({});
				}
				return ok(state.events ? [{ source: { domain: "setup.example" } }] : []);
			}
			throw new Error(`Unexpected Cloudflare call: ${request.method} ${path}`);
		},
	});
	const mf = new Miniflare(options);
	try {
		await mf.ready;
	} catch (error) {
		await mf.dispose();
		throw error;
	}
	return { mf, state, calls, restart: () => mf.setOptions(options), close: () => mf.dispose() };
}

// For collaborative-browser verification. No seeded rows, no dev sign-in bypass.
if (process.argv[1] === new URL(import.meta.url).pathname) {
	const fixture = await setupFixture({ root: process.argv[2], port: 5197 });
	fixture.state.dnsReady = process.argv[3] !== "pending";
	console.log(`SETUP_FIXTURE_READY: ${resolve(process.argv[2] ?? process.cwd())}/dist; fresh D1, no DEV_USER_EMAIL; http://127.0.0.1:5197`);
	process.once("SIGINT", async () => {
		await fixture.close();
		process.exit(0);
	});
	process.once("SIGTERM", async () => {
		await fixture.close();
		process.exit(0);
	});
}
