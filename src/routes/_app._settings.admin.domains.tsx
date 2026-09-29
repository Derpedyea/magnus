import type { DirectoryDomain, DirectoryMailbox } from "#shared";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldContent, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
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
	const { domains, mailboxes, cloudflareTokenSaved } = useSuspenseQuery(directoryQuery).data;
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
	moveMail: boolean;
	connect: ReturnType<typeof useDomainConnect>;
	onRun: (moveMail: boolean) => void;
	onReplaceToken: () => void;
}) {
	const { steps, running, done, started } = props.connect;
	const blocked = steps.routing?.state === "failed" && "needsMoveMail" in steps.routing && steps.routing.needsMoveMail;
	return (
		<div className="flex flex-col gap-5 text-sm">
			<ConnectChecklist steps={steps} />
			{running || !started ? null : (
				<DialogFooter>
					{blocked ? (
						<Button onClick={() => props.onRun(true)}>Move mail to Magnus and continue</Button>
					) : done ? null : (
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
	const items = [{ value: REJECT, label: "Reject" }, ...props.mailboxes.map((m) => ({ value: m.id, label: `Deliver to ${m.name}` }))];

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
								<Field orientation="horizontal">
									<Checkbox id="move-mail" checked={moveMail} onCheckedChange={setMoveMail} />
									<FieldLabel htmlFor="move-mail" className="font-normal">
										Move {zone.name}'s mail to Magnus. It stops arriving at {elsewhere}.
									</FieldLabel>
								</Field>
							) : null}
							{add.error ? <FieldError>{errorMessage(add.error)}</FieldError> : null}
						</>
					)}
				</div>
				{props.tokenSaved && zones.data?.length ? (
					<DialogFooter>
						<Button onClick={() => zone && add.mutate(zone.id)} disabled={!zone || add.isPending || (Boolean(elsewhere) && !moveMail)}>
							{add.isPending ? <Spinner data-icon="inline-start" /> : null}
							Add and turn on
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
