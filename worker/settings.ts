import { r2Keys } from "#shared";
import { z } from "zod";

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
// Setup saves the token it was given, and admins can replace it, so turning domains on doesn't ask again. It's
// encrypted with AES-GCM: the ciphertext sits here in D1 and the key in R2, so neither store alone reveals it.
// Every save gets a fresh key, which keeps two saves at once from pairing a ciphertext with the wrong key.

const TOKEN = "cloudflare_token";

const SealedSchema = z.object({ keyId: z.string(), iv: z.string(), data: z.string() });

type Sealed = Omit<z.infer<typeof SealedSchema>, "keyId">;

type Stores = Pick<Env, "DIRECTORY" | "MAIL">;

export async function saveCloudflareToken(env: Stores, token: string): Promise<void> {
	const keyId = crypto.randomUUID();
	const { key, sealed } = await seal(token);
	await env.MAIL.put(r2Keys.key(keyId), key);
	const previous = await readSealed(env.DIRECTORY);
	await env.DIRECTORY.prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
		.bind(TOKEN, JSON.stringify({ keyId, ...sealed }))
		.run();
	if (previous) await env.MAIL.delete(r2Keys.key(previous.keyId));
}

/** Null when none is saved, or its key is gone. */
export async function loadCloudflareToken(env: Stores): Promise<string | null> {
	const stored = await readSealed(env.DIRECTORY);
	const key = stored && (await env.MAIL.get(r2Keys.key(stored.keyId)));
	return key ? unseal(new Uint8Array(await key.arrayBuffer()), stored) : null;
}

export async function forgetCloudflareToken(env: Stores): Promise<void> {
	const stored = await readSealed(env.DIRECTORY);
	await env.DIRECTORY.prepare(`DELETE FROM settings WHERE key = ?1`).bind(TOKEN).run();
	if (stored) await env.MAIL.delete(r2Keys.key(stored.keyId));
}

export async function hasCloudflareToken(db: D1Database): Promise<boolean> {
	return (await db.prepare(`SELECT 1 FROM settings WHERE key = ?1`).bind(TOKEN).first()) !== null;
}

async function readSealed(db: D1Database) {
	const row = await db.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(TOKEN).first<{ value: string }>();
	return row ? SealedSchema.parse(JSON.parse(row.value)) : null;
}

/** Encrypts under a fresh 256-bit key, returned raw for storing apart from the result. */
export async function seal(plaintext: string): Promise<{ key: Uint8Array<ArrayBuffer>; sealed: Sealed }> {
	const key = crypto.getRandomValues(new Uint8Array(32));
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(key), new TextEncoder().encode(plaintext));
	return { key, sealed: { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) } };
}

export async function unseal(key: Uint8Array<ArrayBuffer>, sealed: Sealed): Promise<string> {
	const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, await aesKey(key), fromBase64(sealed.data));
	return new TextDecoder().decode(data);
}

const aesKey = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
