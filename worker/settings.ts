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
