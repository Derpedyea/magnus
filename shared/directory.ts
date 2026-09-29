import type { MailHost } from "./cloudflare";

// What the API returns about people, mailboxes, domains, and addresses. The Worker builds these from D1
// (worker/directory.ts); the app reads them.

export interface User {
	id: string;
	/** Where sign-in codes go. */
	email: string;
	name: string;
	isAdmin: boolean;
}

/** Characters. Room for a few lines, not a letterhead. */
export const MAX_SIGNATURE = 2000;

export interface MailboxAddress {
	address: string;
	displayName: string | null;
	/** Routed here with can_send, on a domain that can send. */
	canSend: boolean;
	/** What the composer adds when you send as it. Yours alone, even on a shared address. */
	signature: string | null;
}

export interface MailboxMembership {
	id: string;
	name: string;
	role: "owner" | "member";
	/** Every enabled address routed here, in the order they were added (primary first). */
	addresses: MailboxAddress[];
}

/** GET /api/me */
export interface Me {
	user: User;
	mailboxes: MailboxMembership[];
}

/** GET /api/config: all the app knows before anyone signs in. */
export interface AppConfig {
	/** No one has claimed this install yet: every page leads to /setup. */
	setupRequired: boolean;
	/** "Continue with Google" is configured. */
	google: boolean;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface DirectoryDomain {
	name: string;
	zoneId: string | null;
	receiving: boolean;
	sending: boolean;
	/** Unknown addresses at this domain deliver here; null rejects them at SMTP time. */
	catchAllMailboxId: string | null;
}

export interface Person {
	id: string;
	name: string;
	email: string;
	isAdmin: boolean;
	/** Suspended: can't sign in, but their addresses keep receiving. */
	banned: boolean;
}

export interface DirectoryMailbox {
	id: string;
	name: string;
	memberIds: string[];
}

export interface DirectoryAddress {
	address: string;
	domain: string;
	displayName: string | null;
	/** More than one: a group address, where each mailbox gets a copy. */
	mailboxIds: string[];
}

/** GET /api/admin/directory: everything the admin pages show. */
export interface Directory {
	domains: DirectoryDomain[];
	people: Person[];
	mailboxes: DirectoryMailbox[];
	addresses: DirectoryAddress[];
	/** A Cloudflare token is saved, so turning domains on doesn't ask for one. */
	cloudflareTokenSaved: boolean;
}

/** A domain in the Cloudflare account, and who receives its mail today. */
export interface Zone {
	id: string;
	name: string;
	mail: MailHost;
}
