import { formatBytes, type MailboxFailedMail } from "#shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadIcon, MailCheckIcon, RotateCwIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
	AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, failedRawUrl } from "../api";
import { formatDate } from "../dates";
import { failedQuery } from "../queries";
import { currentSession } from "../session";

/** Incoming mail the queue gave up parsing. Each can be retried, downloaded as it arrived, or deleted for good. */
export function FailedList({ scope }: { scope: string[] }) {
	const qc = useQueryClient();
	const query = useQuery(failedQuery(scope));
	const failed = query.data ?? [];
	const [deleting, setDeleting] = useState<MailboxFailedMail | null>(null);
	// Refetch even on error, only for the account that asked.
	const refresh = (session: unknown) => {
		if (session === currentSession()) void qc.invalidateQueries({ queryKey: ["mail"] });
	};
	const retry = useMutation({
		mutationFn: (m: MailboxFailedMail) => api.retryFailed(m.mailboxId, m.id),
		onMutate: currentSession,
		onSettled: (_, __, ___, session) => refresh(session),
	});
	const remove = useMutation({
		mutationFn: (m: MailboxFailedMail) => api.deleteFailed(m.mailboxId, m.id),
		onMutate: currentSession,
		onSuccess: (_, __, session) => {
			if (session === currentSession()) setDeleting(null);
		},
		onSettled: (_, __, ___, session) => refresh(session),
	});
	const error = retry.error ?? query.error;

	return (
		<section aria-label="Failed" className="flex min-h-0 w-full flex-col md:w-96 md:shrink-0 md:border-r">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
				<h1 className="font-medium">Failed</h1>
				{failed.length ? <span className="text-xs tabular-nums text-muted-foreground">{failed.length}</span> : null}
			</header>
			{error ? (
				<div role="alert" className="flex items-center gap-2 border-b px-4 py-3 text-xs text-destructive">
					<span className="flex-1">{errorMessage(error)}</span>
					<Button variant="outline" size="xs" onClick={() => (retry.error && retry.variables ? retry.mutate(retry.variables) : void query.refetch())}>Retry</Button>
				</div>
			) : null}
			{query.isPending ? <div className="flex justify-center p-8"><Spinner /></div> : failed.length === 0 && !query.isError ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon"><MailCheckIcon /></EmptyMedia>
						<EmptyTitle>Nothing failed</EmptyTitle>
						<EmptyDescription>Incoming mail Magnus can’t read is kept here, so it isn’t lost.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul className="min-h-0 overflow-y-auto max-md:pb-24">
					{failed.map((m) => {
						// Asked just now, or queued again server-side, where it can take hours to fail again. Copies of mail sent to a
						// shared address have the same id in each mailbox.
						const asking = retry.isPending && retry.variables?.id === m.id && retry.variables.mailboxId === m.mailboxId;
						const retrying = m.retrying || asking;
						return (
							<li key={`${m.mailboxId}/${m.id}`} className="border-b px-4 py-3">
								<div className="flex items-center gap-2">
									<span className="min-w-0 flex-1 truncate font-medium">{m.from || "No sender"}</span>
									<time dateTime={new Date(m.receivedAt).toISOString()} title={new Date(m.receivedAt).toLocaleString()} className="shrink-0 text-xs tabular-nums text-muted-foreground">
										{formatDate(m.receivedAt)}
									</time>
								</div>
								<p className="truncate text-muted-foreground">To {m.to} · {formatBytes(m.size)}</p>
								<p className="mt-1 truncate text-xs text-muted-foreground" title={m.error ?? undefined}>
									{retrying ? "Retrying…" : (m.error ?? "No error was reported")}
								</p>
								<div className="mt-2 -ml-1 flex items-center gap-1">
									<Button variant="outline" size="sm" disabled={retrying} onClick={() => retry.mutate(m)}>
										{asking ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
										Retry
									</Button>
									<a href={failedRawUrl(m.mailboxId, m.id)} download className={buttonVariants({ variant: "ghost", size: "sm" })}>
										<DownloadIcon data-icon="inline-start" />
										Original
									</a>
									<Tooltip>
										<TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Delete mail from ${m.from || "no sender"}`} className="ml-auto" onClick={() => setDeleting(m)}><Trash2Icon /></Button>} />
										<TooltipContent>Delete for good</TooltipContent>
									</Tooltip>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<AlertDialog open={deleting !== null} onOpenChange={(open, details) => {
				if (remove.isPending) return details.cancel();
				remove.reset();
				if (!open) setDeleting(null);
			}}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete for good?</AlertDialogTitle>
						<AlertDialogDescription className="break-words">
							The mail from {deleting?.from || "no sender"} to {deleting?.to} is deleted along with its original. This can’t be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					{remove.error ? <FieldError>{errorMessage(remove.error)} Try again.</FieldError> : null}
					<AlertDialogFooter>
						<AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
							{remove.isPending ? <><Spinner data-icon="inline-start" />Deleting…</> : "Delete"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</section>
	);
}
