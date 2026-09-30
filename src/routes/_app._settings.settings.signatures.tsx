import { MAX_SIGNATURE } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Field, FieldError, FieldGroup, FieldTitle } from "@/components/ui/field";
import { api, type Identity } from "../api";
import { MarkdownEditor } from "../components/MarkdownEditor";
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
	// Counted in markdown, as it's stored.
	const tooLong = text.length > MAX_SIGNATURE;
	return (
		<Field>
			<div className="flex items-baseline justify-between gap-3">
				<FieldTitle id={id}>{identity.address}</FieldTitle>
				<span aria-live="polite" className="text-xs text-muted-foreground">
					{save.isPending ? "Saving…" : save.isSuccess && !changed ? "Saved" : null}
				</span>
			</div>
			<MarkdownEditor
				value={text}
				onChange={setText}
				onBlur={() => changed && !tooLong && save.mutate(text)}
				placeholder="No signature"
				aria-labelledby={id}
				aria-invalid={tooLong || save.isError}
				// Looks like the other settings fields (ui/textarea.tsx).
				className="min-h-20 rounded-lg border border-input px-2.5 py-2 text-base transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30"
			/>
			{tooLong ? (
				<FieldError>Signatures can be up to {MAX_SIGNATURE.toLocaleString()} characters, formatting included.</FieldError>
			) : save.isError ? (
				<FieldError>{save.error.message}</FieldError>
			) : null}
		</Field>
	);
}
