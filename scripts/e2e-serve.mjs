#!/usr/bin/env node
// Serves the app for end-to-end tests (e2e.config.ts starts it): `pnpm dev` on fresh local state with the dev seed,
// signed in as its admin. Usage: node scripts/e2e-serve.mjs <port>
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

const port = process.argv[2] ?? "5173";
const state = resolve(".wrangler/e2e");
const bin = (name) => resolve("node_modules/.bin", name);
const local = ["DIRECTORY", "--local", "--persist-to", state];

rmSync(state, { recursive: true, force: true });
execFileSync(bin("wrangler"), ["d1", "migrations", "apply", ...local], { stdio: "inherit" });
execFileSync(bin("wrangler"), ["d1", "execute", ...local, "--file", "scripts/seed-dev.sql"], { stdio: "inherit" });

const vite = spawn(bin("vite"), ["dev", "--host", "127.0.0.1", "--port", port, "--strictPort"], {
	stdio: "inherit",
	env: { ...process.env, MAGNUS_E2E_STATE: state },
});
vite.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
