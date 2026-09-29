import type { DirectoryAddress, DirectoryDomain, DirectoryMailbox } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApi, errorMessage } from "../api";
import { AddressInput } from "../components/AddressInput";
import { SettingsPage } from "../components/SettingsPage";
import { directoryQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/admin/addresses")({ component: Addresses });

function Addresses() {
	const { addresses, mailboxes, domains } = useSuspenseQuery(directoryQuery).data;
	const [adding, setAdding] = useState(false);
	const names = new Map(mailboxes.map((m) => [m.id, m.name]));

	return (
		<SettingsPage
			title="Addresses"
			action={
				<Button onClick={() => setAdding(true)} disabled={domains.length === 0}>
					<PlusIcon data-icon="inline-start" />
					Add address
				</Button>
			}
		>
			{addresses.length === 0 ? (
				<p className="text-muted-foreground">No addresses yet.</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Address</TableHead>
							<TableHead>Delivers to</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{addresses.map((a) => (
							<AddressRow key={a.address} address={a} deliversTo={a.mailboxIds.map((id) => names.get(id) ?? id)} />
						))}
					</TableBody>
				</Table>
			)}
			<AddAddressDialog open={adding} onOpenChange={setAdding} domains={domains} mailboxes={mailboxes} />
		</SettingsPage>
	);
}

function AddressRow(props: { address: DirectoryAddress; deliversTo: string[] }) {
	const { address } = props.address;
	const qc = useQueryClient();
	const [removing, setRemoving] = useState(false);
	const remove = useMutation({
		mutationFn: () => adminApi.removeAddress(address),
		onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["me"] })]),
	});
	return (
		<TableRow>
			<TableCell className="font-medium">{address}</TableCell>
			<TableCell>{props.deliversTo.join(", ")}</TableCell>
			<TableCell>
				<Button variant="ghost" size="icon-sm" aria-label={`Remove ${address}`} onClick={() => setRemoving(true)}>
					<Trash2Icon />
				</Button>
				<AlertDialog open={removing} onOpenChange={setRemoving}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove {address}?</AlertDialogTitle>
							<AlertDialogDescription>New mail to it bounces, unless the domain delivers unknown addresses somewhere. Mail already received stays.</AlertDialogDescription>
						</AlertDialogHeader>
						{remove.error ? <FieldError>{errorMessage(remove.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
								Remove address
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

function AddAddressDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; domains: DirectoryDomain[]; mailboxes: DirectoryMailbox[] }) {
	const qc = useQueryClient();
	const [address, setAddress] = useState({ localPart: "", domain: props.domains[0]?.name ?? "" });
	const [displayName, setDisplayName] = useState("");
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	const add = useMutation({
		mutationFn: adminApi.addAddress,
		onSuccess: async () => {
			await Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["me"] })]);
			props.onOpenChange(false);
			setAddress((prev) => ({ ...prev, localPart: "" }));
			setDisplayName("");
			setMailboxIds([]);
		},
	});
	const toggle = (id: string, on: boolean) => setMailboxIds((prev) => (on ? [...prev, id] : prev.filter((m) => m !== id)));

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-6"
					onSubmit={(e) => {
						e.preventDefault();
						add.mutate({ ...address, localPart: address.localPart.trim(), displayName: displayName.trim() || undefined, mailboxIds });
					}}
				>
					<DialogHeader>
						<DialogTitle>Add an address</DialogTitle>
					</DialogHeader>
					<FieldGroup className="gap-5">
						<Field>
							<FieldLabel htmlFor="new-address">Address</FieldLabel>
							<AddressInput id="new-address" required value={address} onChange={setAddress} domains={props.domains} />
						</Field>
						<FieldSet>
							<FieldLegend variant="label">Delivers to</FieldLegend>
							<FieldDescription>Pick more than one for a shared address like family@. Everyone gets a copy and can reply from it.</FieldDescription>
							<FieldGroup className="gap-2.5">
								{props.mailboxes.map((m) => (
									<Field key={m.id} orientation="horizontal">
										<Checkbox id={`deliver-${m.id}`} checked={mailboxIds.includes(m.id)} onCheckedChange={(on) => toggle(m.id, on)} />
										<FieldLabel htmlFor={`deliver-${m.id}`} className="font-normal">
											{m.name}
										</FieldLabel>
									</Field>
								))}
							</FieldGroup>
						</FieldSet>
						<Field>
							<FieldLabel htmlFor="address-name">Name on sent mail</FieldLabel>
							<Input id="address-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="The sender's own name" />
						</Field>
						{add.error ? <FieldError>{errorMessage(add.error)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<Button type="submit" disabled={add.isPending || mailboxIds.length === 0}>
							{add.isPending ? <Spinner data-icon="inline-start" /> : null}
							Add address
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
