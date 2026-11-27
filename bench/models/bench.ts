import { readFileSync } from "node:fs";
import type { MailCategory } from "#shared";
import { AGENT_MODEL, approveAction, converse } from "../../worker/agent";
import { checkMail, DEEP_MODEL, type MailFacts, type Models, QUICK_MODEL } from "../../worker/mail/checks";
import { checkRules, RULES_MODEL } from "../../worker/mail/rules";
import { runTask, TASKS } from "./agent";

// Benchmarks models for each of Magnus's model calls, through the production code (checkMail(), checkRules(),
// converse()), with the model swapped in a Models shim over the real AI binding. Mail and labels: mail.json.

/** USD per million tokens, from `wrangler ai models list --json` on 2026-11-27. OpenRouter says what Luna cost. */
const PRICES: Record<string, { input: number; output?: number; cached?: number }> = {
	"@cf/cloudflare/clef": { input: 0.24 },
	"@cf/cloudflare/clef-omni": { input: 0.15 },
	"@cf/cloudflare/clef-flash": { input: 0.038 },
	"@cf/deepseek-ai/deepseek-v4.1-flash-1017": { input: 0.3, output: 1.2, cached: 0.006 },
	"@cf/google/gemma-4-26b-a4b-it": { input: 0.1, output: 0.3, cached: 0.05 },
	"@cf/zai-org/glm-4.7-flash": { input: 0.0605, output: 0.4 },
	"@cf/openai/gpt-oss-20b": { input: 0.2, output: 0.3 },
	"@cf/openai/gpt-oss-120b": { input: 0.35, output: 0.75 },
	"@cf/thinkingmachines/inkling-2-small": { input: 0.3, output: 1, cached: 0.1 },
	"@cf/qwen/qwen3.8-27b": { input: 0.45, output: 3.2, cached: 0.05 },
	"@cf/zai-org/glm-5.3": { input: 1.4, output: 4.4, cached: 0.26 },
	"@cf/meta/llama-4-scout-17b-16e-instruct": { input: 0.27, output: 0.85 },
	"@cf/mistralai/mistral-small-3.1-24b-instruct": { input: 0.351, output: 0.555 },
};

interface Usage {
	input: number;
	output: number;
	cached: number;
	/** What OpenRouter billed, when it says. */
	usd?: number;
}

interface Call {
	model: string;
	ms: number;
	usage: Usage;
	retries: number;
	error?: string;
	raw?: unknown;
}

export interface Bench {
	ai: Ai;
}

interface Mail {
	id: string;
	category: MailCategory;
	accept: MailCategory[];
	hard?: string;
	facts: MailFacts;
	rules?: { condition: string; match: boolean }[];
}

export function loadMail(path: string): Mail[] {
	return (JSON.parse(readFileSync(path, "utf8")) as { mail: Mail[] }).mail;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Rate limits and capacity: retried, as the queue would retry them. */
const transient = (e: unknown) => /429|rate|capacity|3040|3046|overloaded|timeout|5\d\d/i.test(String(e));

async function retrying<T>(fn: () => Promise<T>): Promise<{ value: T; retries: number }> {
	for (let retries = 0; ; retries++) {
		try {
			return { value: await fn(), retries };
		} catch (e) {
			if (retries >= 5 || !transient(e)) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { retries });
			await sleep(2000 * 2 ** retries);
		}
	}
}

function usageOf(raw: unknown): Usage {
	const u = (raw as { usage?: Record<string, unknown> } | null)?.usage ?? {};
	const n = (v: unknown) => (typeof v === "number" ? v : 0);
	const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
	return {
		input: n(u.prompt_tokens ?? u.input_tokens),
		output: n(u.completion_tokens ?? u.output_tokens),
		cached: n(details.cached_tokens),
		...(typeof u.cost === "number" ? { usd: u.cost } : {}),
	};
}

export function costOf(model: string, u: Usage): number {
	if (u.usd !== undefined) return u.usd;
	const p = PRICES[model];
	if (!p) return Number.NaN;
	return ((u.input - u.cached) * p.input + u.cached * (p.cached ?? p.input) + u.output * (p.output ?? 0)) / 1e6;
}

interface Swap {
	quick?: string;
	/** A Workers AI model, or an OpenRouter one through the account's `default` gateway, to compare with. */
	deep?: string;
	rules?: string;
	agent?: string;
	/** Clef's answer: unsure, so every message reaches the deep model. */
	forceDeep?: boolean;
	/** The deep model's answer, standing in for one: the true category. */
	oracle?: MailCategory;
}

/** The AI binding, with Magnus's models swapped for the ones under test, every call recorded. */
function shim(ai: Ai, swap: Swap, calls: Call[]): Models {
	const record = async (model: string, fn: () => Promise<unknown>) => {
		const t0 = performance.now();
		try {
			const { value, retries } = await retrying(fn);
			calls.push({ model, ms: performance.now() - t0, usage: usageOf(value), retries, raw: value });
			return value;
		} catch (e) {
			calls.push({ model, ms: performance.now() - t0, usage: { input: 0, output: 0, cached: 0 }, retries: (e as { retries?: number }).retries ?? 0, error: String(e).slice(0, 200) });
			throw e;
		}
	};
	return {
		async run(model, inputs) {
			if (model === QUICK_MODEL) {
				if (swap.forceDeep) return { answers: { category: { probabilities: { personal: 0.25, transactional: 0.1, newsletter: 0.1, outreach: 0.2, spam: 0.2, phishing: 0.15 } } } };
				const target = swap.quick ?? model;
				return (await record(target, () => ai.run(target as never, { ...inputs, model: target.split("/").pop() } as never))) as Record<string, unknown>;
			}
			// The agent and the deep check can share a model: the agent's calls are the ones with tools.
			const role = model === AGENT_MODEL && "tools" in inputs ? "agent" : model === DEEP_MODEL ? "deep" : model === RULES_MODEL ? "rules" : null;
			if (role === "deep" && swap.oracle) return { choices: [{ message: { content: JSON.stringify({ category: swap.oracle }) } }] };
			const target = (role === "deep" ? swap.deep : role === "agent" ? swap.agent : role === "rules" ? swap.rules : undefined) ?? model;
			return (await record(target, () => (target.startsWith("@cf/") ? ai.run(target as never, inputs as never) : openRouter(ai, target, inputs)))) as Record<string, unknown>;
		},
	};
}

/**
 * A Workers AI chat request, sent to an OpenRouter model instead, to compare one with Magnus's: through the account's
 * `default` gateway with its stored OpenRouter key, only to providers that keep nothing.
 */
async function openRouter(ai: Ai, model: string, inputs: Record<string, unknown>) {
	const { max_completion_tokens, reasoning_effort, ...rest } = inputs;
	const res = await ai.gateway("default").run({
		provider: "openrouter",
		endpoint: "v1/chat/completions",
		headers: { "Content-Type": "application/json", "cf-aig-collect-log": false },
		query: { ...rest, model, max_tokens: max_completion_tokens, reasoning: { effort: reasoning_effort }, provider: { require_parameters: true, data_collection: "deny", zdr: true }, usage: { include: true } },
	} as AIGatewayUniversalRequest);
	if (!res.ok) throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i]!, i);
			}
		}),
	);
	return out;
}

const LEGIT = new Set<MailCategory>(["personal", "transactional", "newsletter"]);
const JUNK = new Set<MailCategory>(["spam", "phishing"]);

export interface Verdict {
	id: string;
	truth: MailCategory;
	accept: MailCategory[];
	hard: boolean;
	got: MailCategory | null;
	/** Decided by the quick model alone. */
	alone?: boolean;
	spam?: number;
	error?: string;
	calls: Call[];
}

/** One check per message, through checkMail() with these models. */
export async function classify(b: Bench, mail: Mail[], swap: Swap, concurrency: number): Promise<Verdict[]> {
	return pool(mail, concurrency, async (m) => {
		const calls: Call[] = [];
		const models = shim(b.ai, { ...swap, ...(swap.oracle ? { oracle: m.category } : {}) }, calls);
		try {
			const check = await checkMail(models, m.facts);
			if (check.kind !== "checked") throw new Error(check.kind);
			return { id: m.id, truth: m.category, accept: m.accept, hard: !!m.hard, got: check.category, alone: check.model === QUICK_MODEL, spam: check.spam, calls };
		} catch (e) {
			return { id: m.id, truth: m.category, accept: m.accept, hard: !!m.hard, got: null, error: String(e).slice(0, 160), calls };
		}
	});
}

export interface RuleVerdict {
	id: string;
	expected: boolean[];
	got: (boolean | null)[];
	error?: string;
	calls: Call[];
}

/** Every message with rules, its conditions read in one call, as the queue does. */
export async function rules(b: Bench, mail: Mail[], model: string, concurrency: number): Promise<RuleVerdict[]> {
	const withRules = mail.filter((m) => m.rules?.length);
	return pool(withRules, concurrency, async (m) => {
		const calls: Call[] = [];
		const list = m.rules!.map((r, i) => ({ id: `r${i}`, ai: r.condition }));
		try {
			const answers = await checkRules(shim(b.ai, { rules: model }, calls), m.facts, list);
			return { id: m.id, expected: m.rules!.map((r) => r.match), got: list.map((r) => answers[r.id]?.match ?? null), calls };
		} catch (e) {
			return { id: m.id, expected: m.rules!.map((r) => r.match), got: list.map(() => null), error: String(e).slice(0, 160), calls };
		}
	});
}

export interface AgentVerdict {
	id: string;
	problem: string | null;
	steps: number;
	trace?: string[];
	calls: Call[];
}

/** Each task `repeat` times: the same model doesn't always take the same steps. */
export async function agent(b: Bench, model: string, concurrency: number, repeat = 1): Promise<AgentVerdict[]> {
	return pool(
		TASKS.flatMap((t) => Array.from({ length: repeat }, () => t)),
		concurrency,
		async (task) => {
			const calls: Call[] = [];
			try {
				const { problem, reply } = await runTask(converse as never, approveAction as never, shim(b.ai, { agent: model }, calls), task);
				const trace = reply.messages.map((m) =>
					m.role === "assistant" ? `said ${JSON.stringify(m.content.slice(0, 160))}${(m.toolCalls ?? []).map((c) => ` → ${c.name}${c.arguments.slice(0, 200)}`).join("")}` : `${m.role}: ${"summary" in m ? m.summary : ""}`,
				);
				if (reply.pending) trace.push(`pending ${reply.pending.name} ${JSON.stringify(reply.pending.args).slice(0, 200)}`);
				return { id: task.id, problem, steps: reply.messages.filter((m) => m.role === "assistant").length, trace, calls };
			} catch (e) {
				return { id: task.id, problem: `threw: ${String(e).slice(0, 160)}`, steps: 0, calls };
			}
		},
	);
}

// ─── Scoring ──────────────────────────────────────────────────────────────

const pct = (n: number, d: number) => (d === 0 ? "–" : `${((100 * n) / d).toFixed(1)}%`);
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length === 0 ? Number.NaN : s[Math.floor(s.length / 2)]!;
};
const spend = (calls: Call[]) => calls.reduce((sum, c) => sum + costOf(c.model, c.usage), 0);

export function scoreClassify(vs: Verdict[]) {
	const ok = vs.filter((v) => v.got && v.accept.includes(v.got)).length;
	const hard = vs.filter((v) => v.hard);
	return {
		accuracy: pct(ok, vs.length),
		hard: pct(hard.filter((v) => v.got && v.accept.includes(v.got)).length, hard.length),
		/** Wanted mail sent to Spam. */
		legitToJunk: vs.filter((v) => LEGIT.has(v.truth) && v.got && JUNK.has(v.got) && !v.accept.includes(v.got)).length,
		/** Phishing not sent to Spam: outreach counts, as a mailbox can let it into the inbox (placeFor()). */
		phishMissed: vs.filter((v) => v.truth === "phishing" && v.got && !JUNK.has(v.got)).length,
		failed: vs.filter((v) => !v.got).length,
		retried: vs.filter((v) => v.calls.some((c) => c.retries > 0)).length,
		msMedian: Math.round(median(vs.flatMap((v) => v.calls.map((c) => c.ms)))),
		usdPer1k: (1000 * spend(vs.flatMap((v) => v.calls))) / vs.length,
	};
}

export function scoreQuick(vs: Verdict[]) {
	const alone = vs.filter((v) => v.alone);
	return {
		...scoreClassify(vs),
		decidedAlone: pct(alone.length, vs.length),
		aloneWrong: alone.filter((v) => v.got && !v.accept.includes(v.got)).map((v) => `${v.id}:${v.got}`),
	};
}

export function scoreRules(vs: RuleVerdict[]) {
	const pairs = vs.flatMap((v) => v.expected.map((e, i) => ({ e, g: v.got[i] })));
	return {
		accuracy: pct(pairs.filter((p) => p.g === p.e).length, pairs.length),
		falseMatch: pairs.filter((p) => p.g === true && !p.e).length,
		missed: pairs.filter((p) => p.g === false && p.e).length,
		unanswered: pairs.filter((p) => p.g === null).length,
		failedCalls: vs.filter((v) => v.error).length,
		msMedian: Math.round(median(vs.flatMap((v) => v.calls.map((c) => c.ms)))),
		usdPer1k: (1000 * spend(vs.flatMap((v) => v.calls))) / vs.length,
	};
}

export function scoreAgent(vs: AgentVerdict[]) {
	const calls = vs.flatMap((v) => v.calls);
	return {
		passed: `${vs.filter((v) => !v.problem).length}/${vs.length}`,
		failures: vs.filter((v) => v.problem).map((v) => `${v.id}: ${v.problem}`),
		callsPerTask: (calls.length / vs.length).toFixed(1),
		msPerTask: Math.round(vs.reduce((s, v) => s + v.calls.reduce((t, c) => t + c.ms, 0), 0) / vs.length),
		usdPer1k: (1000 * spend(calls)) / vs.length,
	};
}
