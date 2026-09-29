import { MAX_SIGNATURE } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { api, type Identity } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { useAccount } from "../hooks";

export const Route = createFileRoute("/_app/_settings/settings/signatures")({ component: Signatures });

/** One per address you send as, like Fastmail's and Proton's. The composer adds it and swaps it when From changes. */
function Signatures() {
	const { identities } = useAccount();
	// An address routed to two of your mailboxes is one identity here: signatures are per address.
	const addresses = identities.filter((i, index) => identities.findIndex((j) => j.address === i.address) === index);
	return (
		<SettingsPage title="Signatures">
			{addresses.length === 0 ? (
				<p className="text-muted-foreground">None of your addresses can send mail yet.</p>
			) : (
				<FieldGroup className="max-w-xl">
					{addresses.map((i) => (
						<SignatureField key={i.address} identity={i} />
					))}
				</FieldGroup>
			)}
		</SettingsPage>
	);
}

/** Saves when you leave the field. */
function SignatureField({ identity }: { identity: Identity }) {
	const id = useId();
	const qc = useQueryClient();
	const saved = identity.signature ?? "";
	const [text, setText] = useState(saved);
	const save = useMutation({
		mutationFn: (value: string) => api.saveSignature(identity.address, value),
		onSuccess: ({ signature }, value) => {
			// Show it as stored (trimmed, without a pasted "-- "), unless you've typed on since.
			setText((current) => (current === value ? (signature ?? "") : current));
			return qc.invalidateQueries({ queryKey: ["me"] });
		},
	});
	const changed = text.trim() !== saved;
	return (
		<Field>
			<div className="flex items-baseline justify-between gap-3">
				<FieldLabel htmlFor={id}>{identity.address}</FieldLabel>
				<span aria-live="polite" className="text-xs text-muted-foreground">
					{save.isPending ? "Saving…" : save.isSuccess && !changed ? "Saved" : null}
				</span>
			</div>
			<Textarea
				id={id}
				value={text}
				onChange={(e) => setText(e.target.value)}
				onBlur={() => changed && save.mutate(text)}
				maxLength={MAX_SIGNATURE}
				placeholder="No signature"
				aria-invalid={save.isError}
				className="min-h-20"
			/>
			{save.isError ? <FieldError>{save.error.message}</FieldError> : null}
		</Field>
	);
}
