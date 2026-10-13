import type { ExporterAnswer, ExporterPhase, ExporterState } from "../../shared/proton-export.ts";

/**
 * Drives Proton's Export Tool (proton-mail-export-cli 1.0.7) by what it prints: answers its prompts, and turns the
 * rest into the state the Durable Object polls. Its output is cli/bin/main.cpp in proton-mail-export; server.ts runs
 * it with stderr into stdout, so an error line always arrives before the prompt it explains.
 */

/** Where Proton's human check sends you (VERIFY_URL_PREFIX in shared/proton-export.ts, which the image doesn't hold). */
const VERIFY_URL_PREFIX = "https://verify.proton.me/";

/** The running tool. */
export interface Tool {
	write(text: string): void;
	/** SIGINT: the tool stops as soon as it can and signs out of Proton. */
	interrupt(): void;
}

/** What it asks the person, by the label it prints as `<label>: ` before waiting (readLine, waitForEnter). */
const QUESTIONS: Record<string, ExporterPhase> = {
	"Enter the code from your authenticator app": "needs-code",
	"Mailbox Password": "needs-mailbox-password",
	"Press ENTER to continue": "needs-verification",
};
/** Prompts it only shows when something it's always given is missing: the login, --operation, --dir. */
const UNEXPECTED = new Set(["Username", "Operation", "Export Path", "Backup Path"]);
/** Everything it waits on. Only these end a line early: an error printed in pieces looks like a prompt until its end. */
const PROMPTS = new Set(["Password", "Do you wish to proceed?", ...Object.keys(QUESTIONS), ...UNEXPECTED]);

/** Its error lines whose text after the first ": " is Proton's (or the tool's) own words. */
const ERROR = /^(?:Failed to (?:login|submit 2FA code|set mailbox password|export|create export task|get free space info)|Could not get expected disk usage|Encountered unexpected login state)\b/;
/** The spinner it redraws while waiting on Proton (task_runner.hpp). */
const SPINNER = /^[-\\|/] \S/;
const PERCENT = /\[(\d{1,3}(?:\.\d+)?)%\]/;
const MAX_ERROR = 500;

const ASKING = new Set<ExporterPhase>(["needs-code", "needs-mailbox-password", "needs-verification"]);
const FINAL = new Set<ExporterPhase>(["exported", "failed", "stopped"]);

export class Session {
	#phase: ExporterPhase = "signing-in";
	#prompt = 0;
	/** Shown with the question being asked, or why it failed. */
	#error: string | null = null;
	/** The tool's last error line since the person last answered. */
	#lastError: string | null = null;
	/** Whether Proton has switched the tool off (its InboxImexClientOperationDisabled flag). */
	#switchedOff = false;
	#verifyUrl: string | null = null;
	#percent = 0;
	#finished = false;
	#stopping = false;
	#password: string | null;
	#pending = "";
	private readonly tool: Tool;
	/** The account's address or username, never to appear in what's reported: it's kept, and shown to others. */
	private readonly login: string;

	constructor(tool: Tool, login: string, password: string) {
		this.tool = tool;
		this.login = login;
		this.#password = password;
	}

	state(): Omit<ExporterState, "ready" | "unexported"> {
		return { phase: this.#phase, prompt: this.#prompt, error: this.#error, verifyUrl: this.#verifyUrl, percent: this.#percent };
	}

	get phase(): ExporterPhase {
		return this.#phase;
	}

	/** Output as it arrives, in any pieces. */
	feed(text: string): void {
		this.#pending += text;
		// Lines end in \n; the progress bar and spinner redraw in place with \r.
		for (let end = this.#pending.search(/[\r\n]/); end >= 0; end = this.#pending.search(/[\r\n]/)) {
			this.#line(this.#pending.slice(0, end));
			this.#pending = this.#pending.slice(end + 1);
		}
		// The bar is redrawn after a \r, so the latest one is still pending.
		const percent = PERCENT.exec(this.#pending);
		if (percent?.[1]) this.#percent = Math.min(100, Number(percent[1]));
		const prompt = /^(.*): $/.exec(this.#pending);
		if (prompt?.[1] !== undefined && PROMPTS.has(prompt[1])) {
			this.#pending = "";
			this.#ask(prompt[1]);
		}
	}

	/** The person's answer to question `prompt`. False when that isn't the question being asked: it's stale or a repeat. */
	answer({ prompt, value }: ExporterAnswer): boolean {
		if (!ASKING.has(this.#phase) || prompt !== this.#prompt) return false;
		if (this.#phase === "needs-verification") this.tool.write("\n");
		else {
			// A code is digits, so spaces around it are typos; a password is exactly what was typed.
			const text = this.#phase === "needs-code" ? value.trim() : value;
			// A line break would answer the next question too.
			if (!text || /[\r\n]/.test(text)) return false;
			this.tool.write(`${text}\n`);
		}
		this.#phase = "signing-in";
		this.#error = null;
		this.#lastError = null;
		this.#verifyUrl = null;
		return true;
	}

	/** Asked to stop: the tool signs out of Proton on its way out. */
	stop(): void {
		if (FINAL.has(this.#phase)) return;
		this.#stopping = true;
		this.#password = null;
		this.tool.interrupt();
	}

	/** The tool exited. */
	exit(code: number): void {
		this.#password = null;
		if (this.#phase === "failed") return;
		if (code === 0 && this.#finished) this.#phase = "exported";
		else if (this.#stopping) this.#phase = "stopped";
		else {
			this.#phase = "failed";
			this.#error = this.#lastError ?? explain(this.#switchedOff, code);
		}
	}

	#line(raw: string): void {
		const text = raw.trim();
		if (!text) return;
		const percent = PERCENT.exec(text);
		if (percent?.[1]) {
			this.#percent = Math.min(100, Number(percent[1]));
			return;
		}
		if (SPINNER.test(text)) return;
		// How 1.0.7 words it (lib/lib/etsession.cpp, killSwitchEnabledMessage); the raw error, in case a version doesn't.
		if (text.includes("temporarily disabled the Export Tool") || text.includes("killSwitch")) this.#switchedOff = true;
		if (text.startsWith(VERIFY_URL_PREFIX) && !/\s/.test(text)) this.#verifyUrl = text;
		else if (text.startsWith("Starting Export - Path=")) this.#phase = "exporting";
		else if (text === "Export Finished") this.#finished = true;
		else if (ERROR.test(text)) this.#lastError = this.#redact(cleanError(text));
	}

	#ask(label: string): void {
		if (FINAL.has(this.#phase) || this.#stopping) return;
		if (label === "Password") {
			// Asked again only after a failed sign-in. Stop there: the same password would fail twice more, and each try
			// counts against the account at Proton.
			if (this.#password === null) return this.#fail(this.#lastError ?? "Proton didn't accept that sign-in.");
			this.tool.write(`${this.#password}\n`);
			this.#password = null;
			return;
		}
		// Only asked when Proton's size estimate is more than the disk holds. Files leave as they're exported, so go on.
		if (label === "Do you wish to proceed?") return this.tool.write("yes\n");
		const phase = QUESTIONS[label];
		if (!phase) return this.#fail(`Proton's export tool asked for something Magnus doesn't have ("${label}").`);
		if (phase === "needs-verification" && !this.#verifyUrl) return this.#fail("Proton asked for a human check without a link to it.");
		this.#prompt++;
		this.#phase = phase;
		this.#error = this.#lastError;
		this.#lastError = null;
	}

	/**
	 * An error as it may be kept and shown to the mailbox's other members: without the account's address (the export's
	 * path holds it) or a human-check link, which are for the person signing in.
	 */
	#redact(text: string): string {
		// The path holds the account's primary address, which needn't be what was signed in with, so anything shaped
		// like an address goes, then the login itself (a username).
		const redacted = text.replace(/https:\/\/verify\.proton\.me\/\S*/g, "Proton’s check").replace(/[^\s/'"<>]+@[^\s/'"<>]+/g, "your Proton address");
		const login = this.login.trim();
		return login ? redacted.replace(new RegExp(login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "your Proton account") : redacted;
	}

	#fail(error: string): void {
		this.#phase = "failed";
		this.#error = error;
		this.#password = null;
		this.tool.interrupt();
	}
}

/** `Failed to login: <Proton's words>` → Proton's words. */
function cleanError(line: string): string {
	const words = line.slice(line.indexOf(": ") + 2).trim() || line;
	if (words === "Max attempts reached") return "Too many tries. Start again to have another go.";
	return words.slice(0, MAX_ERROR);
}

/** A stop no error line explains. Its other output isn't quoted: it can hold the address or a human-check link. */
function explain(switchedOff: boolean, code: number): string {
	if (switchedOff) return "Proton has paused its export tool. Try again later, or export the folder on your computer.";
	return `Proton's export tool stopped unexpectedly (exit ${code}). Start again: mail that's already here is skipped.`;
}
