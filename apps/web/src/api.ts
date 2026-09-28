import type { Address, Counts, MailboxThread, SendAttachmentRef, SendQueued, ThreadDetail } from "@magnus/shared";

export interface Me {
	user: { id: string; loginEmail: string; displayName: string; isAdmin: boolean };
	mailboxes: {
		id: string;
		name: string;
		role: "owner" | "member";
		addresses: { address: string; displayName: string | null; canSend: boolean }[];
	}[];
}

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

/** Query string for cross-mailbox reads; an empty scope means every address. */
const scoped = (scope: string[], params: Record<string, string> = {}) =>
	new URLSearchParams(scope.length ? { ...params, in: scope.join(",") } : params).toString();

export const api = {
	/** Starts "Continue with Google". Resolves to the Google URL to send the browser to; it comes back to `returnTo`. */
	signIn: (returnTo: string) =>
		post<{ url: string }>("/auth/sign-in/social", {
			provider: "google",
			callbackURL: returnTo,
			errorCallbackURL: `/login?redirect=${encodeURIComponent(returnTo)}`,
		}),
	/** Emails a sign-in code, but only to people in the directory. Succeeds either way, so it can't be used to probe. */
	sendCode: (email: string) => post<unknown>("/auth/email-otp/send-verification-otp", { email, type: "sign-in" }),
	/** Sets the session cookie on success. */
	signInWithCode: (email: string, otp: string) => post<unknown>("/auth/sign-in/email-otp", { email, otp }),
	signOut: () => post<unknown>("/auth/sign-out", {}),
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
	cancel: (mb: string, messageId: string) => post<void>(`/mailboxes/${mb}/outbox/${messageId}/cancel`, {}),
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
