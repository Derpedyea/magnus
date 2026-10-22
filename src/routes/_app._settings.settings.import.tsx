import { formatBytes, type Me } from "#shared";
import { MAX_IMPORT_BYTES } from "#shared/import";
import { createFileRoute, Link, useBlocker } from "@tanstack/react-router";
import { CircleCheckIcon, FolderInputIcon } from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import {
	AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
	AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "../api";
import { MailboxChoice } from "../components/MailboxChoice";
import { ProtonImport } from "../components/ProtonImport";
import { SettingsPage } from "../components/SettingsPage";
import { useAccount } from "../hooks";
import { LIST, plural } from "../words";
import {
	droppedFiles, importBody, type ImportItem, type ImportOutcome, type ImportPlan, type ImportProgress, type PickedFile,
	pickedFiles, planImport, runImport, wait,
} from "../import";

export const Route = createFileRoute("/_app/_settings/settings/import")({ component: Import });

const EXPORT_TOOL = "https://proton.me/support/proton-mail-export-tool";
const TAKEOUT = "https://takeout.google.com/settings/takeout/custom/gmail";

type Stage =
	| { step: "pick"; error: string | null }
	/** How much of its mbox files has been read, when it has some. */
	| { step: "reading"; fraction: number | null }
	| { step: "ready"; plan: ImportPlan }
	| { step: "running"; plan: ImportPlan; items: ImportItem[]; before: number; progress: ImportProgress; left: string | null }
	// Where it went, so trying the failed ones again sends them there whatever's chosen since.
	| { step: "done"; plan: ImportPlan; imported: number; outcome: ImportOutcome; into: string };

/**
 * Brings mail over from Proton, Gmail's Takeout, Thunderbird, or any folder of .eml or mbox files, like Tuta's and
 * mailbox.org's file imports: drop the export, see what's in it, import. The browser sends each message on its own, so
 * this page has to stay open while it runs.
 */
function Import() {
	const { mailboxes } = useAccount();
	const [stage, setStage] = useState<Stage>({ step: "pick", error: null });
	const [mailboxId, setMailboxId] = useState(mailboxes[0]?.id ?? "");
	const running = useRef<AbortController | null>(null);
	useEffect(
		() => () => {
			running.current?.abort();
			running.current = null;
		},
		[],
	);

	const busy = stage.step === "running";
	const blocker = useBlocker({ shouldBlockFn: () => true, disabled: !busy, enableBeforeUnload: busy, withResolver: true });

	const read = async (files: Promise<PickedFile[]>) => {
		setStage({ step: "reading", fraction: null });
		try {
			// A Takeout is read a chunk at a time, hundreds of thousands of them: show only whole percents.
			const plan = await planImport(await files, (fraction) => {
				const percent = Math.floor(fraction * 100) / 100;
				setStage((s) => (s.step === "reading" && s.fraction !== percent ? { step: "reading", fraction: percent } : s));
			});
			setStage({ step: "ready", plan });
		} catch (error) {
			setStage({ step: "pick", error: errorMessage(error) });
		}
	};

	const start = async (plan: ImportPlan, items: ImportItem[], before: number, into: string) => {
		const controller = new AbortController();
		running.current = controller;
		const started = Date.now();
		const total = items.reduce((n, i) => n + i.size, 0);
		setStage({ step: "running", plan, items, before, progress: { done: 0, failed: [], bytesDone: 0 }, left: null });
		const outcome = await runImport(items, {
			signal: controller.signal,
			upload: async (item, signal) => api.importMessage(into, await importBody(item), item.placement, signal),
			sleep: wait,
			onProgress: (progress) => {
				const left = timeLeft(Date.now() - started, progress.bytesDone, total);
				setStage((s) => (s.step === "running" ? { ...s, progress, left } : s));
			},
		});
		// Left the page, which stopped it.
		if (running.current !== controller) return;
		running.current = null;
		setStage({ step: "done", plan, imported: before + outcome.done, outcome, into });
	};

	const mailbox = mailboxes.find((m) => m.id === mailboxId);
	if (!mailbox) {
		return (
			<SettingsPage title="Import mail">
				<p className="text-muted-foreground">You don’t have a mailbox to import into.</p>
			</SettingsPage>
		);
	}

	return (
		<SettingsPage title="Import mail">
			<div className="flex max-w-xl flex-col gap-8">
				{/* Chooses where its mail goes on its own: the folder's choice below is the folder's. */}
				<ProtonImport mailboxes={mailboxes} />
				<div className="flex flex-col gap-3">
					<h2 className="font-medium">Or import an export</h2>
				{stage.step === "pick" || stage.step === "reading" ? (
					<DropZone
						reading={stage.step === "reading" ? stage.fraction : undefined}
						error={stage.step === "pick" ? stage.error : null}
						onFiles={(files) => void read(files)}
					/>
				) : stage.step === "ready" ? (
					<Ready
						plan={stage.plan}
						mailboxes={mailboxes}
						mailboxId={mailboxId}
						onMailbox={setMailboxId}
						onStart={() => void start(stage.plan, stage.plan.items, 0, mailboxId)}
						onCancel={() => setStage({ step: "pick", error: null })}
					/>
				) : stage.step === "running" ? (
					<Running
						done={stage.progress.done + stage.progress.failed.length}
						total={stage.items.length}
						left={stage.left}
						onStop={() => running.current?.abort()}
					/>
				) : (
					<Done
						stage={stage}
						onRetry={() => void start(stage.plan, stage.outcome.failed.map((f) => f.item), stage.imported, stage.into)}
						onAgain={() => setStage({ step: "pick", error: null })}
					/>
				)}
				</div>
			</div>

			<AlertDialog
				open={blocker.status === "blocked"}
				onOpenChange={(open) => {
					if (!open) blocker.reset?.();
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Stop importing?</AlertDialogTitle>
						<AlertDialogDescription>
							Mail imported so far stays. To finish later, import the same export again; nothing is copied twice.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Keep importing</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>Stop and leave</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</SettingsPage>
	);
}

/** `reading` is undefined until something's chosen, then how much of its mbox files has been read, if it has any. */
function DropZone(props: { reading: number | null | undefined; error: string | null; onFiles: (files: Promise<PickedFile[]>) => void }) {
	const [over, setOver] = useState(false);
	const folderInput = useRef<HTMLInputElement>(null);
	const filesInput = useRef<HTMLInputElement>(null);
	const onPick = (e: ChangeEvent<HTMLInputElement>) => {
		const files = e.currentTarget.files;
		if (files?.length) props.onFiles(Promise.resolve(pickedFiles(files)));
		// The same folder can be chosen again, to finish an import that stopped.
		e.currentTarget.value = "";
	};
	const onDrop = (e: DragEvent) => {
		e.preventDefault();
		setOver(false);
		// Only readable while the event fires.
		const entries = Array.from(e.dataTransfer.items, (item) => item.webkitGetAsEntry()).filter((entry) => entry !== null);
		props.onFiles(droppedFiles(entries));
	};
	return (
		<div className="flex flex-col gap-3">
			<div
				onDragOver={(e) => {
					e.preventDefault();
					setOver(true);
				}}
				onDragLeave={(e) => {
					if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setOver(false);
				}}
				onDrop={onDrop}
				className={cn(
					"flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-10 text-center transition-colors",
					over && "border-primary bg-primary/5",
				)}
			>
				<div className="flex size-10 items-center justify-center rounded-lg bg-muted">
					<FolderInputIcon className="size-5" />
				</div>
				<div className="flex max-w-sm flex-col gap-1 text-balance">
					<p className="font-medium">Drop an export here</p>
					<p className="text-muted-foreground">
						The .mbox file from{" "}
						<a href={TAKEOUT} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-3">
							Gmail’s Takeout
						</a>
						, Thunderbird’s Mail folder, the <span className="font-mono text-[0.9em]">mail_…</span> folder{" "}
						<a href={EXPORT_TOOL} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-3">
							Proton’s Export Tool
						</a>{" "}
						saves, or any folder of .eml or mbox files.
					</p>
				</div>
				{props.reading !== undefined ? (
					<p className="flex h-8 items-center gap-2 text-muted-foreground tabular-nums" aria-live="polite">
						<Spinner /> Reading the export…{props.reading === null ? "" : ` ${Math.round(props.reading * 100)}%`}
					</p>
				) : (
					<div className="flex flex-wrap justify-center gap-2">
						<Button variant="outline" onClick={() => folderInput.current?.click()}>
							Choose folder
						</Button>
						<Button variant="outline" onClick={() => filesInput.current?.click()}>
							Choose files
						</Button>
					</div>
				)}
				<input
					ref={(el) => {
						folderInput.current = el;
						if (el) el.webkitdirectory = true;
					}}
					type="file"
					hidden
					onChange={onPick}
				/>
				<input ref={filesInput} type="file" multiple hidden onChange={onPick} />
			</div>
			{props.error ? <p role="alert" className="text-destructive">{props.error}</p> : null}
		</div>
	);
}

function Ready(props: {
	plan: ImportPlan;
	mailboxes: Me["mailboxes"];
	mailboxId: string;
	onMailbox: (id: string) => void;
	onStart: () => void;
	onCancel: () => void;
}) {
	const { plan } = props;
	const count = plan.items.length;
	const skipped = [
		plan.drafts ? plural(plan.drafts, "draft") : null,
		plan.deleted ? `${plural(plan.deleted, "message")} Thunderbird deleted` : null,
		plan.tooBig.length ? `${plural(plan.tooBig.length, "message")} over ${formatBytes(MAX_IMPORT_BYTES)}` : null,
		plan.unexported ? `${plural(plan.unexported, "message")} Proton couldn’t export` : null,
		plan.unreadable.length ? `${plural(plan.unreadable.length, "message")} whose Proton details couldn’t be read` : null,
	].filter((s) => s !== null);
	return (
		<div className="flex flex-col gap-4 rounded-xl border p-5">
			<div className="flex flex-col gap-1">
				<p className="font-heading text-lg font-semibold tabular-nums">{count ? plural(count, "message") : "No mail to import"}</p>
				<p className="text-muted-foreground">
					{count ? `${formatBytes(plan.bytes)}${placedBy(plan)}` : "There are no .eml or mbox files in it."}
				</p>
				{skipped.length ? <p className="text-muted-foreground">Skipping {LIST.format(skipped)}.</p> : null}
			</div>
			{count ? <MailboxChoice mailboxes={props.mailboxes} value={props.mailboxId} onChange={props.onMailbox} /> : null}
			<div className="flex flex-wrap items-center gap-2">
				{count ? <Button onClick={props.onStart}>Import</Button> : null}
				<Button variant="ghost" onClick={props.onCancel} className={count ? "ml-auto" : undefined}>
					Choose another export
				</Button>
			</div>
		</div>
	);
}

function Running(props: { done: number; total: number; left: string | null; onStop: () => void }) {
	return (
		<div className="flex flex-col gap-3 rounded-xl border p-5">
			<div className="flex items-baseline justify-between gap-3">
				<p className="font-medium">Importing…</p>
				<p className="text-muted-foreground tabular-nums" aria-live="polite">
					{props.done.toLocaleString()} of {props.total.toLocaleString()}
				</p>
			</div>
			<Progress value={props.total ? (props.done / props.total) * 100 : 0} aria-label="Import progress" />
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground">{props.left ? `${props.left} · ` : ""}Keep this page open</p>
				<Button variant="outline" size="sm" onClick={props.onStop}>
					Stop
				</Button>
			</div>
		</div>
	);
}

function Done(props: { stage: Extract<Stage, { step: "done" }>; onRetry: () => void; onAgain: () => void }) {
	const { imported, outcome } = props.stage;
	const { failed } = outcome;
	const total = props.stage.plan.items.length;
	return (
		<div className="flex flex-col gap-4 rounded-xl border p-5">
			{outcome.stopped ? (
				<div className="flex flex-col gap-1">
					<p className="font-medium">Stopped after {imported.toLocaleString()} of {plural(total, "message")}</p>
					{outcome.fatal ? <p role="alert" className="text-destructive">{outcome.fatal}</p> : null}
					<p className="text-muted-foreground">Import the same export again to finish. Mail already imported isn’t copied twice.</p>
				</div>
			) : (
				<div className="flex items-start gap-3">
					<CircleCheckIcon className="mt-0.5 size-5 shrink-0 text-primary" />
					<div className="flex flex-col gap-1">
						<p className="font-medium">{plural(imported, "message")} imported</p>
						<p className="text-muted-foreground">It can take a few minutes for all of it to show up in your mail.</p>
					</div>
				</div>
			)}
			{failed.length && !outcome.stopped ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-3">
						<p className="text-destructive">{plural(failed.length, "message")} couldn’t be imported</p>
						<Button variant="outline" size="sm" onClick={props.onRetry}>Try again</Button>
					</div>
					<ul className="max-h-48 overflow-y-auto rounded-lg border text-xs">
						{failed.map((f) => (
							<li key={f.item.path} className="flex gap-2 border-b px-3 py-1.5 last:border-0">
								<span className="min-w-0 flex-1 truncate font-mono" title={f.item.path}>{f.item.name}</span>
								<span className="shrink-0 text-muted-foreground">{f.error}</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
			<div className="flex flex-wrap gap-2">
				{outcome.stopped ? null : <Link to="/" className={buttonVariants()}>Go to your inbox</Link>}
				<Button variant={outcome.stopped ? "default" : "ghost"} onClick={props.onAgain}>
					{outcome.stopped ? "Choose export" : "Import another export"}
				</Button>
			</div>
		</div>
	);
}

/** What of where its mail was comes along, after its size. */
function placedBy(plan: ImportPlan): string {
	if (plan.proton) return " from Proton. Folders, labels, stars, and read state come along.";
	if (plan.gmail) return " from Gmail. Labels, stars, and read state come along.";
	if (plan.mbox) return ". Folders, stars, and read state come along.";
	return "";
}

/** "About 3 minutes left", once there's enough to go on. */
function timeLeft(elapsedMs: number, bytesDone: number, bytesTotal: number): string | null {
	if (elapsedMs < 5000 || bytesDone === 0) return null;
	const minutes = Math.round(((bytesTotal - bytesDone) / bytesDone) * elapsedMs / 60_000);
	return minutes < 1 ? "Less than a minute left" : `About ${plural(minutes, "minute")} left`;
}
