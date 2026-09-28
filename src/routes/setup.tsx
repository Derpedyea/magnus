import type { Zone } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { setupApi } from "../api";
import { ConnectChecklist } from "../components/ConnectChecklist";
import { MailHostLabel } from "../components/MailHostLabel";
import { TokenForm } from "../components/TokenForm";
import { useDomainConnect } from "../connect";
import { configQuery } from "../queries";

/** First run: connect Cloudflare, pick a domain, become the first admin, and turn the domain on. */
export const Route = createFileRoute("/setup")({
	beforeLoad: async ({ context }) => {
		if (!(await context.queryClient.ensureQueryData(configQuery)).setupRequired) throw redirect({ to: "/" });
	},
	component: Setup,
});

function Setup() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const [token, setToken] = useState("");
	// Reads Cloudflare and caches nothing.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const verify = useMutation({ mutationFn: setupApi.verify });
	const [claimed, setClaimed] = useState<Claimed | null>(null);
	const connect = useDomainConnect();
	const account = verify.data;

	// Setup is over. The app's guards read config from the cache, so fetch it fresh before going in.
	const openInbox = async () => {
		await qc.fetchQuery({ ...configQuery, staleTime: 0 });
		await navigate({ to: "/" });
	};

	return (
		<main className="flex min-h-full justify-center px-6 py-16 text-sm">
			<div className="flex w-full max-w-md flex-col gap-10">
				<header className="flex items-center gap-3">
					<img src="/favicon.svg" alt="" className="size-8" />
					<h1 className="font-heading text-lg font-semibold">Set up Magnus</h1>
				</header>

				<Section index={1} title="Connect Cloudflare" summary={account?.accountName}>
					{account ? null : (
						<TokenForm
							pending={verify.isPending}
							error={verify.error?.message}
							onSubmit={(value) => {
								setToken(value);
								verify.mutate(value);
							}}
						/>
					)}
				</Section>

				{account ? (
					<ClaimForm
						token={token}
						zones={account.zones}
						claimed={claimed}
						onClaimed={(target) => {
							setClaimed(target);
							connect.run({ token, domain: target.domain, moveMail: target.moveMail });
						}}
					/>
				) : (
					<>
						<Section index={2} title="Your domain" />
						<Section index={3} title="You" />
					</>
				)}

				<Section index={4} title={claimed ? `Turn on ${claimed.domain}` : "Turn on your domain"} done={connect.done}>
					{claimed ? (
						<div className="flex flex-col gap-5">
							<ConnectChecklist steps={connect.steps} />
							{connect.running ? null : (
								<div className="flex gap-2">
									<Button onClick={() => void openInbox()} variant={connect.done ? "default" : "outline"}>
										Open inbox
									</Button>
									{connect.done ? null : (
										<Button variant="ghost" onClick={() => connect.run({ token, domain: claimed.domain, moveMail: claimed.moveMail })}>
											Check again
										</Button>
									)}
								</div>
							)}
						</div>
					) : null}
				</Section>
			</div>
		</main>
	);
}

/** One numbered part of setup: its content while it's current, a check and a one-line summary once it's done. */
function Section(props: { index: number; title: string; summary?: string | undefined; done?: boolean; children?: React.ReactNode }) {
	const done = props.done ?? Boolean(props.summary);
	return (
		<section className="flex flex-col gap-4">
			<h2 className="flex items-center gap-3 font-medium">
				<span
					className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs ${
						done ? "bg-primary text-primary-foreground" : props.children ? "border border-foreground" : "border text-muted-foreground"
					}`}
				>
					{done ? <CheckIcon className="size-3.5" /> : props.index}
				</span>
				<span className={props.children || done ? undefined : "text-muted-foreground"}>{props.title}</span>
				{done ? <span className="ml-auto truncate text-muted-foreground">{props.summary}</span> : null}
			</h2>
			{props.children ? <div className="pl-9">{props.children}</div> : null}
		</section>
	);
}

interface Claimed {
	domain: string;
	address: string;
	/** The domain got mail elsewhere and its owner agreed to move it. */
	moveMail: boolean;
}

function ClaimForm(props: { token: string; zones: Zone[]; claimed: Claimed | null; onClaimed: (claimed: Claimed) => void }) {
	// Domains without mail come first: nothing to move, nothing to break.
	const zones = props.zones.toSorted((a, b) => Number(a.mail.kind !== "none") - Number(b.mail.kind !== "none"));
	const [zoneId, setZoneId] = useState(zones[0]?.id ?? "");
	const [name, setName] = useState("");
	const [localPart, setLocalPart] = useState("");
	const [email, setEmail] = useState("");
	const [moveMail, setMoveMail] = useState(false);
	const zone = zones.find((z) => z.id === zoneId);
	const elsewhere = zone?.mail.kind === "other" ? zone.mail.provider : null;
	// Creates the account and sets the session cookie; nothing cached describes either yet.
	// react-doctor-disable-next-line react-doctor/query-mutation-missing-invalidation
	const complete = useMutation({
		mutationFn: setupApi.complete,
		onSuccess: (_, input) => zone && props.onClaimed({ domain: zone.name, address: `${input.localPart}@${zone.name}`, moveMail }),
	});

	if (props.claimed) {
		return (
			<>
				<Section index={2} title="Your domain" summary={props.claimed.domain} />
				<Section index={3} title="You" summary={props.claimed.address} />
			</>
		);
	}

	if (zones.length === 0) {
		return (
			<Section index={2} title="Your domain">
				<p className="text-muted-foreground">
					This Cloudflare account has no active domains.{" "}
					<a className="text-foreground underline underline-offset-4" href="https://dash.cloudflare.com/?to=/:account/add-site" target="_blank" rel="noreferrer">
						Add one
					</a>
					, then connect again.
				</p>
			</Section>
		);
	}

	return (
		<form
			className="flex flex-col gap-10"
			onSubmit={(e) => {
				e.preventDefault();
				complete.mutate({ token: props.token, zoneId, name: name.trim(), localPart: localPart.trim(), email: email.trim() });
			}}
		>
			<Section index={2} title="Your domain">
				<FieldGroup className="gap-3">
					<RadioGroup value={zoneId} onValueChange={(value) => setZoneId(String(value))} aria-label="Domain">
						{zones.map((z) => (
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
							<Checkbox id="move-mail" checked={moveMail} onCheckedChange={setMoveMail} required />
							<FieldLabel htmlFor="move-mail" className="font-normal">
								Move {zone.name}'s mail to Magnus. It stops arriving at {elsewhere}.
							</FieldLabel>
						</Field>
					) : null}
				</FieldGroup>
			</Section>

			<Section index={3} title="You">
				<FieldGroup className="gap-4">
					<Field>
						<FieldLabel htmlFor="name">Name</FieldLabel>
						<Input id="name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
					</Field>
					<Field>
						<FieldLabel htmlFor="address">Your address</FieldLabel>
						<InputGroup>
							<InputGroupInput
								id="address"
								required
								pattern="[A-Za-z0-9]([A-Za-z0-9._\-]*[A-Za-z0-9])?"
								autoCapitalize="none"
								spellCheck={false}
								value={localPart}
								onChange={(e) => setLocalPart(e.target.value)}
								placeholder="you"
							/>
							<InputGroupAddon align="inline-end">@{zone?.name}</InputGroupAddon>
						</InputGroup>
					</Field>
					<Field>
						<FieldLabel htmlFor="email">Sign-in email</FieldLabel>
						<Input id="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@gmail.com" />
						<FieldDescription>Sign-in codes go here, so use an address outside {zone?.name}.</FieldDescription>
					</Field>
					{complete.error ? <FieldError>{complete.error.message}</FieldError> : null}
					<Button type="submit" className="self-start" disabled={complete.isPending || (Boolean(elsewhere) && !moveMail)}>
						{complete.isPending ? <Spinner data-icon="inline-start" /> : null}
						Create my account
					</Button>
				</FieldGroup>
			</Section>
		</form>
	);
}
