import type { Me } from "#shared";
import { useId } from "react";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

/** Which mailbox mail goes into, for someone with more than one. Each with its addresses, as the sidebar groups them. */
export function MailboxChoice(props: { mailboxes: Me["mailboxes"]; value: string; onChange: (id: string) => void; label?: string }) {
	const labelId = useId();
	if (props.mailboxes.length < 2) return null;
	return (
		<div className="flex flex-col gap-2">
			<p id={labelId} className="font-medium">
				{props.label ?? "Import into"}
			</p>
			{/* A mailbox's name alone only says whose it is. */}
			<RadioGroup value={props.value} onValueChange={(value) => props.onChange(String(value))} aria-labelledby={labelId}>
				{props.mailboxes.map((m) => (
					<FieldLabel key={m.id}>
						<Field orientation="horizontal">
							<FieldContent className="min-w-0">
								<FieldTitle>{m.name}</FieldTitle>
								<FieldDescription className="break-words">
									{m.addresses.length ? m.addresses.map((a) => a.address).join(" · ") : "No addresses"}
								</FieldDescription>
							</FieldContent>
							<RadioGroupItem value={m.id} />
						</Field>
					</FieldLabel>
				))}
			</RadioGroup>
		</div>
	);
}
