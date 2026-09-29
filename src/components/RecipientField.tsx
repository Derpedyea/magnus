import { type Address, isValidAddress, matchContacts } from "#shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxItem, ComboboxList, useComboboxAnchor } from "@/components/ui/combobox";
import { parseAddressList } from "../api";
import { contactsQuery } from "../queries";

const SUGGESTIONS = 6;

/**
 * To, Cc, or Bcc as chips, suggesting people you've written to or heard from. Enter or Tab takes the highlighted
 * suggestion; a comma, a paste, or leaving the field turns what's typed into chips.
 */
export function RecipientField(props: {
	label: string;
	value: Address[];
	onChange: (value: Address[]) => void;
	onBlur: () => void;
	/** Lowercase addresses in any recipient field, which aren't suggested again. */
	taken: ReadonlySet<string>;
	invalid: boolean;
	autoFocus?: boolean;
	/** Trailing controls, like Cc/Bcc. */
	children?: ReactNode;
}) {
	const { value, onChange } = props;
	const id = useId();
	const anchor = useComboboxAnchor();
	const contacts = useQuery(contactsQuery).data ?? [];
	const [typed, setTyped] = useState("");
	const [open, setOpen] = useState(false);
	const highlighted = useRef<Address | undefined>(undefined);
	const suggestions = matchContacts(contacts, typed, props.taken, SUGGESTIONS);
	const showing = open && suggestions.length > 0;

	/** Adds the ones not in the field yet, and clears what's typed. */
	const add = (list: Address[]) => {
		const have = new Set(value.map((a) => a.address.toLowerCase()));
		const fresh: Address[] = [];
		for (const a of list) {
			const key = a.address.toLowerCase();
			if (have.has(key)) continue;
			have.add(key);
			fresh.push(a);
		}
		if (fresh.length > 0) onChange([...value, ...fresh]);
		setTyped("");
	};

	return (
		<Combobox
			multiple
			items={suggestions}
			filter={null}
			value={value}
			onValueChange={(next, details) => {
				// Escape would clear every chip; here it only closes the suggestions.
				if (details.reason !== "escape-key") onChange(next);
			}}
			inputValue={typed}
			onInputValueChange={setTyped}
			open={showing}
			onOpenChange={setOpen}
			autoHighlight
			onItemHighlighted={(item) => {
				highlighted.current = item;
			}}
			itemToStringLabel={(a: Address) => a.name ?? a.address}
			isItemEqualToValue={(a: Address, b: Address) => a.address.toLowerCase() === b.address.toLowerCase()}
		>
			<div className="flex items-start border-b pr-2 focus-within:border-ring">
				<ComboboxChips
					ref={anchor}
					className="min-h-9 flex-1 rounded-none border-0 bg-transparent py-1 pr-0 pl-3 focus-within:ring-0 has-aria-invalid:ring-0 has-data-[slot=combobox-chip]:pl-3 dark:bg-transparent"
				>
					<label htmlFor={id} className="w-9 shrink-0 text-muted-foreground">
						{props.label}
					</label>
					{value.map((a) => (
						<ComboboxChip
							key={a.address}
							title={a.name ? a.address : undefined}
							className={cn("h-6 text-sm font-normal", !isValidAddress(a.address) && "bg-destructive/10 text-destructive")}
						>
							{a.name || a.address}
						</ComboboxChip>
					))}
					<ComboboxChipsInput
						id={id}
						aria-invalid={props.invalid}
						autoFocus={props.autoFocus}
						autoComplete="off"
						spellCheck={false}
						className="h-7 bg-transparent"
						onKeyDown={(e) => {
							const pick = showing ? highlighted.current : undefined;
							if ((e.key === "," || e.key === ";") && typed.trim()) {
								e.preventDefault();
								add(pick && !isValidAddress(typed) ? [pick] : parseAddressList(typed));
							} else if (e.key === "Tab" && pick && !e.shiftKey) {
								e.preventDefault();
								add([pick]);
							} else if (e.key === "Enter" && !pick) {
								// Enter in a recipient field never sends.
								e.preventDefault();
								add(parseAddressList(typed));
							}
						}}
						onPaste={(e) => {
							const pasted = e.clipboardData.getData("text");
							if (!/[,;\n]/.test(pasted)) return;
							e.preventDefault();
							add(parseAddressList(typed + pasted));
						}}
						onBlur={() => {
							add(parseAddressList(typed));
							props.onBlur();
						}}
					/>
				</ComboboxChips>
				{props.children}
			</div>
			<ComboboxContent anchor={anchor}>
				<ComboboxList>
					{(c: Address) => (
						<ComboboxItem key={c.address} value={c} className="pr-1.5">
							<span className="truncate">{c.name ?? c.address}</span>
							{c.name ? <span className="truncate text-muted-foreground">{c.address}</span> : null}
						</ComboboxItem>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}
