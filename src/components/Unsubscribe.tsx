import type { MessageDetail } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button-variants";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";

/**
 * Unsubscribe beside the sender of list mail, like Gmail's: it asks first, then takes you off the list by the way its
 * List-Unsubscribe header offers. A list that only offers a page to finish on gets a link to it: the browser opens it
 * from your click, so it isn't blocked as a pop-up.
 */
export function Unsubscribe({ mailboxId, message }: { mailboxId: string; message: MessageDetail }) {
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const [done, setDone] = useState(false);
	const name = message.from.name || message.from.address;
	const unsubscribe = useMutation({
		mutationFn: () => api.unsubscribe(mailboxId, message.id),
		onSuccess: (result) => {
			if ("page" in result) return;
			setOpen(false);
			setDone(true);
			toast.add({ title: result.done === "mail" ? `Asked ${name} by email to unsubscribe you` : `Unsubscribed from ${name}` });
			// The request by email is in Sent.
			if (result.done === "mail") return qc.invalidateQueries({ queryKey: ["mail"] });
		},
	});
	const page = unsubscribe.data && "page" in unsubscribe.data ? unsubscribe.data.page : null;
	const onOpenChange = (next: boolean) => {
		setOpen(next);
		if (!next) unsubscribe.reset();
	};

	if (done) return <span className="shrink-0 text-xs text-muted-foreground">Unsubscribed</span>;
	return (
		<>
			<button
				type="button"
				className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				onClick={() => setOpen(true)}
			>
				Unsubscribe
			</button>
			<AlertDialog open={open} onOpenChange={onOpenChange}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle className="break-words">Unsubscribe from {name}?</AlertDialogTitle>
						<AlertDialogDescription>
							{page ? "They need you to finish on their site." : "Magnus asks them to stop sending you this mail. What's already here stays."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					{unsubscribe.error ? <FieldError>{errorMessage(unsubscribe.error)}</FieldError> : null}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						{page ? (
							<a href={page} target="_blank" rel="noopener noreferrer" className={buttonVariants()} onClick={() => onOpenChange(false)}>
								<ExternalLinkIcon />
								Open their page
							</a>
						) : (
							<AlertDialogAction onClick={() => unsubscribe.mutate()} disabled={unsubscribe.isPending}>
								{unsubscribe.isPending ? <Spinner /> : null}
								Unsubscribe
							</AlertDialogAction>
						)}
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
