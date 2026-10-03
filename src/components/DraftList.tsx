import { makeSnippet } from "#shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { FilePenIcon, PaperclipIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { api, errorMessage } from "../api";
import { compose, openDraft, openLocalDraft } from "../compose";
import { useDraftEntries, useDraftSync } from "../drafts";
import { currentSession } from "../session";
import { draftsQuery } from "../queries";
import type { DraftEntry } from "../draft-sync";

/** Merge account storage with edits waiting to sync on this device, so a failed save remains findable. */
export function useDraftList(scope: string[]) {
	const query = useQuery(draftsQuery);
	const entries = useDraftEntries();
	const saved: DraftEntry[] = query.data?.drafts.map((draft) => ({ ...draft, dirty: false, removing: false, status: draft.state === "sending" ? "sending" : "saved" })) ?? [];
	const drafts = new Map(saved.map((draft) => [draft.id, draft]));
	for (const entry of entries) if (entry.status !== "saved" || !query.data || query.isError) drafts.set(entry.id, entry);
	return { query, drafts: [...drafts.values()].filter((draft) => scope.length === 0 || scope.includes(draft.content.from)).sort((a, b) => b.updatedAt - a.updatedAt) };
}

export function DraftList({ scope }: { scope: string[] }) {
	const { query, drafts } = useDraftList(scope);
	const sync = useDraftSync();
	const qc = useQueryClient();
	const opened = useSelector(compose, (open) => open?.draftId);
	const resume = useMutation({
		mutationFn: async (id: string) => {
			const pending = sync.get(id);
			if (pending && pending.status !== "saved") return { id, local: pending.content, saved: undefined };
			const saved = await api.draft(id);
			return { id, local: undefined, saved };
		},
		onMutate: currentSession,
		onSuccess: ({ id, local, saved }, _id, session) => {
			if (session !== currentSession() || compose.state?.draftId === id) return;
			if (local) openLocalDraft(id, local);
			else if (saved) openDraft(saved.content, true, saved);
		},
	});
	const discard = useMutation({
		mutationFn: async (id: string) => {
			const session = currentSession();
			if (!sync.get(id)) {
				const saved = await api.draft(id);
				if (session !== currentSession()) throw new Error("Your session ended");
				sync.adopt(saved);
			}
			await sync.discard(id);
		},
		onSuccess: () => void qc.invalidateQueries({ queryKey: ["drafts"] }),
	});
	const error = resume.error ?? discard.error ?? query.error;
	return (
		<section aria-label="Drafts" className="flex min-h-0 w-full flex-col md:w-96 md:shrink-0 md:border-r">
			<header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
				<h1 className="font-medium">Drafts</h1>
				{query.data || drafts.length ? <span className="text-xs tabular-nums text-muted-foreground">{drafts.length}</span> : null}
				<Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Refresh drafts" disabled={query.isFetching} onClick={() => void query.refetch()}>
					{query.isFetching ? <Spinner /> : <RefreshCwIcon />}
				</Button>
			</header>
			{error ? <div role="alert" className="flex items-center gap-2 border-b px-4 py-3 text-xs text-destructive"><span className="flex-1">{errorMessage(error)}</span><Button variant="outline" size="xs" onClick={() => {
				if (resume.error && resume.variables) resume.mutate(resume.variables);
				else if (discard.error && discard.variables) discard.mutate(discard.variables);
				else void query.refetch();
			}}>Retry</Button></div> : null}
			{query.isPending && drafts.length === 0 ? <div className="flex justify-center p-8"><Spinner /></div> : drafts.length === 0 && !query.isError ? (
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon"><FilePenIcon /></EmptyMedia>
						<EmptyTitle>No drafts</EmptyTitle>
						<EmptyDescription>Start a message and come back to it on any device.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul className="min-h-0 overflow-y-auto">
					{drafts.map((draft) => {
						const { content } = draft;
						const saving = draft.status === "pending" || draft.status === "saving";
						const unsynced = draft.status === "error" || draft.status === "conflict";
						const files = content.attachments.length + (content.forward?.files.length ?? 0);
						return (
							<li key={draft.id} className={cn("group relative border-b", opened === draft.id ? "bg-accent" : "hover:bg-muted/50")}>
								<button type="button" disabled={resume.isPending} onClick={() => resume.mutate(draft.id)} className="block w-full px-4 py-3 text-left outline-none focus-visible:bg-accent">
									<div className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate">{content.to.map((to) => to.name || to.address).join(", ") || "No recipients"}</span>
										<time dateTime={new Date(draft.updatedAt).toISOString()} title={new Date(draft.updatedAt).toLocaleString()} className="mr-7 shrink-0 text-xs tabular-nums text-muted-foreground">{formatDate(draft.updatedAt)}</time>
									</div>
									<div className="flex items-center gap-1.5"><span className="truncate font-medium">{content.subject || "(No subject)"}</span>{files ? <PaperclipIcon aria-label={`${files} attachments`} className="size-3 shrink-0 text-muted-foreground" /> : null}</div>
									<p className="truncate text-muted-foreground">{makeSnippet(content.text) || (content.forward ? "Forwarded message" : "No message yet")}</p>
									{saving || unsynced || draft.state === "sending" ? <p className={cn("mt-1 text-xs", unsynced ? "text-destructive" : "text-muted-foreground")}>{unsynced ? "Not synced · retry saving" : saving ? "Saving…" : "Send needs checking"}</p> : null}
								</button>
								<Tooltip>
									<TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`Discard ${content.subject || "untitled draft"}`} className="absolute top-2 right-2 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100" disabled={opened === draft.id || discard.isPending || draft.state === "sending" || unsynced} onClick={() => discard.mutate(draft.id)}><Trash2Icon /></Button>} />
									<TooltipContent>Discard draft</TooltipContent>
								</Tooltip>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

function formatDate(ms: number) {
	const date = new Date(ms);
	return date.toDateString() === new Date().toDateString() ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
