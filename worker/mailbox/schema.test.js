// The migration that freed the Screener's label, against real SQLite, on rows written before it.
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MIGRATIONS } from "./schema";

it("moves tags filed under view names to labels of their own, and leaves system labels alone", () => {
	const at = MIGRATIONS.findIndex((m) => m.includes("'screener-tag'"));
	const db = new DatabaseSync(":memory:");
	for (const migration of MIGRATIONS.slice(0, at)) db.exec(migration);
	db.exec(`INSERT INTO threads (id, subject, subject_key, last_message_at) VALUES ('t', 's', 's', 0)`);
	db.exec(`INSERT INTO messages (id, thread_id, direction, from_json, subject, date, received_at) VALUES ('m', 't', 'in', '{}', 's', 0, 0)`);
	for (const label of ["screener", "drafts", "failed", "spam", "drafts-tag"]) db.prepare(`INSERT INTO message_labels (message_id, label) VALUES ('m', ?)`).run(label);
	db.exec(MIGRATIONS[at] ?? "");
	const labels = db.prepare(`SELECT label FROM message_labels ORDER BY label`).all().map((r) => r.label);
	expect(labels).toEqual(["drafts-tag", "failed-tag", "screener-tag", "spam"]);
});
