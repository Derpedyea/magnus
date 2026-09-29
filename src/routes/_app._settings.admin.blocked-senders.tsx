import { blockPattern } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast-manager";
import { adminApi, errorMessage } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { directoryQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/admin/blocked-senders")({ component: BlockedSenders });

function BlockedSenders() {
	const { blockedSenders } = useSuspenseQuery(directoryQuery).data;
	const [adding, setAdding] = useState(false);

	return (
		<SettingsPage
			title="Blocked senders"
			action={
				<Button onClick={() => setAdding(true)}>
					<PlusIcon data-icon="inline-start" />
					Block sender
				</Button>
			}
		>
			{blockedSenders.length === 0 ? (
				<p className="text-muted-foreground">No one is blocked. You can also block someone from a message they sent.</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Sender</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{blockedSenders.map((pattern) => (
							<BlockedRow key={pattern} pattern={pattern} />
						))}
					</TableBody>
				</Table>
			)}
			<BlockDialog open={adding} onOpenChange={setAdding} />
		</SettingsPage>
	);
}

function BlockedRow({ pattern }: { pattern: string }) {
	const qc = useQueryClient();
	// Unblocking is undone by blocking again, so it doesn't ask first.
	const unblock = useMutation({
		mutationFn: () => adminApi.unblockSender(pattern),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
		onError: (error) => toast.add({ title: errorMessage(error), type: "error" }),
	});
	const domain = pattern.startsWith("*@") ? pattern.slice(2) : null;
	return (
		<TableRow>
			<TableCell>
				{domain ? (
					<>
						<span className="text-muted-foreground">Everyone at </span>
						<span className="font-medium">{domain}</span>
					</>
				) : (
					<span className="font-medium">{pattern}</span>
				)}
			</TableCell>
			<TableCell>
				<Button variant="ghost" size="sm" onClick={() => unblock.mutate()} disabled={unblock.isPending}>
					Unblock
				</Button>
			</TableCell>
		</TableRow>
	);
}

function BlockDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const qc = useQueryClient();
	const [input, setInput] = useState("");
	// Only said after a submit, so it doesn't nag mid-typing.
	const [invalid, setInvalid] = useState(false);
	const block = useMutation({
		mutationFn: adminApi.blockSender,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["admin"] });
			props.onOpenChange(false);
			setInput("");
		},
	});

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-6"
					onSubmit={(e) => {
						e.preventDefault();
						const pattern = blockPattern(input);
						setInvalid(pattern === null);
						if (pattern) block.mutate(pattern);
					}}
				>
					<DialogHeader>
						<DialogTitle>Block a sender</DialogTitle>
					</DialogHeader>
					<Field data-invalid={invalid || undefined}>
						<FieldLabel htmlFor="block-sender">Address or domain</FieldLabel>
						<Input
							id="block-sender"
							required
							value={input}
							onChange={(e) => {
								setInput(e.target.value);
								setInvalid(false);
							}}
							placeholder="name@example.com or example.com"
							aria-invalid={invalid || undefined}
						/>
						{invalid ? (
							<FieldError>Enter an address like name@example.com, or a domain like example.com.</FieldError>
						) : (
							<FieldDescription>Their mail is refused for everyone here. A domain blocks everyone at it.</FieldDescription>
						)}
						{block.error ? <FieldError>{errorMessage(block.error)}</FieldError> : null}
					</Field>
					<DialogFooter>
						<Button type="submit" disabled={block.isPending}>
							{block.isPending ? <Spinner data-icon="inline-start" /> : null}
							Block
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
