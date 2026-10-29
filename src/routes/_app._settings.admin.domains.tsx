import { type DirectoryDomain, type DirectoryMailbox, type Person, STEP_IDS } from "#shared";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, PlusIcon } from "lucide-react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adminApi, errorMessage } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { ConnectChecklist } from "../components/ConnectChecklist";
import { MailHostLabel } from "../components/MailHostLabel";
import { OnOff } from "../components/OnOff";
import { TokenForm } from "../components/TokenForm";
import { useDomainConnect } from "../connect";
import { directoryQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/admin/domains")({ component: Domains });

/** Unknown addresses at a domain are rejected unless a mailbox catches them. */
const REJECT = "reject";

function Domains() {
	const { domains, mailboxes, people, cloudflareTokenSaved } = useSuspenseQuery(directoryQuery).data;
	const connect = useDomainConnect();
	const [connecting, setConnecting] = useState<{ domain: string; moveMail: boolean } | null>(null);
	/** "Use a different token": ask again even though one is saved. */
	const [replacing, setReplacing] = useState(false);
	const [adding, setAdding] = useState(false);
	const qc = useQueryClient();
	const forget = useMutation({ mutationFn: adminApi.forgetToken, onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }) });

	/** Opens the checklist for a domain and, if there's a token to do it with, starts turning it on. */
	const turnOn = (domain: string, moveMail: boolean) => {
		setConnecting({ domain, moveMail });
		if (cloudflareTokenSaved) connect.run({ domain, moveMail });
	};

	return (
		<SettingsPage
			title="Domains"
			action={
				<Button onClick={() => setAdding(true)}>
					<PlusIcon data-icon="inline-start" />
					Add domain
				</Button>
			}
		>
			{domains.length === 0 ? (
				<p className="text-muted-foreground">No domains yet.</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Domain</TableHead>
							<TableHead className="hidden sm:table-cell">Receiving</TableHead>
							<TableHead className="hidden sm:table-cell">Sending</TableHead>
							<TableHead>Unknown addresses</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{domains.map((d) => (
							<DomainRow key={d.name} domain={d} mailboxes={mailboxes} onTurnOn={() => turnOn(d.name, false)} />
						))}
					</TableBody>
				</Table>
			)}

			{cloudflareTokenSaved ? (
				<p className="flex items-center gap-2 text-muted-foreground">
					Cloudflare token saved.
					<Button variant="link" className="h-auto p-0 font-normal text-foreground underline" onClick={() => forget.mutate()} disabled={forget.isPending}>
						Forget it
					</Button>
				</p>
			) : null}

			<AddDomainDialog
				open={adding}
				onOpenChange={setAdding}
				existing={domains.map((d) => d.name)}
				people={people}
				tokenSaved={cloudflareTokenSaved}
				onAdded={(domain, moveMail) => {
					setAdding(false);
					turnOn(domain, moveMail);
				}}
			/>

			<Dialog
				open={connecting !== null}
				onOpenChange={(open) => {
					if (open) return;
					setConnecting(null);
					setReplacing(false);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Turn on {connecting?.domain}</DialogTitle>
					</DialogHeader>
					{!connecting ? null : !cloudflareTokenSaved || replacing ? (
						<SaveTokenForm
							onSaved={() => {
								setReplacing(false);
								connect.run(connecting);
							}}
						/>
					) : (
						<ConnectBody
							domain={connecting.domain}
							people={people}
							connect={connect}
							onRun={(moveMail) => {
								setConnecting({ ...connecting, moveMail });
								connect.run({ domain: connecting.domain, moveMail });
							}}
							onReplaceToken={() => setReplacing(true)}
							moveMail={connecting.moveMail}
						/>
					)}
				</DialogContent>
			</Dialog>
		</SettingsPage>
	);
}

/** Paste a token; once it's saved (and the directory knows), carry on. */
function SaveTokenForm(props: { onSaved?: () => void }) {
	const qc = useQueryClient();
	const save = useMutation({
		mutationFn: adminApi.saveToken,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["admin"] });
			props.onSaved?.();
		},
	});
	return <TokenForm pending={save.isPending} error={save.error ? errorMessage(save.error) : undefined} submitLabel="Continue" onSubmit={save.mutate} />;
}

function ConnectBody(props: {
	domain: string;
	people: Person[];
	moveMail: boolean;
	connect: ReturnType<typeof useDomainConnect>;
	onRun: (moveMail: boolean) => void;
	onReplaceToken: () => void;
}) {
	const { steps, running, started } = props.connect;
	// Its mail still goes elsewhere: everything else can be on, and moving it is up to the admin.
	const elsewhere = steps.routing !== undefined && "needsMoveMail" in steps.routing && steps.routing.needsMoveMail === true;
	// Waiting on Cloudflare or failed, so checking again could change it. Waiting for the admin to move mail doesn't count.
	const unsettled = STEP_IDS.some((id) => {
		const state = steps[id]?.state;
		return state !== undefined && state !== "done" && !(id === "routing" && elsewhere);
	});
	return (
		<div className="flex flex-col gap-5 text-sm">
			<ConnectChecklist steps={steps} />
			{elsewhere && !running ? <CodesComeHere people={props.people} domain={props.domain} /> : null}
			{running || !started ? null : (
				<DialogFooter className="sm:flex-wrap">
					{elsewhere ? <Button onClick={() => props.onRun(true)}>Move mail to Magnus</Button> : null}
					{!unsettled ? null : (
						<Button variant="outline" onClick={() => props.onRun(props.moveMail)}>
							Check again
						</Button>
					)}
					<Button variant="ghost" onClick={props.onReplaceToken}>
						Use a different token
					</Button>
				</DialogFooter>
			)}
		</div>
	);
}

function DomainRow(props: { domain: DirectoryDomain; mailboxes: DirectoryMailbox[]; onTurnOn: () => void }) {
	const { domain } = props;
	const qc = useQueryClient();
	const [removing, setRemoving] = useState(false);
	const catchAll = useMutation({
		mutationFn: (mailboxId: string | null) => adminApi.setCatchAll(domain.name, mailboxId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["admin"] }),
	});
	const remove = useMutation({
		mutationFn: () => adminApi.removeDomain(domain.name),
		onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["me"] })]),
	});
	// An archived person's mailbox is offered only while it's the one chosen, and refuses mail until they're restored.
	const items = [
		{ value: REJECT, label: "Reject" },
		...props.mailboxes
			.filter((m) => !m.removedWith || m.id === domain.catchAllMailboxId)
			.map((m) => ({ value: m.id, label: m.removedWith ? `Reject while ${m.name} is archived` : `Deliver to ${m.name}` })),
	];

	return (
		<TableRow>
			<TableCell>
				<div className="flex flex-col gap-0.5">
					<span className="font-medium">{domain.name}</span>
					{/* Phones fold the two status columns in here. */}
					<span className="flex flex-col gap-0.5 text-xs sm:hidden">
						<OnOff on={domain.receiving} label="Receiving" />
						<OnOff on={domain.sending} label="Sending" />
					</span>
				</div>
			</TableCell>
			<TableCell className="hidden sm:table-cell">
				<OnOff on={domain.receiving} />
			</TableCell>
			<TableCell className="hidden sm:table-cell">
				<OnOff on={domain.sending} />
			</TableCell>
			<TableCell>
				<Select items={items} value={domain.catchAllMailboxId ?? REJECT} onValueChange={(value) => catchAll.mutate(value === REJECT ? null : String(value))}>
					<SelectTrigger size="sm" aria-label={`Unknown addresses at ${domain.name}`} className="min-w-32 sm:min-w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</TableCell>
			<TableCell>
				<div className="flex items-center justify-end gap-1">
					{domain.receiving && domain.sending ? null : (
						<Button variant="outline" size="sm" onClick={props.onTurnOn}>
							Turn on
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${domain.name}`} />}>
							<EllipsisIcon />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem onClick={props.onTurnOn}>Check with Cloudflare</DropdownMenuItem>
							<DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}>
								Remove…
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				<AlertDialog open={removing} onOpenChange={setRemoving}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Remove {domain.name}?</AlertDialogTitle>
							<AlertDialogDescription>
								Its addresses go with it, and new mail to them bounces. Mail already received stays, and Cloudflare keeps its settings.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{remove.error ? <FieldError>{errorMessage(remove.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
								Remove domain
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}

function AddDomainDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	existing: string[];
	people: Person[];
	tokenSaved: boolean;
	onAdded: (domain: string, moveMail: boolean) => void;
}) {
	const zones = useQuery({
		queryKey: ["admin", "zones"],
		queryFn: adminApi.zones,
		enabled: props.open && props.tokenSaved,
		select: (data) => data.zones.filter((z) => !props.existing.includes(z.name)),
	});
	const [picked, setPicked] = useState("");
	const [moveMail, setMoveMail] = useState(false);
	// The first domain until another is picked.
	const zone = zones.data?.find((z) => z.id === picked) ?? zones.data?.[0];
	const elsewhere = zone?.mail.kind === "other" ? zone.mail.provider : null;
	// Mail keeps going to the other provider while the admin sets the domain up, and moves from the domain's row.
	const later = Boolean(elsewhere) && !moveMail;
	const qc = useQueryClient();
	const add = useMutation({
		mutationFn: adminApi.addDomain,
		onSuccess: async ({ name }) => {
			await qc.invalidateQueries({ queryKey: ["admin"] });
			props.onAdded(name, moveMail);
		},
	});

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a domain</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-4 text-sm">
					{!props.tokenSaved ? (
						<SaveTokenForm />
					) : zones.isPending ? (
						<Spinner className="text-muted-foreground" />
					) : zones.isError ? (
						<FieldError>{errorMessage(zones.error)}</FieldError>
					) : zones.data.length === 0 ? (
						<p className="text-muted-foreground">Every active domain in this Cloudflare account is already here.</p>
					) : (
						<>
							<RadioGroup value={zone?.id ?? ""} onValueChange={(value) => setPicked(String(value))} aria-label="Domain">
								{zones.data.map((z) => (
									<FieldLabel key={z.id}>
										<Field orientation="horizontal">
											<FieldContent>
												<FieldTitle>{z.name}</FieldTitle>
												<MailHostLabel host={z.mail} />
											</FieldContent>
											<RadioGroupItem value={z.id} />
										</Field>
									</FieldLabel>
								))}
							</RadioGroup>
							{elsewhere && zone ? (
								<RadioGroup value={moveMail ? "now" : "later"} onValueChange={(value) => setMoveMail(value === "now")} aria-label={`When ${zone.name}'s mail moves`}>
									<Field orientation="horizontal">
										<RadioGroupItem id="move-later" value="later" />
										<FieldContent>
											<FieldLabel htmlFor="move-later" className="font-normal">
												Keep mail at {elsewhere} for now
											</FieldLabel>
											<FieldDescription>Add its addresses and import old mail first, then move it from this page.</FieldDescription>
										</FieldContent>
									</Field>
									<Field orientation="horizontal">
										<RadioGroupItem id="move-now" value="now" />
										<FieldContent>
											<FieldLabel htmlFor="move-now" className="font-normal">
												Move mail to Magnus now
											</FieldLabel>
											<FieldDescription>It stops arriving at {elsewhere}.</FieldDescription>
										</FieldContent>
									</Field>
								</RadioGroup>
							) : null}
							{zone && !later ? <CodesComeHere people={props.people} domain={zone.name} /> : null}
							{add.error ? <FieldError>{errorMessage(add.error)}</FieldError> : null}
						</>
					)}
				</div>
				{props.tokenSaved && zones.data?.length ? (
					<DialogFooter>
						<Button onClick={() => zone && add.mutate(zone.id)} disabled={!zone || add.isPending}>
							{add.isPending ? <Spinner data-icon="inline-start" /> : null}
							{later ? "Add" : "Add and turn on"}
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

/** Their sign-in codes would start arriving in Magnus, where they can't read them while signed out. */
function CodesComeHere(props: { people: Person[]; domain: string }) {
	const names = props.people.filter((p) => p.email.endsWith(`@${props.domain}`)).map((p) => p.name);
	if (names.length === 0) return null;
	return (
		<FieldDescription className="text-pretty text-amber-700 dark:text-amber-400">
			{listNames(names)} {names.length === 1 ? "signs" : "sign"} in with codes sent to {props.domain}. Once its mail comes here, they'll need a passkey to
			sign back in.
		</FieldDescription>
	);
}

/** "Ann", "Ann and Bo", "Ann, Bo, and Cy". */
const NAMES = new Intl.ListFormat("en", { type: "conjunction" });
const listNames = (names: string[]) => NAMES.format(names);
