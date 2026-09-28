import type { MailHost } from "#shared";
import { FieldDescription } from "@/components/ui/field";

/** Who receives a domain's mail today. Anyone else means moving it replaces their MX records. */
export function MailHostLabel({ host }: { host: MailHost }) {
	if (host.kind === "none") return <FieldDescription>No mail yet</FieldDescription>;
	if (host.kind === "cloudflare") return <FieldDescription>Already on Email Routing</FieldDescription>;
	return <FieldDescription className="text-amber-700">Gets mail at {host.provider}</FieldDescription>;
}
