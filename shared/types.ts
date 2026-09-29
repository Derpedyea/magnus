import type { Address } from "./address";
import type { MessageBody } from "./links";

// ─── Labels ──────────────────────────────────────────────────────────────────
// Gmail-style: labels live on messages; a thread shows up in a view if any of its
// messages carries the label. "Archive" is simply "remove inbox".
export const SYSTEM_LABELS = ["inbox", "sent", "outbox", "spam", "trash", "starred"] as const;
export type SystemLabel = (typeof SYSTEM_LABELS)[number];
/** Pseudo-view: every thread not in trash/spam. */
export const ALL_MAIL = "all";

// ─── Queue: magnus-inbound (produced by email(), consumed by queue()) ─────────
export interface InboundJob {
	v: 1;
	/** ULID assigned when the message was accepted. Idempotency key per mailbox. */
	ingestId: string;
	/** R2 key of the raw RFC 5322 message. Shared by every mailbox it fans out to. */
	rawKey: string;
	rawSize: number;
	mailboxId: string;
	/** Envelope MAIL FROM (trustworthy, unlike the From header). */
	envelopeFrom: string;
	/** Envelope RCPT TO as received, including any +tag. */
	envelopeTo: string;
	subaddress: string | null;
	receivedAt: number;
}

// ─── Queue: magnus-email-events (Email Sending event subscription) ──────────
// https://developers.cloudflare.com/email-service/platform/event-subscriptions/
export type EmailSendingEventType =
	| "cf.email.sending.message.delivered"
	| "cf.email.sending.message.deferred"
	| "cf.email.sending.message.bounced"
	| "cf.email.sending.message.failed"
	| "cf.email.sending.message.rejected"
	| "cf.email.sending.message.complained";

export interface EmailSendingEvent {
	type: EmailSendingEventType;
	source: { type: "email.sending"; zoneId: string; domain: string };
	payload: {
		eventId: string;
		messageId: string;
		sender: string;
		recipient: string;
		subject?: string;
		terminal: boolean;
		delivery: { status: string; smtpResponse?: string; smtpStatusCode?: string };
		bounce?: { type: "hard" | "soft"; classification: string; reason: string };
		rejection?: { reason: string; party: string; detail: string };
		failure?: { reason: string };
		complaint?: { type: string };
	};
	metadata: { accountId: string; eventTimestamp: string };
}

// ─── Mailbox data model (DTOs returned over RPC / JSON) ──────────────────────
export type Direction = "in" | "out";

export type DeliveryStatus =
	| "queued"
	| "sending"
	| "sent"
	| "delivered"
	| "deferred"
	| "bounced"
	| "failed"
	| "rejected"
	| "complained"
	| "cancelled";

/** What the sender can retry: Email Sending refused the message (`failed`), or recipients' servers did. */
export const RETRYABLE = new Set<DeliveryStatus>(["bounced", "rejected", "failed"]);

export interface AuthResults {
	spf: string | null;
	dkim: string | null;
	dmarc: string | null;
}

export interface AttachmentMeta {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	/** Content-ID without angle brackets, for cid: references in HTML. */
	contentId: string | null;
	inline: boolean;
	/**
	 * Sent as a download link (shared/links.ts): its token, and whether the sender still shares it. Null when the
	 * file is inside the message.
	 */
	link: { token: string; shared: boolean } | null;
}

export interface StoredAttachment extends AttachmentMeta {
	r2Key: string;
}

export interface ThreadSummary {
	id: string;
	subject: string;
	snippet: string;
	lastMessageAt: number;
	messageCount: number;
	unreadCount: number;
	participants: Address[];
	labels: string[];
	/** Which of our addresses the thread's messages were delivered to or sent from (+tags stripped). */
	addresses: string[];
}

/** A thread in a list that can span several mailboxes; mutations go to `mailboxId`. */
export interface MailboxThread extends ThreadSummary {
	mailboxId: string;
}

export interface MessageDetail {
	id: string;
	threadId: string;
	direction: Direction;
	messageIdHeader: string | null;
	from: Address;
	to: Address[];
	cc: Address[];
	replyTo: Address[];
	subject: string;
	date: number;
	text: string | null;
	hasHtml: boolean;
	isRead: boolean;
	labels: string[];
	attachments: AttachmentMeta[];
	delivery: {
		status: DeliveryStatus;
		detail: string | null;
		/** Recipients whose servers refused it (a RETRYABLE status). Empty when nobody did, or it never left. */
		undelivered: string[];
	} | null;
	auth: AuthResults | null;
}

/** A message as its thread shows it. */
export interface ThreadMessage extends MessageDetail {
	/** The message here it replies to (replyParents()). Null when it starts the thread or answers nothing here. */
	parentId: string | null;
}

export interface ThreadDetail {
	thread: ThreadSummary;
	/** Oldest first. */
	messages: ThreadMessage[];
}

export interface LabelCount {
	label: string;
	threads: number;
	unread: number;
}

export interface Counts {
	/** Per label, within the requested addresses. */
	labels: LabelCount[];
	/** Unread inbox threads per address, regardless of the requested addresses (drives the address switcher). */
	addresses: { address: string; unread: number }[];
}

/**
 * Restricts reads to messages delivered to or sent from these addresses.
 * Omitted = the whole mailbox; empty = nothing.
 */
export type AddressFilter = { addresses?: string[] };

/** Where a page of a list ended. Lists run newest first, ties broken by id, so the next page starts just past this thread. */
export interface ListCursor {
	at: number;
	id: string;
}

/** At most `limit` threads, starting after `before` (or from the top). */
export type ListPage = { before?: ListCursor; limit?: number };

// ─── Mailbox RPC inputs ─────────────────────────────────────────────────────
export interface IngestInput {
	id: string;
	rawKey: string;
	envelopeFrom: string;
	envelopeTo: string;
	receivedAt: number;
	messageIdHeader: string | null;
	inReplyTo: string[];
	references: string[];
	from: Address;
	to: Address[];
	cc: Address[];
	replyTo: Address[];
	subject: string;
	date: number;
	text: string | null;
	/** R2 key of the (cid-rewritten) HTML body, if the message had one. */
	htmlKey: string | null;
	attachments: StoredAttachment[];
	auth: AuthResults | null;
	labels: string[];
}

export interface SendAttachmentRef {
	r2Key: string;
	filename: string;
	contentType: string;
	size: number;
	/** Set on images a forwarded HTML body shows by Content-ID. They go inline and never as links. */
	contentId?: string;
}

export interface SendInput {
	/** Must equal the DO name; recorded so the outbox alarm can build R2 keys. */
	mailboxId: string;
	from: Address;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	text: string;
	html?: string;
	/** Local message id being replied to or forwarded; drives In-Reply-To/References and thread placement. */
	parentMessageId?: string;
	/** A forward's divider, header, and original (forwardedPart()), added below the text and any links. */
	forward?: MessageBody;
	attachments: SendAttachmentRef[];
	/** Too big to attach: kept like attachments, but the message carries download links to them. */
	links: SendAttachmentRef[];
	/** Where links point, `<origin>/f/<mailboxId>/`; each link is this plus the file's token. */
	linkBase: string;
	/** Undo-send window / scheduled send. */
	delayMs: number;
	/** Recipients delivered by labelling the sent copy once it leaves the outbox (see localRecipients()). */
	localRecipients: LocalRecipient[];
	/** Every recipient is local, so nothing is handed to Email Sending. */
	localOnly: boolean;
}

export interface LocalRecipient {
	/** As addressed, +tag included. */
	address: string;
	/** Labels an inbound copy would have carried: inbox, plus the +tag's label. */
	labels: string[];
}

export interface SendQueued {
	id: string;
	threadId: string;
	sendAt: number;
}

export interface DeliveryEventInput {
	providerMessageId: string;
	recipient: string;
	status: DeliveryStatus;
	detail: string | null;
	at: number;
}

export interface MessageBlobs {
	rawKey: string | null;
	htmlKey: string | null;
	attachments: StoredAttachment[];
}

/** Pushed to connected web clients over the mailbox WebSocket. */
export type LiveEvent =
	| { type: "threads.changed"; threadIds: string[] }
	| { type: "delivery.changed"; messageId: string; status: DeliveryStatus };
