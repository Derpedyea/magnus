import { ALL_MAIL, type LocalRecipient, SYSTEM_LABELS } from "./types";

/** Names a tag can't take as its label: system labels and the app's other views. */
const RESERVED_LABELS = new Set<string>([...SYSTEM_LABELS, ALL_MAIL, "drafts", "failed", "search"]);

export interface Address {
	address: string;
	name?: string;
}

const ADDRESS_RE = /^[^\s@<>()",;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/** Lowercase and trim. Local parts are technically case-sensitive, but no real mailbox relies on it. */
export function normalizeAddress(address: string): string {
	return address.trim().toLowerCase();
}

export function isValidAddress(address: string): boolean {
	return ADDRESS_RE.test(address.trim());
}

export function splitAddress(address: string): { local: string; domain: string } {
	const at = address.lastIndexOf("@");
	if (at <= 0) throw new Error(`Invalid address: ${address}`);
	return { local: address.slice(0, at), domain: address.slice(at + 1) };
}

/**
 * A sender to block, as sender_blocks stores it: an address, or `*@domain` for everyone there. Takes
 * `x@y.com`, `*@y.com`, `@y.com`, or `y.com`; null when it's neither an address nor a domain.
 */
export function blockPattern(input: string): string | null {
	const value = normalizeAddress(input).replace(/^\*?@/, "");
	if (DOMAIN_RE.test(value)) return `*@${value}`;
	return isValidAddress(value) ? value : null;
}

/**
 * RFC 5233 subaddressing: `me+github@x.com` → base `me@x.com`, tag `github`.
 * Email Routing already falls back to the base rule; we use the tag for auto-labelling.
 */
export function stripSubaddress(address: string): { base: string; tag: string | null } {
	const normalized = normalizeAddress(address);
	const { local, domain } = splitAddress(normalized);
	const plus = local.indexOf("+");
	if (plus <= 0) return { base: normalized, tag: null };
	return { base: `${local.slice(0, plus)}@${domain}`, tag: local.slice(plus + 1) || null };
}

/** Subaddress tag → label name (`me+GitHub@…` → `github`). */
export function labelFromTag(tag: string): string {
	const label = tag
		.toLowerCase()
		.replaceAll(/[^a-z0-9._-]/g, "-")
		.slice(0, 64);
	// A tag can't file mail under a view of its own: me+spam@ isn't Spam, and me+screener@ isn't held.
	return RESERVED_LABELS.has(label) ? `${label}-tag` : label;
}

/**
 * Recipients a send can deliver by itself: routed only to the sending mailbox, so the sent copy doubles
 * as their received copy. Anyone else, including our addresses that live in other mailboxes, is reached
 * through Email Sending. `route` is the directory's resolveRecipient() result.
 */
export function localRecipients(
	recipients: { address: string; route: { kind: "deliver"; mailboxIds: string[]; subaddress: string | null } | { kind: "reject" } }[],
	mailboxId: string,
): LocalRecipient[] {
	return recipients.flatMap(({ address, route }) =>
		route.kind === "deliver" && route.mailboxIds.every((id) => id === mailboxId)
			? [{ address, labels: route.subaddress ? ["inbox", labelFromTag(route.subaddress)] : ["inbox"] }]
			: [],
	);
}

export function formatAddress(a: Address): string {
	if (!a.name) return a.address;
	const needsQuotes = /[",;:<>@()[\]\\]/.test(a.name);
	return needsQuotes ? `"${a.name.replaceAll(/["\\]/g, "\\$&")}" <${a.address}>` : `${a.name} <${a.address}>`;
}
