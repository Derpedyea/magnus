import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// End-to-end tests (scripts/e2e-serve.mjs) get their own seeded state, signed in as its admin, so they never touch yours.
const e2eState = process.env.MAGNUS_E2E_STATE;

export default defineConfig({
	// `@/` → src/, from tsconfig.app.json (shadcn's import alias).
	resolve: { tsconfigPaths: true },
	plugins: [
		// Generates src/routeTree.gen.ts from src/routes/ and code-splits each route. Must run before react().
		tanstackRouter({ target: "react", autoCodeSplitting: true }),
		react(),
		tailwindcss(),
		cloudflare(e2eState ? { persistState: { path: e2eState }, config: { vars: { DEV_USER_EMAIL: "dev@localhost" } } } : {}),
	],
});
