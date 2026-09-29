import { z } from "zod";
import type { Sealed } from "./vault";

// Install-wide values the Worker learns rather than being configured with, in D1's `settings` table.

const InstallSchema = z.object({ accountId: z.string(), workerName: z.string() });

/** Where this install lives in Cloudflare, found by setup. Its presence means setup is done. */
export type Install = z.infer<typeof InstallSchema>;

export async function getInstall(db: D1Database): Promise<Install | null> {
	const row = await db.prepare(`SELECT value FROM settings WHERE key = 'install'`).first<{ value: string }>();
	return row ? InstallSchema.parse(JSON.parse(row.value)) : null;
}

/** The row doubles as a lock: of two setups racing, only one gets true. */
export async function claimInstall(db: D1Database, install: Install): Promise<boolean> {
	const { meta } = await db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('install', ?1)`).bind(JSON.stringify(install)).run();
	return meta.changes === 1;
}

/** Undoes a claim whose setup failed, so it can be tried again. */
export async function releaseInstall(db: D1Database): Promise<void> {
	await db.prepare(`DELETE FROM settings WHERE key = 'install'`).run();
}

/**
 * Signs session cookies. Generated on first use, so there's no secret to set when deploying. Anyone who can
 * read D1 can already read every session, so keeping it there adds no exposure.
 */
export async function authSecret(db: D1Database): Promise<string> {
	const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
	const [, stored] = await db.batch<{ value: string }>([
		db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('auth_secret', ?1)`).bind(fresh),
		db.prepare(`SELECT value FROM settings WHERE key = 'auth_secret'`),
	]);
	const secret = stored?.results[0]?.value;
	if (!secret) throw new Error("auth secret missing after insert");
	return secret;
}

// ─── Saved Cloudflare token ───────────────────────────────────────────────────
// Setup saves the token it was given, and admins can replace it, so turning domains on doesn't ask again. The Vault
// Durable Object encrypts it and keeps the key; only the ciphertext is here in D1, so neither store alone reveals it.

const TOKEN = "cloudflare_token";

const SealedSchema = z.object({ iv: z.string(), data: z.string() }) satisfies z.ZodType<Sealed>;

type Stores = Pick<Env, "DIRECTORY" | "VAULT">;

const vault = (env: Stores) => env.VAULT.getByName("vault");

export async function saveCloudflareToken(env: Stores, token: string): Promise<void> {
	const sealed = await vault(env).seal(token);
	await env.DIRECTORY.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(TOKEN, JSON.stringify(sealed))
		.run();
}

/** Null when none is saved, or the vault can't open it. */
export async function loadCloudflareToken(env: Stores): Promise<string | null> {
	const row = await env.DIRECTORY.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(TOKEN).first<{ value: string }>();
	return row ? vault(env).unseal(SealedSchema.parse(JSON.parse(row.value))) : null;
}

/** Deletes the vault's key too, so a copy of the ciphertext (in a D1 backup, say) can't be opened later. */
export async function forgetCloudflareToken(env: Stores): Promise<void> {
	await env.DIRECTORY.prepare(`DELETE FROM settings WHERE key = ?1`).bind(TOKEN).run();
	await vault(env).forget();
}

export async function hasCloudflareToken(db: D1Database): Promise<boolean> {
	return (await db.prepare(`SELECT 1 FROM settings WHERE key = ?1`).bind(TOKEN).first()) !== null;
}
