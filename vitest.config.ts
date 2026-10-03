import { configDefaults, defineConfig } from "vitest/config";

// Logic tests run in Node; tests/ starts isolated Workers through Wrangler's local test harness.
// Both skip the app's Vite config so the test run doesn't start a development server.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, "scripts/setup.test.mjs"] } });
