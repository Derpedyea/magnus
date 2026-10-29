import { type DirectoryAddress, type DirectoryDomain, type DirectoryMailbox, type HeldAddress, splitAddress } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApi, errorMessage } from "../api";
import { AddressInput, type AddressValue } from "../components/AddressInput";
import { SettingsPage } from "../components/SettingsPage";
import { directoryQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/admin/addresses")({ component: Addresses });

function Addresses() {
	const { addresses, mailboxes, domains, held } = useSuspenseQuery(directoryQuery).data;
	/** Whether Add address is open, and with the address mail is held for when it's opened from there. */
	const [adding, setAdding] = useState<{ open: boolean; address?: AddressValue }>({ open: false });
	const names = new Map(mailboxes.map((m) => [m.id, m.removedWith ? `${m.name} (archived)` : m.name]));
	const inUse = mailboxes.filter((m) => !m.removedWith);

	return (
		<SettingsPage
			title="Addresses"
			action={
				<Button onClick={() => setAdding({ open: true })} disabled={domains.length === 0}>
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
			{held.length > 0 ? (
				<section aria-labelledby="held-mail" className="flex flex-col gap-2">
					<h2 id="held-mail" className="font-medium">
						Held mail
					</h2>
					<p className="text-pretty text-muted-foreground">
						Mail to addresses that weren't added yet, in a domain's first 30 days here. Add the address to deliver it.
					</p>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Address</TableHead>
								<TableHead>Mail</TableHead>
								<TableHead className="hidden sm:table-cell">Deleted</TableHead>
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{held.map((h) => {
								const { local, domain } = splitAddress(h.address);
								return <HeldRow key={h.address} held={h} mailboxes={inUse} onAdd={() => setAdding({ open: true, address: { localPart: local, domain } })} />;
							})}
						</TableBody>
					</Table>
				</section>
			) : null}
			{/* A fresh form for each address it's opened with. */}
			<AddAddressDialog
				key={adding.address ? `${adding.address.localPart}@${adding.address.domain}` : ""}
				open={adding.open}
				onOpenChange={(open) => setAdding((prev) => ({ ...prev, open }))}
				initial={adding.address}
				domains={domains}
				mailboxes={inUse}
			/>
		</SettingsPage>
	);
}

const formatDay = (ms: number) => new Date(ms).toLocaleDateString([], { dateStyle: "medium" });

/** Mail held for an address not added yet: what it is, and where it can go. */
function HeldRow(props: { held: HeldAddress; mailboxes: DirectoryMailbox[]; onAdd: () => void }) {
	const { address, count, newest, expiresAt } = props.held;
	const qc = useQueryClient();
	const [delivering, setDelivering] = useState(false);
	const [discarding, setDiscarding] = useState(false);
	const discard = useMutation({
		mutationFn: () => adminApi.discardHeld(address),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
	});
	return (
		<TableRow>
			<TableCell className="font-medium">{address}</TableCell>
			<TableCell className="max-w-72">
				<div className="flex flex-col">
					<span className="truncate">{newest.subject || "(no subject)"}</span>
					<span className="truncate text-muted-foreground">
						{newest.sender}
						{count > 1 ? ` · ${count} messages` : ""}
					</span>
				</div>
			</TableCell>
			<TableCell className="hidden sm:table-cell">{formatDay(expiresAt)}</TableCell>
			<TableCell>
				<div className="flex items-center gap-1">
					<Button variant="outline" size="sm" onClick={props.onAdd}>
						Add address
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${address}`} />}>
							<EllipsisIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto">
							<DropdownMenuItem onClick={() => setDelivering(true)}>Deliver to…</DropdownMenuItem>
							<DropdownMenuItem variant="destructive" onClick={() => setDiscarding(true)}>
								Discard…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<DeliverHeldDialog open={delivering} onOpenChange={setDelivering} held={props.held} mailboxes={props.mailboxes} />
				<AlertDialog open={discarding} onOpenChange={setDiscarding}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Discard mail to {address}?</AlertDialogTitle>
							<AlertDialogDescription>
								{count === 1 ? "The message is" : `All ${count} messages are`} deleted now, and nobody gets {count === 1 ? "it" : "them"}.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{discard.error ? <FieldError>{errorMessage(discard.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => discard.mutate()} disabled={discard.isPending}>
								Discard
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

/** Held mail into a mailbox, without adding its address: for an old address nobody keeps. */
function DeliverHeldDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; held: HeldAddress; mailboxes: DirectoryMailbox[] }) {
	const { address, count } = props.held;
	const id = useId();
	const qc = useQueryClient();
	const [picked, setPicked] = useState("");
	// The first until another is picked.
	const mailboxId = props.mailboxes.find((m) => m.id === picked)?.id ?? props.mailboxes[0]?.id;
	const deliver = useMutation({
		mutationFn: (to: string) => adminApi.deliverHeld(address, [to]),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["admin"] });
			props.onOpenChange(false);
		},
	});
	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Deliver mail to {address}</DialogTitle>
					<DialogDescription>
						{count === 1 ? "It goes" : `All ${count} go`} to the mailbox you pick. The address isn't added, so new mail to it is still held.
					</DialogDescription>
				</DialogHeader>
				<RadioGroup value={mailboxId ?? ""} onValueChange={(value) => setPicked(String(value))} aria-label="Mailbox">
					{props.mailboxes.map((m) => (
						<Field key={m.id} orientation="horizontal">
							<RadioGroupItem id={`${id}-${m.id}`} value={m.id} />
							<FieldLabel htmlFor={`${id}-${m.id}`} className="font-normal">
								{m.name}
							</FieldLabel>
						</Field>
					))}
				</RadioGroup>
				{deliver.error ? <FieldError>{errorMessage(deliver.error)}</FieldError> : null}
				<DialogFooter>
					<Button onClick={() => mailboxId && deliver.mutate(mailboxId)} disabled={!mailboxId || deliver.isPending}>
						{deliver.isPending ? <Spinner data-icon="inline-start" /> : null}
						Deliver
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
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

function AddAddressDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Held mail's address, delivered there once it's added. */
	initial?: AddressValue | undefined;
	domains: DirectoryDomain[];
	mailboxes: DirectoryMailbox[];
}) {
	const qc = useQueryClient();
	const [address, setAddress] = useState(props.initial ?? { localPart: "", domain: props.domains[0]?.name ?? "" });
	const [displayName, setDisplayName] = useState("");
	const [mailboxIds, setMailboxIds] = useState<string[]>([]);
	// Only those still listed: someone archived meanwhile drops off the list, and out of what's sent.
	const listed = mailboxIds.filter((id) => props.mailboxes.some((m) => m.id === id));
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
						add.mutate({ ...address, localPart: address.localPart.trim(), displayName: displayName.trim() || undefined, mailboxIds: listed });
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
						<Button type="submit" disabled={add.isPending || listed.length === 0}>
							{add.isPending ? <Spinner data-icon="inline-start" /> : null}
							Add address
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
