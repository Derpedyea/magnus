import type { DirectoryDomain } from "#shared";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AddressValue {
	localPart: string;
	domain: string;
}

/** local-part @ domain. The domain is a picker once there's more than one. */
export function AddressInput(props: { id: string; value: AddressValue; onChange: (value: AddressValue) => void; domains: DirectoryDomain[]; required?: boolean }) {
	const { value, onChange } = props;
	return (
		<InputGroup>
			<InputGroupInput
				id={props.id}
				required={props.required}
				pattern="[A-Za-z0-9]([A-Za-z0-9._\-]*[A-Za-z0-9])?"
				autoCapitalize="none"
				spellCheck={false}
				value={value.localPart}
				onChange={(e) => onChange({ ...value, localPart: e.target.value })}
			/>
			<InputGroupAddon align="inline-end" className="pr-1">
				{props.domains.length > 1 ? (
					<Select
						items={props.domains.map((d) => ({ value: d.name, label: `@${d.name}` }))}
						value={value.domain}
						onValueChange={(domain) => onChange({ ...value, domain: String(domain) })}
					>
						<SelectTrigger size="sm" aria-label="Domain" className="h-6 border-0 shadow-none">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{props.domains.map((d) => (
								<SelectItem key={d.name} value={d.name}>
									@{d.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : (
					<span className="pr-2">@{value.domain}</span>
				)}
			</InputGroupAddon>
		</InputGroup>
	);
}
