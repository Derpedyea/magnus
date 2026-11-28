// Turns raw messages (.eml files, or directories of them) into a mail set for run.mjs --mail, read as production
// reads them (facts-worker.ts). Every message gets the source's label; mail production would call spoofed is left
// out, as the models never see it.
//
//   node bench/models/import.mjs --label phishing --out set.json [--accept phishing,spam] [--limit 300] [--list paths.txt] <file|dir>…
//
// Real mail carries real people's addresses: keep the output out of the repository.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { label: { type: "string" }, accept: { type: "string" }, out: { type: "string" }, limit: { type: "string" }, source: { type: "string" }, list: { type: "string" } },
});
const LEGIT = ["personal", "transactional", "newsletter"];
const paths = [...positionals, ...(values.list ? readFileSync(values.list, "utf8").split("\n").filter(Boolean) : [])];
if (!values.label || !values.out || paths.length === 0) {
	console.error("usage: import.mjs --label <category|legit> --out set.json [--accept a,b] [--limit n] [--source name] [--list paths.txt] <file|dir>…");
	process.exit(1);
}
const legit = values.label === "legit";
const category = legit ? "personal" : values.label;
const accept = values.accept ? values.accept.split(",") : legit ? LEGIT : [category];

const files = paths.flatMap(function walk(p) {
	return statSync(p).isDirectory()
		? readdirSync(p)
				.sort()
				.flatMap((f) => walk(join(p, f)))
		: basename(p).startsWith(".") || basename(p) === "cmds"
			? []
			: [p];
});
const limit = values.limit ? Number(values.limit) : files.length;

const server = createTestHarness({
	workers: [{ config: { name: "magnus-bench-facts", main: "bench/models/facts-worker.ts", compatibility_date: "2026-09-26", compatibility_flags: ["nodejs_compat"] } }],
});
try {
	await server.listen();
	const worker = await server.getWorker().getExport();
	const mail = [];
	const skipped = { spoofed: 0, failed: 0, empty: 0 };
	for (const file of files) {
		if (mail.length >= limit) break;
		const raw = readFileSync(file);
		try {
			const { facts, spoofed, stamped, date } = await worker.facts(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
			if (spoofed) skipped.spoofed++;
			else if (!facts.from.address || (!facts.page.text && !facts.subject)) skipped.empty++;
			else {
				// The content's hash too: files of the same name in different directories are different messages.
				const id = `${values.source ?? "real"}:${basename(file)}:${createHash("sha256").update(raw).digest("hex").slice(0, 12)}`;
				mail.push({ id, category, accept, source: values.source ?? null, date, stamped, facts });
			}
		} catch {
			skipped.failed++;
		}
	}
	writeFileSync(values.out, JSON.stringify({ notes: `Imported ${new Date().toISOString()} from ${values.source ?? paths[0]}`, mail }));
	console.log(JSON.stringify({ kept: mail.length, of: files.length, skipped, verified: mail.filter((m) => m.facts.verifiedSender).length, stamped: mail.filter((m) => m.stamped).length }));
} finally {
	await server.close();
}
