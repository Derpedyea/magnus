import { DurableObject } from "cloudflare:workers";
import { byteBudget } from "#shared";
import { type ImportPlacement, MAX_IMPORT_BYTES, type ProtonLabel, ProtonLabelsSchema, ProtonMetadataSchema, protonPlacement } from "#shared/import";
import {
	type ExporterAnswer,
	ExporterReadySchema,
	type ExporterState,
	ExporterStateSchema,
	PROTON_JOB_PHASES,
	type ProtonImportJob,
	type ProtonJobPhase,
} from "#shared/proton-export";
import { z } from "zod";
import { hasMember } from "./directory";
import { importMessage } from "./mail/import";
import { optional } from "./optional";

/**
 * Importing from Proton on the server, one mailbox at a time (one instance per mailbox, named by its id). Proton's
 * Export Tool runs in this object's container (container/proton-export/), and the alarm files each message through
 * importMessage() as soon as it's exported, then deletes it there. Nobody has to keep a page open.
 *
 * The Proton password goes from start() to the container and nowhere else: nothing here stores it, or the Proton
 * address. A container that dies takes the sign-in with it, so the job fails and the person starts again; mail already
 * filed has the same content id the second time, so nothing doubles.
 */

/** The wrapper's port (container/proton-export/server.ts). */
const PORT = 8080;
/** How often the alarm looks in on the container. Sooner after filing something, since more is likely waiting. */
const POLL_MS = 2000;
const BUSY_POLL_MS = 250;
/** How long the container may take to answer once started. */
const BOOT_MS = 90_000;
/** Proton's questions wait this long for the person, then the job stops. */
const ANSWER_MS = 15 * 60_000;
/** Signing in with nothing asked of anyone: the tool or Proton is stuck. */
const SIGN_IN_MS = 10 * 60_000;
/** How long a stopped tool gets to sign out of Proton before its container is destroyed. */
const SIGN_OUT_MS = 30_000;
/** Without a request or alarm for this long, Cloudflare stops the container. Alarms come every few seconds. */
const INACTIVITY_MS = 5 * 60_000;
/** Each start is one Proton sign-in. More than this an hour from one mailbox is guessing passwords. */
const STARTS_PER_HOUR = 5;
const HOUR = 3_600_000;
/** Messages taken per alarm, and how long it spends filing them. */
const BATCH = 50;
const FILE_MS = 20_000;
/** Messages filed at once. The bytes in flight are capped as well (MAX_IMPORT_BYTES), as an isolate holds 128 MB. */
const CONCURRENCY = 4;
/** Proton's details for a message run to a few KB, and labels.json to a few hundred bytes a label. */
const MAX_JSON_BYTES = 1024 * 1024;
/** Alarms in a row that fail before the job does, rather than retrying forever. */
const MAX_FAILURES = 5;
const REFUSED_SHOWN = 20;

const INTERRUPTED = "The export was interrupted. Start again: mail that's already here is skipped.";

const FINAL = new Set<ProtonJobPhase>(["done", "failed", "cancelled"]);
const ASKING = ["needs-code", "needs-mailbox-password", "needs-verification"] as const;
const isAsking = (phase: string): phase is (typeof ASKING)[number] => ASKING.some((a) => a === phase);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job (
	one INTEGER PRIMARY KEY CHECK (one = 1),
	id TEXT NOT NULL,
	mailbox_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	phase TEXT NOT NULL,
	prompt INTEGER,
	verify_url TEXT,
	error TEXT,
	percent REAL NOT NULL DEFAULT 0,
	unexported INTEGER NOT NULL DEFAULT 0,
	labels_loaded INTEGER NOT NULL DEFAULT 0,
	started_at INTEGER NOT NULL,
	-- When the phase or question last changed, for the timeouts.
	phase_at INTEGER NOT NULL,
	finished_at INTEGER,
	-- 1 until its container is destroyed: a finished job still has one to clean up.
	container INTEGER NOT NULL DEFAULT 1,
	-- When the tool was asked to stop (or had already), so the container goes after it signs out.
	stop_at INTEGER,
	failures INTEGER NOT NULL DEFAULT 0
);
-- What became of each exported message, by Proton's id: filing it again after a crash doesn't count it twice.
CREATE TABLE IF NOT EXISTS outcomes (
	proton_id TEXT PRIMARY KEY,
	outcome TEXT NOT NULL CHECK (outcome IN ('imported', 'draft', 'refused', 'too-big', 'unreadable')),
	error TEXT
);
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, type INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL);
`;

const JobRow = z.object({
	id: z.string(),
	mailbox_id: z.string(),
	user_id: z.string(),
	phase: z.enum(PROTON_JOB_PHASES),
	prompt: z.number().nullable(),
	verify_url: z.string().nullable(),
	error: z.string().nullable(),
	percent: z.number(),
	unexported: z.number(),
	labels_loaded: z.number(),
	started_at: z.number(),
	phase_at: z.number(),
	finished_at: z.number().nullable(),
	container: z.number(),
	stop_at: z.number().nullable(),
	failures: z.number(),
});
type Job = z.infer<typeof JobRow>;

/** The container's wrapper, as the alarm sees it. The tests stand one in. */
export interface Exporter {
	readonly running: boolean;
	/** Starts the container if it isn't running and resolves once the wrapper answers. */
	start(): Promise<void>;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	destroy(): Promise<void>;
}

export type StartResult = { job: ProtonImportJob | null } | { error: string; status: 409 | 429 | 503 };
export type ActionResult = { job: ProtonImportJob | null } | { error: string; status: 400 | 403 | 404 | 409 };

export class ProtonImport extends DurableObject<Env> {
	/**
	 * How long one request to the wrapper may take, its body included, so one that never answers can't hold up an
	 * alarm or keep a finished job's container. A message can be 25 MiB. Tests shorten them.
	 */
	protected readonly limits = { control: 10_000, file: 60_000 };
	#exporter: Exporter | null = null;
	/** The bytes of messages being filed at once. */
	#budget = byteBudget(MAX_IMPORT_BYTES);

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(SCHEMA);
		// A restart (a deploy) forgets the container's inactivity timeout.
		const container = ctx.container;
		if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_MS));
	}

	/**
	 * The container's wrapper, or null when this install can't run one: local dev, where containers are off, without
	 * PROTON_EXPORTER_URL. Tests stand one in.
	 */
	protected exporter(): Exporter | null {
		this.#exporter ??= devExporter() ?? containerExporter(this.ctx);
		return this.#exporter;
	}

	/** The wrapper, for a job that has one: a job only starts when there is (start()). */
	#exporterOf(): Exporter {
		const exporter = this.exporter();
		if (!exporter) throw new Error("ProtonImport has no container: see containers in wrangler.jsonc");
		return exporter;
	}

	#call(path: string, init: RequestInit = {}, ms = this.limits.control): Promise<Response> {
		return this.#exporterOf().fetch(path, { ...init, signal: AbortSignal.timeout(ms) });
	}

	/** Whether an import into this mailbox is under way, which a restore of it waits for (worker/restore.ts). */
	busy(): boolean {
		const job = this.#job();
		return job !== null && (!FINAL.has(job.phase) || Boolean(job.container));
	}

	status(userId: string): ProtonImportJob | null {
		const job = this.#job();
		return job ? this.#view(job, userId) : null;
	}

	/** Signs in to Proton as `login` and starts exporting. The password is handed to the container and dropped. */
	async start(input: { userId: string; mailboxId: string; login: string; password: string }): Promise<StartResult> {
		const now = Date.now();
		const current = this.#job();
		if (current && (!FINAL.has(current.phase) || current.container)) return { error: "An import into this mailbox is already running.", status: 409 };
		// Refused before a job is claimed: one that could never have a container could never be cleaned up either.
		const exporter = this.exporter();
		if (!exporter) return { error: "Importing from Proton isn't available on this install.", status: 503 };
		this.#sql(`DELETE FROM starts WHERE at <= ?1`, now - HOUR);
		const recent = this.ctx.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM starts`).one().n;
		if (recent >= STARTS_PER_HOUR) return { error: `That's ${STARTS_PER_HOUR} tries this hour. Wait a while, then try again.`, status: 429 };

		// Claimed before anything that waits, so a second start (another tab) finds it taken.
		const id = crypto.randomUUID();
		this.ctx.storage.transactionSync(() => {
			this.#sql(`DELETE FROM job`);
			this.#sql(`DELETE FROM outcomes`);
			this.#sql(`DELETE FROM labels`);
			this.#sql(
				`INSERT INTO job (one, id, mailbox_id, user_id, phase, started_at, phase_at) VALUES (1, ?1, ?2, ?3, 'starting', ?4, ?4)`,
				id,
				input.mailboxId,
				input.userId,
				now,
			);
			this.#sql(`INSERT INTO starts (at) VALUES (?1)`, now);
		});
		await this.ctx.storage.setAlarm(now + POLL_MS);

		try {
			await exporter.start();
			// Cancelled while the container started: the password stays here, and goes with this request.
			if (this.#job()?.id !== id || this.#job()?.phase !== "starting") return { job: this.#viewOf(id, input.userId) };
			const res = await this.#call("/start", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ login: input.login, password: input.password }),
			});
			if (!res.ok) throw new Error(`The export tool answered ${res.status}`);
			this.#apply(id, ExporterStateSchema.parse(await res.json()), Date.now());
		} catch (error) {
			console.error(JSON.stringify({ msg: "proton import: couldn't start", error: String(error) }));
			this.#finish(id, "failed", "Couldn't start Proton's export tool. Try again in a few minutes.", null);
		}
		return { job: this.#viewOf(id, input.userId) };
	}

	/**
	 * The answer to Proton's question `prompt` in import `jobId`: a 2FA code, the mailbox password (exactly as typed), or
	 * nothing for the human check.
	 */
	async answer(userId: string, jobId: string, answer: ExporterAnswer): Promise<ActionResult> {
		const job = this.#job();
		if (!job || job.id !== jobId) return { error: "That import has ended.", status: 409 };
		if (job.user_id !== userId) return { error: "Only the person who started this import can answer Proton.", status: 403 };
		if (!isAsking(job.phase) || job.prompt !== answer.prompt) return { error: "Proton has moved on from that question.", status: 409 };
		const value = job.phase === "needs-code" ? answer.value.trim() : answer.value;
		if (job.phase !== "needs-verification" && !value) return { error: "Enter an answer first.", status: 400 };
		const res = await this.#call("/answer", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: answer.prompt, value } satisfies ExporterAnswer),
		});
		// Answered already (another tab) or the tool moved on: the wrapper is what decides, as it writes to the tool.
		if (res.status === 409) return { error: "Proton has moved on from that question.", status: 409 };
		if (!res.ok) throw new Error(`The export tool answered ${res.status}`);
		this.#apply(job.id, ExporterStateSchema.parse(await res.json()), Date.now());
		await this.ctx.storage.setAlarm(Date.now() + BUSY_POLL_MS);
		return { job: this.#viewOf(job.id, userId) };
	}

	/** Stops import `jobId`: the tool signs out of Proton, and mail filed so far stays. */
	async cancel(userId: string, jobId: string): Promise<ActionResult> {
		const job = this.#job();
		if (!job || job.id !== jobId || FINAL.has(job.phase)) return { error: "That import has ended.", status: 409 };
		if (job.user_id !== userId) return { error: "Only the person who started this import can stop it.", status: 403 };
		this.#finish(job.id, "cancelled", null, null);
		await this.ctx.storage.setAlarm(Date.now() + BUSY_POLL_MS);
		return { job: this.#viewOf(job.id, userId) };
	}

	/** Clears finished import `jobId` from the page, so another can start. */
	dismiss(jobId: string): ActionResult {
		const job = this.#job();
		// Cleared already, say by another tab.
		if (!job) return { job: null };
		if (job.id !== jobId) return { error: "That import has ended.", status: 409 };
		if (!FINAL.has(job.phase) || job.container) return { error: "The import is still running.", status: 409 };
		this.ctx.storage.transactionSync(() => {
			this.#sql(`DELETE FROM job`);
			this.#sql(`DELETE FROM outcomes`);
			this.#sql(`DELETE FROM labels`);
		});
		return { job: null };
	}

	override async alarm(): Promise<void> {
		const job = this.#job();
		if (!job || !job.container) return;
		let busy = false;
		try {
			busy = await this.#step(job);
			this.#sql(`UPDATE job SET failures = 0 WHERE id = ?1`, job.id);
		} catch (error) {
			console.error(JSON.stringify({ msg: "proton import: step failed", attempt: job.failures + 1, error: String(error) }));
			// Tried again next alarm; a run of failures ends the job instead of retrying forever.
			if (job.failures + 1 >= MAX_FAILURES && !FINAL.has(job.phase)) this.#finish(job.id, "failed", INTERRUPTED, null);
			this.#sql(`UPDATE job SET failures = failures + 1 WHERE id = ?1`, job.id);
		}
		if (this.#job()?.container) await this.ctx.storage.setAlarm(Date.now() + (busy ? BUSY_POLL_MS : POLL_MS));
	}

	/** One look at the container. True when it filed something, so more is likely waiting. */
	async #step(job: Job): Promise<boolean> {
		const now = Date.now();
		if (FINAL.has(job.phase)) {
			await this.#windDown(job, now);
			return false;
		}
		// start() is still bringing the container up, unless it died doing so.
		if (job.phase === "starting") {
			if (now - job.started_at > BOOT_MS * 2) this.#finish(job.id, "failed", INTERRUPTED, null);
			return false;
		}
		if (!(await hasMember(this.env.DIRECTORY, job.mailbox_id, job.user_id))) {
			this.#finish(job.id, "cancelled", "Stopped: whoever started it is no longer in this mailbox.", null);
			return false;
		}
		if (!this.#exporterOf().running) {
			this.#finish(job.id, "failed", INTERRUPTED, now);
			return false;
		}
		const state = await this.#state();
		if (!this.#isCurrent(job.id)) return false;
		switch (state.phase) {
			case "idle":
				// A fresh wrapper: the container was replaced, and the sign-in went with it.
				this.#finish(job.id, "failed", INTERRUPTED, now);
				return false;
			case "signing-in":
			case "needs-code":
			case "needs-mailbox-password":
			case "needs-verification": {
				const applied = this.#apply(job.id, state, now);
				if (applied && isAsking(applied.phase) && now - applied.phase_at > ANSWER_MS) {
					this.#finish(job.id, "cancelled", "Stopped: Proton's question went unanswered for 15 minutes.", null);
				} else if (applied?.phase === "signing-in" && now - applied.phase_at > SIGN_IN_MS) {
					this.#finish(job.id, "cancelled", "Stopped: signing in to Proton took too long.", null);
				}
				return false;
			}
			case "exporting":
			case "exported":
			case "failed":
			case "stopped": {
				// A tool that stopped early keeps the job's phase until it's ended below, rather than flashing "exporting".
				if (state.phase === "exporting" || state.phase === "exported") this.#apply(job.id, state, now);
				const filed = await this.#fileReady(job);
				if (filed || !this.#isCurrent(job.id) || state.phase === "exporting") return filed;
				// The tool is done: once nothing is left to file, so is the job.
				const after = await this.#state();
				if (after.ready > 0 || !this.#isCurrent(job.id)) return true;
				if (after.phase === "exported") {
					this.#sql(`UPDATE job SET unexported = ?2, percent = 100 WHERE id = ?1`, job.id, after.unexported);
					this.#finish(job.id, "done", null, now);
				} else this.#finish(job.id, "failed", after.error ?? "Proton's export tool stopped.", now);
				return false;
			}
		}
	}

	/**
	 * A finished job's container: the tool is asked to stop (it signs out of Proton), then the container is destroyed
	 * once it has, or after SIGN_OUT_MS whatever the wrapper says, so a wrapper that stopped answering can't keep it.
	 */
	async #windDown(job: Job, now: number): Promise<void> {
		// No wrapper at all (containers turned off since): nothing can be running to clean up.
		const exporter = this.exporter();
		if (exporter?.running) {
			if (job.stop_at === null) {
				// Recorded first: if asking fails (thrown to the alarm, which logs it), the wait below still runs out.
				this.#sql(`UPDATE job SET stop_at = ?2 WHERE id = ?1`, job.id, now);
				const res = await this.#call("/stop", { method: "POST" });
				if (!res.ok) throw new Error(`The export tool answered ${res.status} to stopping`);
				return;
			}
			if (now - job.stop_at < SIGN_OUT_MS && !["idle", "exported", "failed", "stopped"].includes((await this.#state()).phase)) return;
			await exporter.destroy();
		}
		this.#sql(`UPDATE job SET container = 0 WHERE id = ?1`, job.id);
	}

	/** Files what's exported, a batch at a time. True when it filed anything. */
	async #fileReady(job: Job): Promise<boolean> {
		const labels = await this.#labels(job);
		if (!labels) return false;
		const res = await this.#call(`/messages?limit=${BATCH}`);
		if (!res.ok) throw new Error(`The export tool answered ${res.status} for messages`);
		const { ids } = ExporterReadySchema.parse(await res.json());
		const until = Date.now() + FILE_MS;
		let next = 0;
		let broken = false;
		const worker = async () => {
			// Stop taking more once the time's up, one has failed, or the job was cancelled or replaced.
			while (next < ids.length && Date.now() < until && !broken && this.#isCurrent(job.id)) {
				const id = ids[next++];
				if (!id) continue;
				try {
					await this.#fileOne(job, id, labels);
				} catch (error) {
					broken = true;
					throw error;
				}
			}
		};
		// Every message on its way is finished before the alarm goes on, even when one fails: otherwise one could still
		// be writing after the job ends and another starts. The first failure is then the alarm's.
		const settled = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker));
		const failed = settled.find((s) => s.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
		return ids.length > 0;
	}

	/** One exported message: filed, or its outcome recorded, then deleted in the container. */
	async #fileOne(job: Job, id: string, labels: ReadonlyMap<string, ProtonLabel>): Promise<void> {
		const known = this.ctx.storage.sql.exec(`SELECT 1 FROM outcomes WHERE proton_id = ?1`, id).toArray().length > 0;
		if (!known) {
			const placed = await this.#place(job, id, labels);
			// Not filed because the job ended on the way, or another import took its place meanwhile: nothing of it is kept.
			if (!placed || this.#job()?.id !== job.id) return;
			this.#sql(`INSERT OR IGNORE INTO outcomes (proton_id, outcome, error) VALUES (?1, ?2, ?3)`, id, placed.outcome, placed.error);
		}
		// Ended meanwhile: its container goes with it, so there's nothing to free.
		if (!this.#isCurrent(job.id)) return;
		const res = await this.#call(`/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
		// Not deleted: it's offered again, and its outcome above keeps it from counting twice.
		if (!res.ok && res.status !== 404) throw new Error(`The export tool answered ${res.status} to a delete`);
	}

	/** What became of one message, or null when the job ended before it could be filed. */
	async #place(job: Job, id: string, labels: ReadonlyMap<string, ProtonLabel>): Promise<{ outcome: Outcome; error: string | null } | null> {
		const meta = ProtonMetadataSchema.safeParse(await readJson(await this.#call(`/messages/${encodeURIComponent(id)}/metadata`)));
		// Proton names both files by the message's id, so details naming another message aren't this one's.
		if (!meta.success || meta.data.Payload.ID !== id) return { outcome: "unreadable", error: null };
		const placement: ImportPlacement | null = protonPlacement(meta.data.Payload, labels);
		if (!placement) return { outcome: "draft", error: null };

		// Two deadlines: one for the answer, and one for the body that starts once there's memory to read it into, so
		// waiting behind big messages doesn't count against it.
		const deadline = new AbortController();
		let timer = setTimeout(() => deadline.abort(new Error("The export tool didn't send a message in time")), this.limits.control);
		try {
			const res = await this.#exporterOf().fetch(`/messages/${encodeURIComponent(id)}/eml`, { signal: deadline.signal });
			clearTimeout(timer);
			if (res.status === 404) return { outcome: "unreadable", error: null };
			if (!res.ok) throw new Error(`The export tool answered ${res.status} for a message`);
			const size = contentLength(res);
			if (size > MAX_IMPORT_BYTES) {
				await res.body?.cancel();
				return { outcome: "too-big", error: null };
			}
			await this.#budget.take(size);
			timer = setTimeout(() => deadline.abort(new Error("The export tool didn't send a message in time")), this.limits.file);
			try {
				return await this.#file(job, res, placement);
			} finally {
				this.#budget.give(size);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/** One message's bytes, filed unless the job ended while they were on their way. */
	async #file(job: Job, res: Response, placement: ImportPlacement): Promise<{ outcome: Outcome; error: string | null } | null> {
		const raw = new Uint8Array(await res.arrayBuffer());
		if (raw.byteLength > MAX_IMPORT_BYTES) return { outcome: "too-big", error: null };
		// Checked again just before filing: Stop, or the person leaving the mailbox, while it was on its way here.
		// What's already inside importMessage() lands (Known gaps).
		if (!(await hasMember(this.env.DIRECTORY, job.mailbox_id, job.user_id)) || !this.#isCurrent(job.id)) return null;
		const result = await importMessage(this.env, job.mailbox_id, raw, placement);
		return "refused" in result ? { outcome: "refused", error: result.refused } : { outcome: "imported", error: null };
	}

	/** The account's folders and labels, read once. Null until the tool has written them, which it does before any mail. */
	async #labels(job: Job): Promise<ReadonlyMap<string, ProtonLabel> | null> {
		if (!job.labels_loaded) {
			const res = await this.#call("/labels");
			if (res.status === 404) return null;
			const parsed = ProtonLabelsSchema.safeParse(await readJson(res));
			// Without them, every folder and label of the person's own would be dropped, and importing again couldn't add
			// them: the mail would already be here.
			if (!parsed.success) {
				this.#finish(job.id, "failed", "Couldn't read the folders and labels in Proton's export.", null);
				return null;
			}
			this.ctx.storage.transactionSync(() => {
				this.#sql(`DELETE FROM labels`);
				for (const l of parsed.data.Payload) this.#sql(`INSERT OR REPLACE INTO labels (id, name, path, type) VALUES (?1, ?2, ?3, ?4)`, l.ID, l.Name, l.Path ?? null, l.Type);
				this.#sql(`UPDATE job SET labels_loaded = 1 WHERE id = ?1`, job.id);
			});
		}
		const rows = this.ctx.storage.sql.exec<{ id: string; name: string; path: string | null; type: number }>(`SELECT id, name, path, type FROM labels`).toArray();
		return new Map(rows.map((r) => [r.id, { ID: r.id, Name: r.name, ...(r.path === null ? {} : { Path: r.path }), Type: r.type }]));
	}

	async #state(): Promise<ExporterState> {
		const res = await this.#call("/state");
		if (!res.ok) throw new Error(`The export tool answered ${res.status} for its state`);
		return ExporterStateSchema.parse(await res.json());
	}

	/** Takes in what the container says, unless the job has finished or been replaced meanwhile. */
	#apply(id: string, state: ExporterState, now: number): Job | null {
		const job = this.#job();
		if (!job || job.id !== id || FINAL.has(job.phase)) return null;
		const phase: ProtonJobPhase = state.phase === "signing-in" || isAsking(state.phase) ? state.phase : "exporting";
		const asking = isAsking(phase);
		const changed = phase !== job.phase || (asking && state.prompt !== job.prompt);
		this.#sql(
			`UPDATE job SET phase = ?2, prompt = ?3, verify_url = ?4, error = ?5, percent = ?6, phase_at = ?7 WHERE id = ?1`,
			id,
			phase,
			asking ? state.prompt : null,
			phase === "needs-verification" ? state.verifyUrl : null,
			asking ? state.error : null,
			Math.max(job.percent, state.percent),
			changed ? now : job.phase_at,
		);
		return this.#job();
	}

	/**
	 * Ends the job (the one write that does), unless it already ended. `stoppedAt` is set when the tool has already
	 * exited, so the container is destroyed without asking it to stop.
	 */
	#finish(id: string, phase: ProtonJobPhase, error: string | null, stoppedAt: number | null): void {
		this.#sql(
			`UPDATE job SET phase = ?2, error = ?3, prompt = NULL, verify_url = NULL, finished_at = ?4, stop_at = coalesce(stop_at, ?5)
			 WHERE id = ?1 AND phase NOT IN ('done', 'failed', 'cancelled')`,
			id,
			phase,
			error,
			Date.now(),
			stoppedAt,
		);
	}

	#isCurrent(id: string): boolean {
		const job = this.#job();
		return job?.id === id && !FINAL.has(job.phase);
	}

	#job(): Job | null {
		const row = this.ctx.storage.sql.exec(`SELECT * FROM job`).toArray()[0];
		return row ? JobRow.parse(row) : null;
	}

	/** Null when the job ended and another replaced it while this one was waiting on the container. */
	#viewOf(id: string, userId: string): ProtonImportJob | null {
		const job = this.#job();
		return job?.id === id ? this.#view(job, userId) : null;
	}

	#view(job: Job, userId: string): ProtonImportJob {
		const counts = new Map(
			this.ctx.storage.sql
				.exec<{ outcome: Outcome; n: number }>(`SELECT outcome, count(*) AS n FROM outcomes GROUP BY outcome`)
				.toArray()
				.map((r) => [r.outcome, r.n]),
		);
		const refused = this.ctx.storage.sql
			.exec<{ id: string; error: string | null }>(`SELECT proton_id AS id, error FROM outcomes WHERE outcome = 'refused' ORDER BY proton_id LIMIT ?1`, REFUSED_SHOWN)
			.toArray()
			.map((r) => ({ id: r.id, error: r.error ?? "Not an email message" }));
		const mine = job.user_id === userId;
		return {
			id: job.id,
			phase: job.phase,
			mine,
			// Proton's questions and its link are for the person signing in.
			prompt: mine ? job.prompt : null,
			verifyUrl: mine ? job.verify_url : null,
			error: job.error,
			percent: job.percent,
			imported: counts.get("imported") ?? 0,
			drafts: counts.get("draft") ?? 0,
			tooBig: counts.get("too-big") ?? 0,
			unreadable: counts.get("unreadable") ?? 0,
			unexported: job.unexported,
			refused,
			refusedCount: counts.get("refused") ?? 0,
			startedAt: job.started_at,
			finishedAt: job.finished_at,
			closing: FINAL.has(job.phase) && job.container === 1,
		};
	}

	#sql(query: string, ...bindings: (string | number | null)[]): void {
		this.ctx.storage.sql.exec(query, ...bindings);
	}
}

type Outcome = "imported" | "draft" | "refused" | "too-big" | "unreadable";

/**
 * A file's JSON from the wrapper, refused unread past MAX_JSON_BYTES. Null when the file is missing, too big, or isn't
 * JSON: what's in it. A request or body that fails on the way throws instead, so the alarm tries again rather than
 * taking a message's details for unreadable and deleting it.
 */
async function readJson(res: Response): Promise<unknown> {
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`The export tool answered ${res.status}`);
	if (contentLength(res) > MAX_JSON_BYTES) {
		await res.body?.cancel();
		return null;
	}
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The wrapper always says how big a file is (server.ts); a response that doesn't wasn't the wrapper's whole answer. */
function contentLength(res: Response): number {
	const size = Number(res.headers.get("Content-Length") ?? NaN);
	if (!Number.isSafeInteger(size) || size < 0) throw new Error("The export tool sent a file without its length");
	return size;
}

/**
 * Local dev starts no containers (dev.enable_containers in wrangler.jsonc). To import there, run the wrapper yourself,
 * `docker run --rm -p 18080:8080 $(docker build -q container/proton-export)`, and set PROTON_EXPORTER_URL to
 * http://127.0.0.1:18080 in .dev.vars. It runs one import: restart it for the next. Built code never reads it.
 */
function devExporter(): Exporter | null {
	const base = import.meta.env?.DEV ? optional("PROTON_EXPORTER_URL") : undefined;
	if (!base) return null;
	return {
		running: true,
		async start() {
			const res = await fetch(`${base}/state`);
			await res.body?.cancel();
			if (!res.ok) throw new Error(`The export container at ${base} answered ${res.status}`);
		},
		fetch: (path, init) => fetch(`${base}${path}`, init),
		// It's yours to stop.
		destroy: async () => undefined,
	};
}

function containerExporter(ctx: DurableObjectState): Exporter | null {
	const container = ctx.container;
	if (!container) return null;
	const port = () => container.getTcpPort(PORT);
	return {
		get running() {
			return container.running;
		},
		async start() {
			if (!container.running) container.start({ enableInternet: true });
			await container.setInactivityTimeout(INACTIVITY_MS);
			// start() returns before the wrapper listens.
			const until = Date.now() + BOOT_MS;
			for (;;) {
				const answered = await port()
					.fetch("http://container/state", { signal: AbortSignal.timeout(5000) })
					.then(async (res) => {
						await res.body?.cancel();
						return res.ok;
					})
					.catch((error: unknown) => {
						if (Date.now() >= until) throw error;
						return false;
					});
				if (answered) return;
				if (Date.now() >= until) throw new Error("Proton's export tool didn't start in time");
				await scheduler.wait(500);
			}
		},
		fetch: (path, init) => port().fetch(`http://container${path}`, init),
		destroy: () => container.destroy(),
	};
}
