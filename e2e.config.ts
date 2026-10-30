import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

// `pnpm test:e2e` starts the app on a free port from fresh seeded state (scripts/e2e-serve.mjs) and stops it when done.
export default {
	tests: "e2e/**/*.e2e.ts",
	targets: [
		{
			engine: web(),
			app: {
				url: "http://127.0.0.1:0",
				command: {
					executable: "node",
					args: ["scripts/e2e-serve.mjs", "{port}"],
					// Wrangler's login, for the AI binding, which is remote even locally (wrangler.jsonc).
					inheritEnv: ["CLOUDFLARE_*", "WRANGLER_*"],
					startupTimeout: 120_000,
					log: ".e2e/logs/app.log",
				},
			},
		},
	],
} satisfies E2EConfig;
