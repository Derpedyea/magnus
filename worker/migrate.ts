/**
 * Applies migrations/*.sql to D1 the first time each Worker instance touches it, so deploys (including the
 * Deploy to Cloudflare button) never need a separate migration step. Progress is kept in wrangler's own
 * `d1_migrations` table, so `wrangler d1 migrations apply` and the Worker agree on what has run.
 */
const FILES = import.meta.glob<string>("../migrations/*.sql", { query: "?raw", import: "default", eager: true });

const MIGRATIONS = Object.entries(FILES)
	.map(([path, sql]) => ({ name: path.slice(path.lastIndexOf("/") + 1), statements: splitStatements(sql) }))
	.sort((a, b) => a.name.localeCompare(b.name));

let migrated = false;

export async function migrate(db: D1Database): Promise<void> {
	// Only success is kept. A request's I/O is cancelled when its client hangs up, so sharing a run still in flight could
	// leave every later request waiting on it forever. Until one finishes, each request runs its own: a migration that
	// another got to first rolls back harmlessly (see apply). A failure throws, and the next request tries again.
	if (migrated) return;
	await apply(db);
	migrated = true;
}

async function apply(db: D1Database): Promise<void> {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS d1_migrations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT UNIQUE,
				applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
			)`,
		)
		.run();
	const { results } = await db.prepare(`SELECT name FROM d1_migrations`).all<{ name: string }>();
	const applied = new Set(results.map((r) => r.name));

	for (const { name, statements } of MIGRATIONS) {
		if (applied.has(name)) continue;
		try {
			// One batch is one transaction: the schema change and its record land together or not at all.
			await db.batch([...statements.map((sql) => db.prepare(sql)), db.prepare(`INSERT INTO d1_migrations (name) VALUES (?1)`).bind(name)]);
		} catch (error) {
			// Another instance may have applied it first, in which case our batch rolled back harmlessly.
			const done = await db.prepare(`SELECT 1 FROM d1_migrations WHERE name = ?1`).bind(name).first();
			if (!done) throw error;
		}
	}
}

/** Migration files hold plain DDL: no triggers, and no ';' or '--' inside string literals. */
export function splitStatements(sql: string): string[] {
	return sql
		.replaceAll(/--[^\n]*/g, "")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
}
