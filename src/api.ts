import type { Address, StepId } from "#shared";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";
import { hc, type InferRequestType, parseResponse } from "hono/client";
// Built declarations, not the worker's source: see tsconfig.app.json.
import type { AppType } from "#worker/api";

/** An address the user can send as, and the mailbox that sends it. */
export interface Identity {
	mailboxId: string;
	address: string;
	displayName: string | null;
}

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** For error boundaries, which receive whatever was thrown. */
export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong");

/** Our API answers `{ error }` and Better Auth `{ message }`. Validation errors are objects, so those fall back to the status. */
async function failureMessage(res: Response): Promise<string> {
	const body: unknown = await res.json().catch(() => null);
	if (typeof body !== "object" || body === null) return res.statusText;
	if ("error" in body && typeof body.error === "string") return body.error;
	if ("message" in body && typeof body.message === "string") return body.message;
	return res.statusText;
}

/** Better Auth from the browser: sign-in, sign-out, and the admin plugin's people actions. */
export const authClient = createAuthClient({
	basePath: "/api/auth",
	plugins: [emailOTPClient(), adminClient()],
	fetchOptions: {
		// Throws with Better Auth's own message (the default error only carries the status text).
		onError: ({ error, response }) => {
			throw new ApiError(error.message ?? response.statusText, response.status);
		},
		throw: true,
	},
});

/**
 * The worker's routes, typed from worker/api.ts. A failure throws ApiError with the server's message, so
 * parseResponse only ever sees successes and returns their body (undefined for a 204).
 */
const client = hc<AppType>("/", {
	fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
		const res = await fetch(input, init);
		if (!res.ok) throw new ApiError(await failureMessage(res), res.status);
		return res;
	},
}).api;

/** A route's JSON body, for wrappers that pass one straight through. */
type Json<Route> = InferRequestType<Route> extends { json: infer Body } ? Body : never;

/** `?in=` for cross-mailbox reads; an empty scope means every address. */
const scoped = (scope: string[]) => (scope.length ? scope.join(",") : undefined);

const mailbox = client.mailboxes[":mailboxId"];

export const api = {
	config: () => parseResponse(client.config.$get()),
	me: () => parseResponse(client.me.$get()),
	threads: (scope: string[], label: string) => parseResponse(client.threads.$get({ query: { in: scoped(scope), label } })),
	search: (scope: string[], q: string) => parseResponse(client.search.$get({ query: { in: scoped(scope), q } })),
	counts: (scope: string[]) => parseResponse(client.counts.$get({ query: { in: scoped(scope) } })),
	thread: (mailboxId: string, threadId: string) => parseResponse(mailbox.threads[":threadId"].$get({ param: { mailboxId, threadId } })),
	modify: (mailboxId: string, threadIds: string[], add: string[], remove: string[]) =>
		parseResponse(mailbox.threads.modify.$post({ param: { mailboxId }, json: { threadIds, add, remove } })),
	markRead: (mailboxId: string, threadIds: string[], read: boolean) =>
		parseResponse(mailbox.threads.read.$post({ param: { mailboxId }, json: { threadIds, read } })),
	upload: (mailboxId: string, file: File) =>
		parseResponse(
			mailbox.uploads.$post(
				{ param: { mailboxId } },
				{ init: { body: file }, headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) } },
			),
		),
	send: (mailboxId: string, draft: Json<typeof mailbox.send.$post>) => parseResponse(mailbox.send.$post({ param: { mailboxId }, json: draft })),
	shareLink: (mailboxId: string, messageId: string, attachmentId: string, shared: boolean) =>
		parseResponse(mailbox.messages[":messageId"].attachments[":attachmentId"].$patch({ param: { mailboxId, messageId, attachmentId }, json: { shared } })),
	cancel: (mailboxId: string, messageId: string) => parseResponse(mailbox.outbox[":messageId"].cancel.$post({ param: { mailboxId, messageId } })),
};

/** First run: prove ownership with a Cloudflare token, then become the first admin (and get signed in). */
export const setupApi = {
	verify: (token: string) => parseResponse(client.setup.verify.$post({ json: { token } })),
	complete: (json: Json<typeof client.setup.complete.$post>) => parseResponse(client.setup.complete.$post({ json })),
};

const admin = client.admin;

export const adminApi = {
	directory: () => parseResponse(admin.directory.$get()),
	/** Checked against this install, then saved encrypted; Cloudflare calls below use it. */
	saveToken: (token: string) => parseResponse(admin["cloudflare-token"].$put({ json: { token } })),
	forgetToken: () => parseResponse(admin["cloudflare-token"].$delete()),
	zones: () => parseResponse(admin.zones.$get()),
	addDomain: (zoneId: string) => parseResponse(admin.domains.$post({ json: { zoneId } })),
	runStep: (domain: string, step: StepId, moveMail: boolean) =>
		parseResponse(admin.domains[":domain"].steps[":step"].$post({ param: { domain, step }, json: { moveMail } })),
	setCatchAll: (domain: string, catchAllMailboxId: string | null) =>
		parseResponse(admin.domains[":domain"].$patch({ param: { domain }, json: { catchAllMailboxId } })),
	removeDomain: (domain: string) => parseResponse(admin.domains[":domain"].$delete({ param: { domain } })),
	addPerson: (json: Json<typeof admin.people.$post>) => parseResponse(admin.people.$post({ json })),
	removePerson: (id: string) => parseResponse(admin.people[":id"].$delete({ param: { id } })),
	addAddress: (json: Json<typeof admin.addresses.$post>) => parseResponse(admin.addresses.$post({ json })),
	// hc puts params into the path as given.
	removeAddress: (address: string) => parseResponse(admin.addresses[":address"].$delete({ param: { address: encodeURIComponent(address) } })),
};

export const messageUrl = (mb: string, messageId: string) => `/api/mailboxes/${mb}/messages/${messageId}`;

/** "Jane <jane@x.com>, bob@y.com" → Address[] (quoted names containing commas aren't supported). */
export function parseAddressList(input: string): Address[] {
	return input
		.split(/[,;]/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
			if (m) return m[1] ? { address: m[2]!.trim(), name: m[1].trim() } : { address: m[2]!.trim() };
			return { address: part };
		});
}

export function formatList(list: Address[]): string {
	return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
}
