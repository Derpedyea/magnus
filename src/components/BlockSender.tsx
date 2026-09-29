import { isValidAddress } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/toast-manager";
import { adminApi, errorMessage } from "../api";
import { useAccount } from "../hooks";

/**
 * Blocks a message's sender, or everyone at their domain. Only admins see it: a block refuses their mail for
 * every mailbox here.
 */
export function BlockSender({ address }: { address: string }) {
	const { user } = useAccount();
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const id = useId();
	const domain = address.slice(address.lastIndexOf("@") + 1);
	const [wholeDomain, setWholeDomain] = useState(false);
	const block = useMutation({
		mutationFn: () => adminApi.blockSender(wholeDomain ? `*@${domain}` : address),
		onSuccess: () => {
			setOpen(false);
			toast.add({ title: `Blocked ${wholeDomain ? `everyone at ${domain}` : address}` });
			return qc.invalidateQueries({ queryKey: ["admin"] });
		},
	});
	// Mail without a From address (some bounces) has no one to block.
	if (!user.isAdmin || !isValidAddress(address)) return null;

	return (
		<>
			<Button variant="link" size="xs" className="text-muted-foreground" onClick={() => setOpen(true)}>
				Block sender
			</Button>
			<AlertDialog open={open} onOpenChange={setOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Block {address}?</AlertDialogTitle>
						<AlertDialogDescription>
							New mail is refused for everyone here, and what's already arrived stays. Unblock under Admin › Blocked senders.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<RadioGroup value={wholeDomain ? "domain" : "address"} onValueChange={(value) => setWholeDomain(value === "domain")} aria-label="Block">
						<Field orientation="horizontal">
							<RadioGroupItem id={`${id}-address`} value="address" />
							<FieldLabel htmlFor={`${id}-address`} className="font-normal">
								Only {address}
							</FieldLabel>
						</Field>
						<Field orientation="horizontal">
							<RadioGroupItem id={`${id}-domain`} value="domain" />
							<FieldLabel htmlFor={`${id}-domain`} className="font-normal">
								Everyone at {domain}
							</FieldLabel>
						</Field>
					</RadioGroup>
					{block.error ? <FieldError>{errorMessage(block.error)}</FieldError> : null}
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction variant="destructive" onClick={() => block.mutate()} disabled={block.isPending}>
							Block
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
