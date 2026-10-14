import { type DirectoryDomain, type Person, REMOVAL_DAYS } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, UserPlusIcon } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApi, authClient, errorMessage } from "../api";
import { AddressInput } from "../components/AddressInput";
import { SettingsPage } from "../components/SettingsPage";
import { useAccount } from "../hooks";
import { directoryQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/admin/people")({ component: People });

// Shared by both tables, so the removed line up under the rest.
const PERSON_COLUMN = "sm:w-1/3";
const ADDRESSES_COLUMN = "hidden sm:table-cell sm:w-2/5";

function People() {
	const { people, mailboxes, addresses, domains } = useSuspenseQuery(directoryQuery).data;
	const { user } = useAccount();
	const [adding, setAdding] = useState(false);
	const removed = people.filter((p): p is Removed => p.deletesAt !== null);

	/** Every address that delivers to one of this person's mailboxes, or, once they're removed, to one their removal hid. */
	const addressesOf = (personId: string) => {
		const theirs = new Set(mailboxes.filter((m) => m.memberIds.includes(personId) || m.removedWith === personId).map((m) => m.id));
		return addresses.filter((a) => a.mailboxIds.some((id) => theirs.has(id))).map((a) => a.address);
	};

	return (
		<SettingsPage
			title="People"
			action={
				<Button onClick={() => setAdding(true)}>
					<UserPlusIcon data-icon="inline-start" />
					Add person
				</Button>
			}
		>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className={PERSON_COLUMN}>Person</TableHead>
						<TableHead className={ADDRESSES_COLUMN}>Addresses</TableHead>
						<TableHead>Role</TableHead>
						<TableHead className="w-0" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{people
						.filter((p) => p.deletesAt === null)
						.map((p) => (
							<PersonRow key={p.id} person={p} addresses={addressesOf(p.id)} self={p.id === user.id} />
						))}
				</TableBody>
			</Table>
			{removed.length > 0 ? (
				<section aria-labelledby="removed-people" className="flex flex-col gap-2">
					<h2 id="removed-people" className="font-medium">
						Removed
					</h2>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={PERSON_COLUMN}>Person</TableHead>
								<TableHead className={ADDRESSES_COLUMN}>Addresses</TableHead>
								<TableHead>Deleted for good</TableHead>
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{removed.map((p) => (
								<RemovedRow key={p.id} person={p} addresses={addressesOf(p.id)} />
							))}
						</TableBody>
					</Table>
				</section>
			) : null}
			<AddPersonDialog open={adding} onOpenChange={setAdding} domains={domains} />
		</SettingsPage>
	);
}

function PersonRow(props: { person: Person; addresses: string[]; self: boolean }) {
	const { person } = props;
	const qc = useQueryClient();
	const [removing, setRemoving] = useState(false);
	const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
	// Role and suspension are Better Auth's admin plugin, straight from the browser.
	const setRole = useMutation({
		mutationFn: () => authClient.admin.setRole({ userId: person.id, role: person.isAdmin ? "user" : "admin" }),
		onSuccess: refresh,
	});
	const suspend = useMutation({
		mutationFn: () => (person.banned ? authClient.admin.unbanUser({ userId: person.id }) : authClient.admin.banUser({ userId: person.id })),
		onSuccess: refresh,
	});
	const remove = useMutation({ mutationFn: () => adminApi.removePerson(person.id), onSuccess: refresh });
	const failed = setRole.error ?? suspend.error;

	return (
		<TableRow>
			<TableCell>
				<div className="flex flex-col">
					<span className="flex items-center gap-2 font-medium">
						{person.name}
						{person.banned ? <Badge variant="outline">Suspended</Badge> : null}
					</span>
					<span className="text-muted-foreground">{person.email}</span>
					{failed ? <span className="text-destructive">{errorMessage(failed)}</span> : null}
				</div>
			</TableCell>
			<AddressesCell addresses={props.addresses} />
			<TableCell>{person.isAdmin ? "Admin" : "Member"}</TableCell>
			<TableCell>
				<DropdownMenu>
					<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${person.name}`} />}>
						<EllipsisIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{/* You can't lock yourself out: someone else has to change your role, suspend, or remove you. */}
						<DropdownMenuItem disabled={props.self} onClick={() => setRole.mutate()}>
							{person.isAdmin ? "Make member" : "Make admin"}
						</DropdownMenuItem>
						<DropdownMenuItem disabled={props.self} onClick={() => suspend.mutate()}>
							{person.banned ? "Restore access" : "Suspend"}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" disabled={props.self} onClick={() => setRemoving(true)}>
							Remove…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<AlertDialog open={removing} onOpenChange={setRemoving}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove {person.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								They're signed out, and mail to addresses only they receive is refused. Their mailbox and mail are deleted for good in {REMOVAL_DAYS}{" "}
								days, and until then you can restore them here. To keep their mail coming in, suspend them instead.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{remove.error ? <FieldError>{errorMessage(remove.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
								Remove {person.name}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

type Removed = Person & { deletesAt: number };

/** Someone removed but not yet deleted: when they will be, and the way back. */
function RemovedRow(props: { person: Removed; addresses: string[] }) {
	const { person } = props;
	const qc = useQueryClient();
	const restore = useMutation({
		mutationFn: () => adminApi.restorePerson(person.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
	});

	return (
		<TableRow>
			<TableCell>
				<div className="flex flex-col">
					<span className="font-medium">{person.name}</span>
					<span className="text-muted-foreground">{person.email}</span>
					{restore.error ? <span className="text-destructive">{errorMessage(restore.error)}</span> : null}
				</div>
			</TableCell>
			<AddressesCell addresses={props.addresses} />
			<TableCell>{new Date(person.deletesAt).toLocaleDateString([], { dateStyle: "medium" })}</TableCell>
			<TableCell>
				<Button variant="outline" size="sm" onClick={() => restore.mutate()} disabled={restore.isPending}>
					{restore.isPending ? <Spinner data-icon="inline-start" /> : null}
					Restore
				</Button>
			</TableCell>
		</TableRow>
	);
}

function AddressesCell(props: { addresses: string[] }) {
	return (
		<TableCell className="hidden sm:table-cell">
			{props.addresses.length ? (
				<div className="flex flex-col">
					{props.addresses.map((a) => (
						<span key={a}>{a}</span>
					))}
				</div>
			) : (
				<span className="text-muted-foreground">None</span>
			)}
		</TableCell>
	);
}

function AddPersonDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; domains: DirectoryDomain[] }) {
	const qc = useQueryClient();
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [address, setAddress] = useState({ localPart: "", domain: props.domains[0]?.name ?? "" });
	const [isAdmin, setIsAdmin] = useState(false);
	const add = useMutation({
		mutationFn: adminApi.addPerson,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["admin"] });
			props.onOpenChange(false);
			setName("");
			setEmail("");
			setAddress((prev) => ({ ...prev, localPart: "" }));
			setIsAdmin(false);
		},
	});

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-6"
					onSubmit={(e) => {
						e.preventDefault();
						add.mutate({ name: name.trim(), email: email.trim(), isAdmin, address: address.localPart.trim() ? address : undefined });
					}}
				>
					<DialogHeader>
						<DialogTitle>Add a person</DialogTitle>
					</DialogHeader>
					<FieldGroup className="gap-4">
						<Field>
							<FieldLabel htmlFor="person-name">Name</FieldLabel>
							<Input id="person-name" required value={name} onChange={(e) => setName(e.target.value)} />
						</Field>
						<Field>
							<FieldLabel htmlFor="person-address">Address</FieldLabel>
							<AddressInput id="person-address" value={address} onChange={setAddress} domains={props.domains} />
						</Field>
						<Field>
							<FieldLabel htmlFor="person-email">Sign-in email</FieldLabel>
							<Input id="person-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
							<FieldDescription>They sign in with a code sent here, so it should be an address they can already read.</FieldDescription>
						</Field>
						<Field orientation="horizontal">
							<Checkbox id="person-admin" checked={isAdmin} onCheckedChange={setIsAdmin} />
							<FieldLabel htmlFor="person-admin" className="font-normal">
								Admin: can manage domains, people, and addresses
							</FieldLabel>
						</Field>
						{add.error ? <FieldError>{errorMessage(add.error)}</FieldError> : null}
					</FieldGroup>
					<DialogFooter>
						<Button type="submit" disabled={add.isPending}>
							{add.isPending ? <Spinner data-icon="inline-start" /> : null}
							Add person
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
