import { formatBytes, type Me } from "#shared";
import { MAX_IMPORT_BYTES } from "#shared/import";
import type { ProtonImportJob, ProtonJobPhase } from "#shared/proton-export";
import { type QueryClient, queryOptions, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import { CircleCheckIcon, ExternalLinkIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from "@/components/ui/input-otp";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, errorMessage } from "../api";
import { currentSession } from "../session";
import { LIST, plural } from "../words";
import { MailboxChoice } from "./MailboxChoice";

/**
 * Importing from Proton on the server (worker/proton-import.ts): sign in here, answer whatever Proton asks, and the
 * import runs on its own. Its state is polled while it's running, so returning to the page picks it up.
 *
 * Passwords are sent straight from the form and cleared from it, never kept in the query or mutation caches. An answer
 * that comes back after signing out is dropped, so the next account never sees the last one's import.
 */

const POLL_MS = 2000;
const FINAL = new Set<ProtonJobPhase>(["done", "failed", "cancelled"]);
const key = (mailboxId: string) => ["proton-import", mailboxId] as const;
/** Still changing: polled until it has finished and its container is gone. */
const isLive = (job: ProtonImportJob | null | undefined) => !!job && (!FINAL.has(job.phase) || job.closing);
const jobQuery = (mailboxId: string) =>
	queryOptions({
		queryKey: key(mailboxId),
		queryFn: () => api.protonImport(mailboxId),
		refetchInterval: (query) => (isLive(query.state.data?.job) ? POLL_MS : false),
	});

export function ProtonImport(props: { mailboxes: Me["mailboxes"] }) {
	const results = useQueries({ queries: props.mailboxes.map((m) => jobQuery(m.id)) });
	const failed = results.find((r) => r.error);
	if (failed) return <Section><p role="alert" className="text-destructive">{errorMessage(failed.error)}</p></Section>;
	if (results.some((r) => r.isPending)) {
		return (
			<Section>
				<p className="flex items-center gap-2 text-muted-foreground"><Spinner /> Loading…</p>
			</Section>
		);
	}
	// One import per mailbox, each shown, so none can hide another's question; the rest can start one.
	const named = props.mailboxes.length > 1;
	const jobs = props.mailboxes.flatMap((mailbox, i) => {
		const job = results[i]?.data?.job;
		return job ? [{ mailbox, job }] : [];
	});
	const free = props.mailboxes.filter((m) => !jobs.some((j) => j.mailbox.id === m.id));
	return (
		<div className="flex flex-col gap-4">
			{jobs.map(({ mailbox, job }) => (
				<Job key={job.id} mailbox={mailbox} job={job} named={named} />
			))}
			{free.length ? <SignIn mailboxes={free} /> : null}
		</div>
	);
}

function SignIn(props: { mailboxes: Me["mailboxes"] }) {
	const qc = useQueryClient();
	const [chosen, setChosen] = useState(props.mailboxes[0]?.id ?? "");
	// Whichever was chosen may have started an import meanwhile (another tab).
	const mailboxId = props.mailboxes.some((m) => m.id === chosen) ? chosen : (props.mailboxes[0]?.id ?? "");
	const [login, setLogin] = useState("");
	const [password, setPassword] = useState("");
	const send = useSecret();
	const onSubmit = (e: FormEvent) => {
		e.preventDefault();
		const secret = password;
		setPassword("");
		const session = currentSession();
		void send.run(async () => {
			try {
				const started = await api.startProtonImport(mailboxId, login.trim(), secret);
				if (session === currentSession()) await showOrRefetch(qc, mailboxId, started);
			} catch (error) {
				// One is already running (another tab started it): show it.
				if (error instanceof ApiError && error.status === 409 && session === currentSession()) await qc.invalidateQueries({ queryKey: key(mailboxId) });
				throw error;
			}
		});
	};
	return (
		<Section>
			<Heading title="Sign in to Proton">
				Magnus copies your mail here with its folders, labels, stars, and read state, and keeps going after you close this page.
			</Heading>
			<form className="flex flex-col gap-5" onSubmit={onSubmit}>
				<FieldGroup className="gap-4">
					<Field>
						<FieldLabel htmlFor="proton-login">Proton address or username</FieldLabel>
						<Input id="proton-login" autoComplete="username" required value={login} onChange={(e) => setLogin(e.target.value)} />
					</Field>
					<Field>
						<FieldLabel htmlFor="proton-password">Password</FieldLabel>
						<Input id="proton-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
						<FieldDescription>Used once to sign in, then forgotten. Magnus signs out of Proton when it’s done.</FieldDescription>
					</Field>
					<MailboxChoice mailboxes={props.mailboxes} value={mailboxId} onChange={setChosen} />
					{send.error ? <FieldError>{send.error}</FieldError> : null}
				</FieldGroup>
				<Button type="submit" className="self-start" disabled={send.pending}>
					{send.pending ? <Spinner data-icon="inline-start" /> : null}
					{send.pending ? "Starting…" : "Sign in and import"}
				</Button>
			</form>
		</Section>
	);
}

type Mailbox = Me["mailboxes"][number];

/** The import in one mailbox, in whichever state it's in. */
function Job(props: { mailbox: Mailbox; job: ProtonImportJob; named: boolean }) {
	const { job, mailbox } = props;
	const actions = useJobActions(mailbox.id, job.id);
	const stop = job.mine ? <StopButton actions={actions} /> : null;
	const into = props.named ? ` into ${mailbox.name}` : "";
	switch (job.phase) {
		case "starting":
		case "signing-in":
			return <Working label={job.phase === "starting" ? `Starting Proton’s export tool${into}…` : `Signing in to Proton${into}…`} stop={stop} error={actions.error} />;
		case "needs-code":
		case "needs-mailbox-password":
		case "needs-verification":
			return <Asking mailboxId={mailbox.id} into={into} job={job} phase={job.phase} stop={stop} error={actions.error} />;
		case "exporting":
			return <Exporting job={job} into={into} stop={stop} error={actions.error} />;
		case "done":
			return <Finished job={job} into={into} actions={actions} />;
		case "failed":
		case "cancelled":
			return <Stopped job={job} actions={actions} />;
	}
}

/** Stopping import `jobId`, and clearing it from the page once it's finished. */
function useJobActions(mailboxId: string, jobId: string) {
	const qc = useQueryClient();
	const stop = useMutation({
		mutationFn: () => api.stopProtonImport(mailboxId, jobId),
		onMutate: currentSession,
		onSuccess: (data, _, session) => (session === currentSession() ? showOrRefetch(qc, mailboxId, data) : undefined),
	});
	// Cleared means no import here now, so that's what's shown.
	const clear = useMutation({
		mutationFn: () => api.clearProtonImport(mailboxId, jobId),
		onMutate: currentSession,
		onSuccess: (data, _, session) => {
			if (session === currentSession()) qc.setQueryData(key(mailboxId), data);
		},
	});
	const error = stop.error ?? clear.error;
	return { stop, clear, error: error ? errorMessage(error) : null };
}
type JobActions = ReturnType<typeof useJobActions>;

function StopButton(props: { actions: JobActions }) {
	return (
		<Button variant="outline" size="sm" onClick={() => props.actions.stop.mutate()} disabled={props.actions.stop.isPending}>
			Stop
		</Button>
	);
}

/** Clears a finished import so another can start, once its container is gone. */
function ClearButton(props: { job: ProtonImportJob; actions: JobActions; label: string; variant?: "default" | "ghost" }) {
	const { closing } = props.job;
	return (
		<Button variant={props.variant ?? "default"} onClick={() => props.actions.clear.mutate()} disabled={closing || props.actions.clear.isPending}>
			{closing ? <Spinner data-icon="inline-start" /> : null}
			{closing ? "Finishing up…" : props.label}
		</Button>
	);
}

function Alert(props: { error: string | null }) {
	return props.error ? <p role="alert" className="text-destructive">{props.error}</p> : null;
}

function Working(props: { label: string; stop: ReactNode; error: string | null }) {
	return (
		<Section>
			<div className="flex items-center justify-between gap-3">
				<p className="flex items-center gap-2 font-medium" aria-live="polite">
					<Spinner /> {props.label}
				</p>
				{props.stop}
			</div>
			<Alert error={props.error} />
		</Section>
	);
}

function Asking(props: {
	mailboxId: string;
	into: string;
	job: ProtonImportJob;
	phase: "needs-code" | "needs-mailbox-password" | "needs-verification";
	stop: ReactNode;
	error: string | null;
}) {
	const { job } = props;
	// Proton's questions are for whoever is signing in.
	if (!job.mine || job.prompt === null) {
		return (
			<Section>
				<p className="flex items-center gap-2 text-muted-foreground"><Spinner /> Waiting for whoever started the import{props.into} to answer Proton.</p>
			</Section>
		);
	}
	const question = { mailboxId: props.mailboxId, job: job.id, prompt: job.prompt, error: job.error, stop: props.stop };
	return (
		<Section>
			{props.phase === "needs-code" ? (
				<CodeQuestion {...question} />
			) : props.phase === "needs-mailbox-password" ? (
				<PasswordQuestion {...question} />
			) : (
				<VerificationQuestion {...question} verifyUrl={job.verifyUrl} />
			)}
			<Alert error={props.error} />
		</Section>
	);
}

function Exporting(props: { job: ProtonImportJob; into: string; stop: ReactNode; error: string | null }) {
	return (
		<Section>
			<div className="flex items-baseline justify-between gap-3">
				<p className="font-medium">Importing from Proton{props.into}…</p>
				<p className="text-muted-foreground tabular-nums" aria-live="polite">
					{plural(props.job.imported, "message")}
				</p>
			</div>
			<Progress value={props.job.percent} aria-label="Import progress" />
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground">You can close this page.</p>
				{props.stop}
			</div>
			<Alert error={props.error} />
		</Section>
	);
}

function Finished(props: { job: ProtonImportJob; into: string; actions: JobActions }) {
	const { job } = props;
	const skipped = skippedOf(job);
	return (
		<Section>
			<div className="flex items-start gap-3">
				<CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" />
				<div className="flex flex-col gap-1">
					<p className="font-medium">{plural(job.imported, "message")} imported from Proton{props.into}</p>
					{skipped ? <p className="text-muted-foreground">Left out {skipped}.</p> : null}
					<p className="text-muted-foreground">It can take a few minutes for all of it to show up in your mail.</p>
				</div>
			</div>
			<Refused job={job} />
			<Alert error={props.actions.error} />
			<div className="flex flex-wrap gap-2">
				<Link to="/" className={buttonVariants()}>Go to your inbox</Link>
				<ClearButton job={job} actions={props.actions} label="Done" variant="ghost" />
			</div>
		</Section>
	);
}

/** Failed or cancelled: what came over stays, and starting again skips it. */
function Stopped(props: { job: ProtonImportJob; actions: JobActions }) {
	const { job } = props;
	return (
		<Section>
			<div className="flex flex-col gap-1">
				<p className="font-medium">
					{job.phase === "cancelled" ? "Import stopped" : "The import from Proton stopped"}
					{job.imported ? ` after ${plural(job.imported, "message")}` : ""}
				</p>
				{job.error ? <p role="alert" className={job.phase === "failed" ? "text-destructive" : "text-muted-foreground"}>{job.error}</p> : null}
				{job.imported ? <p className="text-muted-foreground">Starting again skips mail that’s already here.</p> : null}
			</div>
			<Refused job={job} />
			<Alert error={props.actions.error} />
			<div className="flex flex-wrap gap-2">
				<ClearButton job={job} actions={props.actions} label="Start again" />
			</div>
		</Section>
	);
}

type QuestionProps = { mailboxId: string; job: string; prompt: number; error: string | null; stop: ReactNode };

/** Answers Proton's question `prompt`. Proton's error with the question shows until there's a newer one of ours. */
function useAnswer(props: QuestionProps) {
	const qc = useQueryClient();
	const send = useSecret();
	return {
		pending: send.pending,
		error: send.error ?? props.error,
		answer(text: string) {
			const session = currentSession();
			void send.run(async () => {
				try {
					const answered = await api.answerProton(props.mailboxId, props.job, props.prompt, text);
					if (session === currentSession()) await showOrRefetch(qc, props.mailboxId, answered);
				} catch (error) {
					// Proton moved on (another tab answered, or it timed out): show where it is now.
					if (error instanceof ApiError && error.status === 409 && session === currentSession()) await qc.invalidateQueries({ queryKey: key(props.mailboxId) });
					throw error;
				}
			});
		},
	};
}

function CodeQuestion(props: QuestionProps) {
	const [code, setCode] = useState("");
	const send = useAnswer(props);
	const submit = (digits: string) => {
		setCode("");
		send.answer(digits);
	};
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				submit(code);
			}}
		>
			<Heading title="Enter your Proton 2FA code">The 6-digit code from your authenticator app.</Heading>
			<InputOTP
				maxLength={6}
				pattern={REGEXP_ONLY_DIGITS}
				autoFocus
				aria-label="Proton 2FA code"
				value={code}
				onChange={setCode}
				// The sixth digit sends it, as signing in here does.
				onComplete={(digits: string) => {
					if (!send.pending) submit(digits);
				}}
			>
				<InputOTPGroup>
					{[0, 1, 2].map((i) => (
						<InputOTPSlot key={i} index={i} className="size-10 text-base" />
					))}
				</InputOTPGroup>
				<InputOTPSeparator />
				<InputOTPGroup>
					{[3, 4, 5].map((i) => (
						<InputOTPSlot key={i} index={i} className="size-10 text-base" />
					))}
				</InputOTPGroup>
			</InputOTP>
			<Alert error={send.error} />
			<div className="flex items-center gap-2">
				<Button type="submit" disabled={send.pending || code.length < 6}>
					{send.pending ? <Spinner data-icon="inline-start" /> : null}
					Continue
				</Button>
				<div className="ml-auto">{props.stop}</div>
			</div>
		</form>
	);
}

function PasswordQuestion(props: QuestionProps) {
	const [password, setPassword] = useState("");
	const send = useAnswer(props);
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				const secret = password;
				setPassword("");
				send.answer(secret);
			}}
		>
			<Heading title="Enter your mailbox password">Your Proton account has a second password for its mail.</Heading>
			<Field>
				<FieldLabel htmlFor="proton-mailbox-password">Mailbox password</FieldLabel>
				<Input id="proton-mailbox-password" type="password" autoComplete="off" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} />
			</Field>
			<Alert error={send.error} />
			<div className="flex items-center gap-2">
				<Button type="submit" disabled={send.pending}>
					{send.pending ? <Spinner data-icon="inline-start" /> : null}
					Continue
				</Button>
				<div className="ml-auto">{props.stop}</div>
			</div>
		</form>
	);
}

function VerificationQuestion(props: QuestionProps & { verifyUrl: string | null }) {
	const send = useAnswer(props);
	return (
		<>
			<Heading title="Proton wants to check you’re a person">Do its check, then come back here and continue.</Heading>
			<Alert error={send.error} />
			<div className="flex flex-wrap items-center gap-2">
				{props.verifyUrl ? (
					<a href={props.verifyUrl} target="_blank" rel="noreferrer" className={buttonVariants()}>
						Open Proton’s check
						<ExternalLinkIcon data-icon="inline-end" />
					</a>
				) : null}
				<Button variant="outline" onClick={() => send.answer("")} disabled={send.pending}>
					{send.pending ? <Spinner data-icon="inline-start" /> : null}
					I’ve done it
				</Button>
				<div className="ml-auto">{props.stop}</div>
			</div>
		</>
	);
}

/** Mail Magnus refused (not mail), the first few. */
function Refused(props: { job: ProtonImportJob }) {
	if (!props.job.refusedCount) return null;
	return (
		<div className="flex flex-col gap-2">
			<p className="text-destructive">{plural(props.job.refusedCount, "message")} couldn’t be imported</p>
			<ul className="max-h-48 overflow-y-auto rounded-lg border text-xs">
				{props.job.refused.map((r) => (
					<li key={r.id} className="flex gap-2 border-b px-3 py-1.5 last:border-0">
						<span className="min-w-0 flex-1 truncate font-mono" title={r.id}>{r.id}</span>
						<span className="shrink-0 text-muted-foreground">{r.error}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Sends something secret: it's passed straight to the request, not through a mutation, whose cache would keep it.
 * The error is shown until the next try.
 */
function useSecret() {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return {
		pending,
		error,
		async run(send: () => Promise<unknown>) {
			setPending(true);
			setError(null);
			try {
				await send();
			} catch (e) {
				setError(errorMessage(e));
			} finally {
				setPending(false);
			}
		},
	};
}

/**
 * Shows the job an action answered with. No job means the one acted on was replaced meanwhile (another tab), so the
 * mailbox's real state is fetched instead: caching "none" would hide the new one and stop polling it.
 */
function showOrRefetch(qc: QueryClient, mailboxId: string, data: { job: ProtonImportJob | null }): Promise<void> | void {
	if (data.job) qc.setQueryData(key(mailboxId), data);
	else return qc.invalidateQueries({ queryKey: key(mailboxId) });
}

function Section(props: { children: ReactNode }) {
	return <section className="flex flex-col gap-4 rounded-xl border p-5">{props.children}</section>;
}

function Heading(props: { title: string; children?: ReactNode }) {
	return (
		<div className="flex flex-col gap-1">
			<h2 className="font-medium">{props.title}</h2>
			{props.children ? <p className="text-pretty text-muted-foreground">{props.children}</p> : null}
		</div>
	);
}

function skippedOf(job: ProtonImportJob): string | null {
	const parts = [
		job.drafts ? plural(job.drafts, "draft") : null,
		job.tooBig ? `${plural(job.tooBig, "message")} over ${formatBytes(MAX_IMPORT_BYTES)}` : null,
		job.unexported ? `${plural(job.unexported, "message")} Proton couldn’t export` : null,
		job.unreadable ? `${plural(job.unreadable, "message")} whose Proton details couldn’t be read` : null,
	].filter((s) => s !== null);
	return parts.length ? LIST.format(parts) : null;
}
