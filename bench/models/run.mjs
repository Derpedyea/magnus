// Benchmarks models for Magnus's model calls against the real AI binding. Costs a few cents a run.
//
//   CLOUDFLARE_ACCOUNT_ID=… node bench/models/run.mjs <quick|deep|rules|agent> <model,…> [--concurrency 4] [--limit n] [--repeat n, agent only] [--out dir]
//   node bench/models/run.mjs report [--out dir]
//
// quick: the decision model checkMail() asks first; mail it isn't sure of is answered with the true category, so its
//        errors are its own confident ones. deep: every message reaches the deep model (an OpenRouter model through the
//        account's `default` gateway, or a Workers AI one). rules: checkRules(). agent: converse() on bench/models/agent.ts.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runnerImport } from "vite";
import { getPlatformProxy } from "wrangler";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { concurrency: { type: "string", default: "4" }, limit: { type: "string" }, repeat: { type: "string", default: "1" }, out: { type: "string", default: join(tmpdir(), "magnus-bench") } },
});
const [role, list] = positionals;
const out = values.out;
const { module: bench } = await runnerImport(join(here, "bench.ts"), { root, configFile: false, logLevel: "error" });

if (role === "report") report();
else if (["quick", "deep", "rules", "agent"].includes(role) && list) await run(role, list.split(","), Number(values.concurrency));
else {
	console.error("usage: run.mjs <quick|deep|rules|agent> <model,…> | report");
	process.exit(1);
}

async function run(role, models, concurrency) {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!account) throw new Error("Set CLOUDFLARE_ACCOUNT_ID: the AI binding runs on that account");
	const config = join(tmpdir(), `magnus-bench-${process.pid}.json`);
	writeFileSync(config, JSON.stringify({ name: "magnus-bench", account_id: account, compatibility_date: "2026-09-26", ai: { binding: "AI", remote: true } }));
	const proxy = await getPlatformProxy({ configPath: config, remoteBindings: true });
	mkdirSync(out, { recursive: true });
	try {
		const b = { ai: proxy.env.AI };
		const mail = bench.loadMail(join(here, "mail.json")).slice(0, values.limit ? Number(values.limit) : undefined);
		for (const model of models) {
			const t0 = performance.now();
			const verdicts =
				role === "quick"
					? await bench.classify(b, mail, { quick: model, oracle: true }, concurrency)
					: role === "deep"
						? await bench.classify(b, mail, { deep: model, forceDeep: true }, concurrency)
						: role === "rules"
							? await bench.rules(b, mail, model, concurrency)
							: await bench.agent(b, model, concurrency, Number(values.repeat));
			// What the models said stays out of the file: it's the mail, and big. Usage and timing stay.
			const kept = verdicts.map((v) => ({ ...v, calls: v.calls.map(({ raw, ...c }) => (role === "quick" ? { ...c, probabilities: raw?.answers?.category?.probabilities } : c)) }));
			writeFileSync(join(out, `${role}--${model.replaceAll("/", "_")}.json`), JSON.stringify({ role, model, at: new Date().toISOString(), verdicts: kept }, null, 1));
			console.log(`${role} ${model}: ${Math.round((performance.now() - t0) / 1000)} s`, JSON.stringify(score(role, verdicts)));
		}
	} finally {
		await proxy.dispose();
		rmSync(config, { force: true });
	}
}

function score(role, verdicts) {
	return role === "quick" ? bench.scoreQuick(verdicts) : role === "rules" ? bench.scoreRules(verdicts) : role === "agent" ? bench.scoreAgent(verdicts) : bench.scoreClassify(verdicts);
}

function report() {
	const files = readdirSync(out)
		.filter((f) => f.endsWith(".json"))
		.map((f) => JSON.parse(readFileSync(join(out, f), "utf8")));
	for (const role of ["quick", "deep", "rules", "agent"]) {
		const rows = files.filter((f) => f.role === role);
		if (rows.length === 0) continue;
		console.log(`\n## ${role}\n`);
		const scored = rows.map((r) => ({ model: r.model, ...score(role, r.verdicts) }));
		const cols = Object.keys(scored[0]).filter((k) => !["aloneWrong", "failures"].includes(k));
		console.log(`| ${cols.join(" | ")} |\n|${cols.map(() => " --- ").join("|")}|`);
		for (const s of scored) console.log(`| ${cols.map((c) => (c === "usdPer1k" ? `$${s[c].toFixed(3)}` : s[c])).join(" | ")} |`);
		for (const s of scored) if (s.aloneWrong?.length || s.failures?.length) console.log(`\n${s.model}: ${(s.aloneWrong ?? s.failures).join("; ")}`);
	}
	// The pipeline: the quick model's call where it was sure, the deep model's elsewhere.
	const quick = files.filter((f) => f.role === "quick");
	const deep = files.filter((f) => f.role === "deep");
	if (quick.length && deep.length) {
		console.log("\n## pipeline (quick alone where sure, else deep)\n\n| quick | deep | accuracy | hard | legitToJunk | phishMissed | failed | usdPer1k |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
		for (const q of quick)
			for (const d of deep) {
				const byId = new Map(d.verdicts.map((v) => [v.id, v]));
				const merged = q.verdicts.map((v) => {
					if (v.alone) return v;
					const dv = byId.get(v.id);
					return { ...v, got: dv?.got ?? null, calls: [...v.calls, ...(dv?.calls ?? [])] };
				});
				const s = bench.scoreClassify(merged);
				console.log(`| ${q.model} | ${d.model} | ${s.accuracy} | ${s.hard} | ${s.legitToJunk} | ${s.phishMissed} | ${s.failed} | $${s.usdPer1k.toFixed(3)} |`);
			}
	}
}
