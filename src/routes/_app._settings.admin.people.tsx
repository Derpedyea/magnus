import { type DirectoryDomain, type Person } from "#shared";
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

// Shared by both tables, so the archived line up under the rest.
const PERSON_COLUMN = "sm:w-1/3";
const ADDRESSES_COLUMN = "hidden sm:table-cell sm:w-2/5";

function People() {
	const { people, mailboxes, addresses, domains } = useSuspenseQuery(directoryQuery).data;
	const { user } = useAccount();
	const [adding, setAdding] = useState(false);
	const archived = people.filter((p): p is Archived => p.archived !== null);

	/** Every address that delivers to one of this person's mailboxes, or, once they're archived, to one that hid with them. */
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
						.filter((p) => p.archived === null)
						.map((p) => (
							<PersonRow key={p.id} person={p} addresses={addressesOf(p.id)} self={p.id === user.id} />
						))}
				</TableBody>
			</Table>
			{archived.length > 0 ? (
				<section aria-labelledby="archived-people" className="flex flex-col gap-2">
					<h2 id="archived-people" className="font-medium">
						Archived
					</h2>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className={PERSON_COLUMN}>Person</TableHead>
								<TableHead className={ADDRESSES_COLUMN}>Addresses</TableHead>
								<TableHead>Archived</TableHead>
								<TableHead className="w-0" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{archived.map((p) => (
								<ArchivedRow key={p.id} person={p} addresses={addressesOf(p.id)} />
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
	const [archiving, setArchiving] = useState(false);
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
	const archive = useMutation({ mutationFn: () => adminApi.removePerson(person.id), onSuccess: refresh });
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
					{failed ? (
						<span role="alert" className="whitespace-normal text-destructive">
							{errorMessage(failed)}
						</span>
					) : null}
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
						{/* You can't lock yourself out: someone else has to change your role, suspend, or archive you. */}
						<DropdownMenuItem disabled={props.self} onClick={() => setRole.mutate()}>
							{person.isAdmin ? "Make member" : "Make admin"}
						</DropdownMenuItem>
						<DropdownMenuItem disabled={props.self} onClick={() => suspend.mutate()}>
							{person.banned ? "Restore access" : "Suspend"}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem variant="destructive" disabled={props.self} onClick={() => setArchiving(true)}>
							Archive…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<AlertDialog open={archiving} onOpenChange={setArchiving}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Archive {person.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								They're signed out, and mail to addresses only they receive is refused. Their mail is kept until you restore them or delete
								them for good. To keep their mail coming in, suspend them instead.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{archive.error ? <FieldError>{errorMessage(archive.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => archive.mutate()} disabled={archive.isPending}>
								Archive {person.name}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

type Archived = Person & { archived: NonNullable<Person["archived"]> };

/** Someone archived: when, the way back, and the way to delete them for good. */
function ArchivedRow(props: { person: Archived; addresses: string[] }) {
	const { person } = props;
	const qc = useQueryClient();
	// The archive the admin is asked about, kept as the dialog opens: if someone restores and archives them again
	// meanwhile, deleting answers that they've changed rather than deleting the newer archive.
	const [deleting, setDeleting] = useState<string | null>(null);
	const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
	// Each clears the other's error as it starts, so the row shows what the last one said.
	const restore = useMutation({
		mutationFn: () => adminApi.restorePerson(person.id),
		onMutate: () => {
			remove.reset();
		},
		onSuccess: refresh,
	});
	// Refetched however it ends. A failure closes the dialog, so opening it again asks about the archive that's there
	// now (after a 409, a newer one), and shows on the row.
	const remove = useMutation({
		mutationFn: (archiveId: string) => adminApi.deletePerson(person.id, archiveId),
		onMutate: () => {
			restore.reset();
		},
		onError: () => setDeleting(null),
		onSettled: refresh,
	});
	const failed = restore.error ?? remove.error;

	return (
		<TableRow>
			<TableCell>
				<div className="flex flex-col">
					<span className="font-medium">{person.name}</span>
					<span className="text-muted-foreground">{person.email}</span>
					{failed ? (
						<span role="alert" className="whitespace-normal text-destructive">
							{errorMessage(failed)}
						</span>
					) : null}
				</div>
			</TableCell>
			<AddressesCell addresses={props.addresses} />
			<TableCell>{new Date(person.archived.at).toLocaleDateString([], { dateStyle: "medium" })}</TableCell>
			<TableCell>
				<div className="flex items-center gap-1">
					<Button variant="outline" size="sm" onClick={() => restore.mutate()} disabled={restore.isPending}>
						{restore.isPending ? <Spinner data-icon="inline-start" /> : null}
						Restore
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${person.name}`} />}>
							<EllipsisIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-auto">
							<DropdownMenuItem variant="destructive" onClick={() => setDeleting(person.archived.id)}>
								Delete for good…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<AlertDialog open={deleting !== null} onOpenChange={(open) => setDeleting(open ? deleting : null)}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete {person.name} for good?</AlertDialogTitle>
							<AlertDialogDescription>
								Their account, their mailbox and all its mail, and addresses only they receive are deleted. This can't be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => {
									if (deleting !== null) remove.mutate(deleting);
								}} disabled={remove.isPending}>
								Delete for good
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
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
