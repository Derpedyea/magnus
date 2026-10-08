import type { MailboxMembership, MailSettings } from "#shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@/components/ui/field";
import { api } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { useAccount } from "../hooks";
import { mailSettingsQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/settings/spam")({ component: Spam });

/** How each of your mailboxes treats mail from people it doesn't know yet. */
function Spam() {
	const { mailboxes } = useAccount();
	return (
		<SettingsPage title="Spam">
			<div className="flex max-w-xl flex-col gap-8">
				{mailboxes.map((m) => (
					<MailboxSettings key={m.id} mailbox={m} named={mailboxes.length > 1} />
				))}
			</div>
		</SettingsPage>
	);
}

/** Each setting saves as it's ticked, on its own, so two quick changes can't undo each other. */
function MailboxSettings({ mailbox, named }: { mailbox: MailboxMembership; named: boolean }) {
	const qc = useQueryClient();
	const query = mailSettingsQuery(mailbox.id);
	const settings = useQuery(query);
	const save = useMutation({
		mutationFn: (change: Partial<MailSettings>) => api.updateSettings(mailbox.id, change),
		onSuccess: (saved) => qc.setQueryData(query.queryKey, saved),
	});
	const shown = { ...settings.data, ...(save.isPending ? save.variables : {}) };
	const field = (key: keyof MailSettings, label: string, description: string) => {
		const id = `${key}-${mailbox.id}`;
		return (
			<Field orientation="horizontal">
				<Checkbox id={id} checked={shown[key] ?? false} disabled={!settings.isSuccess || save.isPending} onCheckedChange={(on) => save.mutate({ [key]: on })} />
				<FieldContent>
					<FieldLabel htmlFor={id}>{label}</FieldLabel>
					<FieldDescription>{description}</FieldDescription>
				</FieldContent>
			</Field>
		);
	};
	return (
		<FieldSet>
			{named ? (
				<FieldLegend>
					{mailbox.name} <span className="font-normal text-muted-foreground">{mailbox.addresses.map((a) => a.address).join(", ")}</span>
				</FieldLegend>
			) : null}
			<FieldGroup>
				{field(
					"screener",
					"Screen first-time senders",
					"Mail from people new to you waits in the Screener until you let them in. Receipts, sign-in codes, and other account mail still arrive.",
				)}
				{field(
					"outreachToSpam",
					"Send cold outreach to Spam",
					"Sales, recruiting, and partnership pitches from strangers. Unticked, they arrive like other mail from someone new.",
				)}
				{settings.isError ? <FieldError>{settings.error.message}</FieldError> : save.isError ? <FieldError>{save.error.message}</FieldError> : null}
			</FieldGroup>
		</FieldSet>
	);
}
