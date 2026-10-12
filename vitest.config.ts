import { configDefaults, defineConfig } from "vitest/config";

// Logic tests run in Node; tests/ starts isolated Workers through Wrangler's local test harness.
// Both skip the app's Vite config so the test run doesn't start a development server.
// Tests gate every deploy, and Workers Builds machines can stall for seconds: a pause of about 5 s failed a
// test that usually finishes in 2 s there and stopped a release. 30 s still fails a test that hangs.
export default defineConfig({
	test: { exclude: [...configDefaults.exclude, "scripts/setup.test.mjs"], testTimeout: 30_000 },
});
