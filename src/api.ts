import type {
	Address,
	AppConfig,
	Counts,
	Directory,
	MailboxThread,
	Me,
	SendAttachmentRef,
	SendQueued,
	StepId,
	StepStatus,
	ThreadDetail,
	Zone,
} from "#shared";
import { adminClient, emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/client";

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (typeof init.body === "string") headers.set("Content-Type", "application/json");
	const res = await fetch(`/api${path}`, { ...init, headers });
	if (!res.ok) throw new ApiError(await failureMessage(res), res.status);
	return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Our API answers `{ error }` and Better Auth `{ message }`. Validation errors are objects, so those fall back to the status. */
async function failureMessage(res: Response): Promise<string> {
	const body: unknown = await res.json().catch(() => null);
	if (typeof body !== "object" || body === null) return res.statusText;
	if ("error" in body && typeof body.error === "string") return body.error;
	if ("message" in body && typeof body.message === "string") return body.message;
	return res.statusText;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path: string, body: unknown) => request<void>(path, { method: "PATCH", body: JSON.stringify(body) });
const del = (path: string) => request<void>(path, { method: "DELETE" });

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

/** Query string for cross-mailbox reads; an empty scope means every address. */
const scoped = (scope: string[], params: Record<string, string> = {}) =>
	new URLSearchParams(scope.length ? { ...params, in: scope.join(",") } : params).toString();

export const api = {
	config: () => request<AppConfig>("/config"),
	me: () => request<Me>("/me"),
	threads: (scope: string[], label: string) => request<{ threads: MailboxThread[] }>(`/threads?${scoped(scope, { label })}`),
	search: (scope: string[], q: string) => request<{ threads: MailboxThread[] }>(`/search?${scoped(scope, { q })}`),
	counts: (scope: string[]) => request<Counts>(`/counts?${scoped(scope)}`),
	thread: (mb: string, id: string) => request<ThreadDetail>(`/mailboxes/${mb}/threads/${id}`),
	modify: (mb: string, threadIds: string[], add: string[], remove: string[]) =>
		post<void>(`/mailboxes/${mb}/threads/modify`, { threadIds, add, remove }),
	markRead: (mb: string, threadIds: string[], read: boolean) => post<void>(`/mailboxes/${mb}/threads/read`, { threadIds, read }),
	upload: (mb: string, file: File) =>
		request<SendAttachmentRef>(`/mailboxes/${mb}/uploads`, {
			method: "POST",
			body: file,
			headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
		}),
	send: (mb: string, draft: SendRequest) => post<SendQueued>(`/mailboxes/${mb}/send`, draft),
	shareLink: (mb: string, messageId: string, attachmentId: string, shared: boolean) =>
		patch(`/mailboxes/${mb}/messages/${messageId}/attachments/${attachmentId}`, { shared }),
	cancel: (mb: string, messageId: string) => post<void>(`/mailboxes/${mb}/outbox/${messageId}/cancel`, {}),
};

/** First run: prove ownership with a Cloudflare token, then become the first admin (and get signed in). */
export const setupApi = {
	verify: (token: string) => post<{ accountName: string; zones: Zone[] }>("/setup/verify", { token }),
	complete: (input: { token: string; zoneId: string; name: string; localPart: string; email: string }) => post<void>("/setup/complete", input),
};

export const adminApi = {
	directory: () => request<Directory>("/admin/directory"),
	zones: (token: string) => post<{ zones: Zone[] }>("/admin/zones", { token }),
	addDomain: (token: string, zoneId: string) => post<{ name: string }>("/admin/domains", { token, zoneId }),
	domainStatus: (token: string, domain: string) => post<Record<StepId, StepStatus>>(`/admin/domains/${domain}/status`, { token }),
	runStep: (token: string, domain: string, step: StepId, moveMail: boolean) =>
		post<StepStatus>(`/admin/domains/${domain}/steps/${step}`, { token, moveMail }),
	setCatchAll: (domain: string, catchAllMailboxId: string | null) => patch(`/admin/domains/${domain}`, { catchAllMailboxId }),
	removeDomain: (domain: string) => del(`/admin/domains/${domain}`),
	addPerson: (input: { name: string; email: string; isAdmin: boolean; address?: { localPart: string; domain: string } }) =>
		post<{ id: string }>("/admin/people", input),
	removePerson: (id: string) => del(`/admin/people/${id}`),
	addAddress: (input: { localPart: string; domain: string; displayName?: string; mailboxIds: string[] }) => post<{ address: string }>("/admin/addresses", input),
	removeAddress: (address: string) => del(`/admin/addresses/${encodeURIComponent(address)}`),
};

export interface SendRequest {
	from: string;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	text: string;
	replyToMessageId?: string;
	attachments: SendAttachmentRef[];
	delaySeconds: number;
}

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
