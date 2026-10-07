import { type Address, formatScope, type MailSettings, type StepId } from "#shared";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";
import { hc, type InferRequestType, parseResponse } from "hono/client";
import type { DraftWrite } from "#shared/drafts";
// Built declarations, not the worker's source: see tsconfig.app.json.
import type { AppType } from "#worker/api";

/** An address the user can send as, and the mailbox that sends it. */
export interface Identity {
	mailboxId: string;
	address: string;
	displayName: string | null;
	signature: string | null;
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

const mailbox = client.mailboxes[":mailboxId"];

export const api = {
	config: () => parseResponse(client.config.$get()),
	me: () => parseResponse(client.me.$get()),
	saveSignature: (address: string, text: string) => parseResponse(client.signatures.$put({ json: { address, text } })),
	contacts: () => parseResponse(client.contacts.$get()),
	drafts: () => parseResponse(client.drafts.$get()),
	draft: (id: string) => parseResponse(client.drafts[":id"].$get({ param: { id } })),
	saveDraft: (id: string, json: DraftWrite, signal: AbortSignal) => parseResponse(client.drafts[":id"].$put({ param: { id }, json }, { init: { signal } })),
	discardDraft: (id: string, revision: number, signal: AbortSignal) => parseResponse(client.drafts[":id"].$delete({ param: { id }, json: { revision } }, { init: { signal } })),
	/** One page of a list; `cursor` is the previous page's `next`, or "" for the first. */
	threads: (scope: string[], label: string, cursor: string) =>
		parseResponse(client.threads.$get({ query: { in: formatScope(scope), label, cursor: cursor || undefined } })),
	search: (scope: string[], q: string, cursor: string) =>
		parseResponse(client.search.$get({ query: { in: formatScope(scope), q, cursor: cursor || undefined } })),
	counts: (scope: string[]) => parseResponse(client.counts.$get({ query: { in: formatScope(scope) } })),
	thread: (mailboxId: string, threadId: string) => parseResponse(mailbox.threads[":threadId"].$get({ param: { mailboxId, threadId } })),
	deleteThread: (mailboxId: string, threadId: string) => parseResponse(mailbox.threads[":threadId"].$delete({ param: { mailboxId, threadId } })),
	emptyTrash: (scope: string[]) => parseResponse(client.trash.$delete({ query: { in: formatScope(scope) } })),
	modify: (mailboxId: string, threadIds: string[], add: string[], remove: string[]) =>
		parseResponse(mailbox.threads.modify.$post({ param: { mailboxId }, json: { threadIds, add, remove } })),
	/** Not spam (trusted) or Spam for one message and its sender, not the whole thread. */
	judge: (mailboxId: string, messageId: string, verdict: "trusted" | "spam") =>
		parseResponse(mailbox.messages[":messageId"].judge.$post({ param: { mailboxId, messageId }, json: { verdict } })),
	settings: (mailboxId: string) => parseResponse(mailbox.settings.$get({ param: { mailboxId } })),
	updateSettings: (mailboxId: string, change: Partial<MailSettings>) => parseResponse(mailbox.settings.$patch({ param: { mailboxId }, json: change })),
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
	/** Sends a failed or bounced message again, to whoever it didn't reach. */
	retry: (mailboxId: string, messageId: string) => parseResponse(mailbox.messages[":messageId"].retry.$post({ param: { mailboxId, messageId } })),
	/** Incoming mail that couldn't be read, newest first. */
	failed: (scope: string[]) => parseResponse(client.failed.$get({ query: { in: formatScope(scope) } })),
	retryFailed: (mailboxId: string, failedId: string) => parseResponse(mailbox.failed[":failedId"].retry.$post({ param: { mailboxId, failedId } })),
	deleteFailed: (mailboxId: string, failedId: string) => parseResponse(mailbox.failed[":failedId"].$delete({ param: { mailboxId, failedId } })),
	/** The key browsers subscribe with, and the endpoint this session's notifications go to, if any. */
	push: () => parseResponse(client.push.$get()),
	enablePush: (json: Json<typeof client.push.$put>) => parseResponse(client.push.$put({ json })),
	disablePush: () => parseResponse(client.push.$delete()),
};

/** First run: prove ownership with a Cloudflare token, then become the first admin (and get signed in). */
export const setupApi = {
	verify: (token: string) => parseResponse(client.setup.verify.$post({ json: { token } })),
	complete: (json: Json<typeof client.setup.complete.$post>) => parseResponse(client.setup.complete.$post({ json })),
	finish: (token: string) => parseResponse(client.setup.finish.$post({ json: { token } })),
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
	/** An address, or `*@domain` for everyone there (see blockPattern). */
	blockSender: (pattern: string) => parseResponse(admin["blocked-senders"].$post({ json: { pattern } })),
	unblockSender: (pattern: string) => parseResponse(admin["blocked-senders"][":pattern"].$delete({ param: { pattern: encodeURIComponent(pattern) } })),
};

export const messageUrl = (mb: string, messageId: string) => `/api/mailboxes/${mb}/messages/${messageId}`;
/** Failed mail's original, as an .eml download. */
export const failedRawUrl = (mb: string, failedId: string) => `/api/mailboxes/${mb}/failed/${failedId}/raw`;

/** "Jane <jane@x.com>, bob@y.com" → Address[], one per line works too (quoted names containing commas aren't supported). */
export function parseAddressList(input: string): Address[] {
	return input
		.split(/[,;\n]/)
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
