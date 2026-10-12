import { z } from "zod";

/**
 * Importing from Proton on the server: Proton's Export Tool runs in a container (container/proton-export/), which a
 * ProtonImport Durable Object starts for one mailbox at a time (worker/proton-import.ts) and files mail from as it's
 * exported. This is what the two say to each other, and what the page sees of the job.
 */

// ─── The container ──────────────────────────────────────────────────────────

/** Where the wrapper in the container is. */
export const EXPORTER_PHASES = [
	"idle",
	"signing-in",
	"needs-code",
	"needs-mailbox-password",
	"needs-verification",
	"exporting",
	"exported",
	"failed",
	"stopped",
] as const;
export type ExporterPhase = (typeof EXPORTER_PHASES)[number];

/** What Proton's human check sends you to. Nothing else is ever offered as a link. */
export const VERIFY_URL_PREFIX = "https://verify.proton.me/";

/** GET /state from the wrapper. */
export const ExporterStateSchema = z.object({
	phase: z.enum(EXPORTER_PHASES),
	/** Numbers each question the tool asks, so an answer meant for one never reaches another. */
	prompt: z.number().int().nonnegative(),
	/** The tool's words for what went wrong last: Proton's, for a wrong password or code. */
	error: z.string().max(1000).nullable(),
	verifyUrl: z
		.url()
		.refine((url) => url.startsWith(VERIFY_URL_PREFIX))
		.nullable(),
	percent: z.number().min(0).max(100),
	/** Messages exported and waiting to be filed. */
	ready: z.number().int().nonnegative(),
	/** Messages Proton couldn't export as mail (it saves their parts in a folder instead). */
	unexported: z.number().int().nonnegative(),
});
export type ExporterState = z.infer<typeof ExporterStateSchema>;

/** POST /start to the wrapper. The password is written to the tool when it asks, then dropped. */
export interface ExporterStart {
	login: string;
	password: string;
}

/** POST /answer to the wrapper: `value` is ignored for the human check, which only needs to go on. */
export interface ExporterAnswer {
	prompt: number;
	value: string;
}

/** GET /messages from the wrapper: exported messages, each an `<id>.eml` beside its `<id>.metadata.json`. */
export const ExporterReadySchema = z.object({ ids: z.array(z.string().regex(/^[A-Za-z0-9+_=-]{1,256}$/)).max(1000) });

// ─── The page ───────────────────────────────────────────────────────────────

export const PROTON_JOB_PHASES = [
	"starting",
	"signing-in",
	"needs-code",
	"needs-mailbox-password",
	"needs-verification",
	"exporting",
	"done",
	"failed",
	"cancelled",
] as const;
export type ProtonJobPhase = (typeof PROTON_JOB_PHASES)[number];

/** The import into one mailbox, as the page shows it. No Proton address or password is kept. */
export interface ProtonImportJob {
	/** Every answer, stop, and clear names it, so one meant for an earlier import never reaches this one. */
	id: string;
	phase: ProtonJobPhase;
	/** Whether the person asking started it: only they can answer Proton's questions or stop it. */
	mine: boolean;
	/** The question being asked, to answer it; null when none is. */
	prompt: number | null;
	verifyUrl: string | null;
	/** Why it failed, or what was wrong with the last answer. */
	error: string | null;
	percent: number;
	imported: number;
	/** Drafts stay behind: drafts here aren't mail yet. */
	drafts: number;
	tooBig: number;
	/** Messages whose Proton details couldn't be read, so where they go isn't known. */
	unreadable: number;
	unexported: number;
	/** Messages Magnus refused (not mail), the first few. */
	refused: { id: string; error: string }[];
	refusedCount: number;
	startedAt: number;
	finishedAt: number | null;
	/** Finished, but its container is still shutting down: another can start in a few seconds. */
	closing: boolean;
}

/** The tool reads each answer as a line, so a line break would answer its next question too. */
const OneLine = z.string().max(1024).refine((s) => !/[\r\n]/.test(s), "Can't contain a line break");

/** POST /api/mailboxes/:id/proton-import. A Proton username works as well as an address. Passwords go as typed. */
export const ProtonStartSchema = z.object({
	login: OneLine.pipe(z.string().trim().min(1).max(254)),
	password: OneLine.pipe(z.string().min(1)),
});

/** The import an action is for. */
export const ProtonJobRefSchema = z.object({ job: z.uuid() });

/** POST /api/mailboxes/:id/proton-import/answer. A mailbox password goes as typed; a code is trimmed where it's sent. */
export const ProtonAnswerSchema = ProtonJobRefSchema.extend({
	prompt: z.number().int().nonnegative(),
	value: OneLine,
});
