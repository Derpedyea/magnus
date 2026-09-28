import { defineConfig } from "vitest/config";

// Tests cover plain logic in shared/ and worker/, so they skip vite.config.ts and its Workers runtime.
export default defineConfig({});
