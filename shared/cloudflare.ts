// Shared by setup/admin in the browser and the Worker's Cloudflare API calls.

/**
 * What the Cloudflare API token needs. `key` pre-selects it on the token page. Cloudflare's docs don't list the
 * email keys; they follow its OAuth scope names (email-routing-rule, email-sending) like the documented ones do.
 */
export const PERMISSIONS = {
	scripts: { label: "Workers Scripts · Read", key: { key: "workers_scripts", type: "read" } },
	queues: { label: "Queues · Edit", key: { key: "queues", type: "edit" } },
	zone: { label: "Zone · Read", key: { key: "zone", type: "read" } },
	zoneSettings: { label: "Zone Settings · Edit", key: { key: "zone_settings", type: "edit" } },
	dns: { label: "DNS · Edit", key: { key: "dns", type: "edit" } },
	routingRules: { label: "Email Routing Rules · Edit", key: { key: "email_routing_rule", type: "edit" } },
	sending: { label: "Email Sending · Edit", key: { key: "email_sending", type: "edit" } },
} as const;

export type Permission = keyof typeof PERMISSIONS;

/** Opens Cloudflare's account token page with every permission filled in. */
export function tokenTemplateUrl(): string {
	const keys = Object.values(PERMISSIONS).map((p) => p.key);
	const params = new URLSearchParams({ permissionGroupKeys: JSON.stringify(keys), name: "Magnus" });
	return `https://dash.cloudflare.com/?to=/:account/api-tokens&${params}`;
}

/** Turning a domain on, in order. Each is safe to repeat. */
export const STEP_IDS = ["routing", "catch-all", "sending", "events"] as const;

export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
	routing: "Receive mail with Email Routing",
	"catch-all": "Deliver every address to Magnus",
	sending: "Send mail with Email Sending",
	events: "Track delivery",
};

export interface StepStatus {
	/** todo: not started · pending: waiting on Cloudflare (usually DNS) · failed: needs you. */
	state: "done" | "pending" | "todo" | "failed";
	detail?: string;
	/** Failed only because the domain gets mail elsewhere: running again with moveMail goes ahead. */
	needsMoveMail?: boolean;
}

/** Who receives a domain's mail today, from its MX hosts. */
export type MailHost = { kind: "none" } | { kind: "cloudflare" } | { kind: "other"; provider: string };

const PROVIDERS: [RegExp, string][] = [
	[/\.protonmail\.ch$/, "Proton"],
	[/\.(google|googlemail)\.com$/, "Google"],
	[/\.outlook\.com$/, "Microsoft"],
	[/\.zoho\.(com|eu|in)$/, "Zoho"],
	[/\.messagingengine\.com$/, "Fastmail"],
	[/\.icloud\.com$/, "iCloud"],
	[/\.mailgun\.org$/, "Mailgun"],
	[/\.amazonaws\.com$/, "Amazon SES"],
];

export function mailHost(mxHosts: string[]): MailHost {
	const hosts = mxHosts.map((h) => h.toLowerCase().replace(/\.$/, ""));
	const foreign = hosts.filter((h) => !isCloudflareMx(h));
	if (hosts.length === 0) return { kind: "none" };
	if (foreign.length === 0) return { kind: "cloudflare" };
	const [first = ""] = foreign;
	const known = PROVIDERS.find(([pattern]) => pattern.test(first));
	// Unknown hosts are named by their last two labels: mx1.mail.example-host.com → example-host.com.
	return { kind: "other", provider: known?.[1] ?? first.split(".").slice(-2).join(".") };
}

export const isCloudflareMx = (host: string) => host.toLowerCase().replace(/\.$/, "").endsWith(".mx.cloudflare.net");
