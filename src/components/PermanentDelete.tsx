import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
	AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { currentSession } from "../session";

const route = getRouteApi("/_app/_mail/$view");

type Target =
	| { thread: { mailboxId: string; id: string; subject: string; count: number } }
	| { scope: string[]; disabled: boolean };

/** Irreversible actions stay open on failure; dismissing is disabled once the server starts deleting. */
export function PermanentDelete(props: Target) {
	const [open, setOpen] = useState(false);
	const qc = useQueryClient();
	const navigate = route.useNavigate();
	const label = "thread" in props ? "Delete forever" : "Empty Trash";
	const deletion = useMutation({
		mutationFn: () => "thread" in props ? api.deleteThread(props.thread.mailboxId, props.thread.id) : api.emptyTrash(props.scope),
		onMutate: currentSession,
		onSuccess: ({ deleted }, _, session) => {
			if (session !== currentSession()) return;
			// Clear active detail caches too: otherwise reopening a deleted URL can render its old data.
			qc.removeQueries({ queryKey: ["mail", "thread"] });
			toast.add({ title: deleted === 0 ? "No messages in Trash to delete." : `${deleted} ${deleted === 1 ? "message" : "messages"} permanently deleted.`, type: "success" });
		},
		onSettled: (_, __, ___, session) => {
			// Emptying several mailboxes can partly succeed. Refetch even on error, only for the account that asked.
			if (session === currentSession()) void qc.invalidateQueries({ queryKey: ["mail"] });
		},
	});

	return (
		<AlertDialog open={open} onOpenChange={(next, details) => {
			if (deletion.isPending) return details.cancel();
			deletion.reset();
			setOpen(next);
		}}>
			<AlertDialogTrigger render={<Button variant="destructive" size="sm" disabled={"disabled" in props && props.disabled} />}>
				<Trash2Icon data-icon="inline-start" />
				{label}
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{"thread" in props ? "Delete forever?" : "Empty Trash?"}</AlertDialogTitle>
					<AlertDialogDescription className="break-words">
						{"thread" in props
							? <>Permanently delete {props.thread.count === 1 ? "the message" : `${props.thread.count} messages`} in Trash from “{props.thread.subject}”? Messages outside Trash stay.</>
							: <>Permanently delete all messages in Trash{props.scope.length > 0 ? ` for ${props.scope.join(", ")}` : " across all your addresses"}, including those beyond this page?</>}
						{" "}This can’t be undone. Files shared from deleted messages will stop working.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{deletion.error ? <FieldError>{errorMessage(deletion.error)} Try again.</FieldError> : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deletion.isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate(undefined, {
						onSuccess: (_, __, session) => {
							// Per-call callbacks only run while mounted; a view left mid-request must not navigate later.
							if (session !== currentSession()) return;
							setOpen(false);
							void navigate({ to: "/$view", params: { view: "trash" }, search: true });
						},
					})}>
						{deletion.isPending ? <><Spinner data-icon="inline-start" />Deleting…</> : label}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
