import type { Address } from "./address";
import type { MessageBody } from "./links";

// ─── Labels ──────────────────────────────────────────────────────────────────
// Gmail-style: labels live on messages; a thread shows up in a view if any of its
// messages carries the label. "Archive" is simply "remove inbox".
export const SYSTEM_LABELS = ["inbox", "sent", "outbox", "spam", "trash", "starred", "screener"] as const;
export type SystemLabel = (typeof SYSTEM_LABELS)[number];
/** Pseudo-view: every thread not in trash/spam. */
export const ALL_MAIL = "all";

/** Colors a label can have. Names rather than values, so the app picks shades that suit light and dark. */
export const LABEL_COLORS = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];
/** A label inside a label inside a label, and no deeper. */
export const MAX_LABEL_DEPTH = 3;

/**
 * A label of the person's own (system labels have none). Mail carries its `key`, which never changes, so renaming or
 * moving a label rewrites no mail; a +tag files mail under the label whose key it names (labelFromTag()).
 */
export interface Label {
	key: string;
	name: string;
	/** The label it sits inside, by key. */
	parent: string | null;
	color: LabelColor | null;
	/** Order among the labels sharing its parent. */
	position: number;
	/** Left out of the sidebar. */
	hidden: boolean;
}

/** What one mailbox needs to take on a label another has. */
export type LabelDef = Pick<Label, "key" | "name" | "parent" | "color">;
/** A change to a label; what it leaves out stays as it is. */
export type LabelChange = Partial<Omit<Label, "key">>;

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
	/**
	 * How many times checking it with Workers AI has failed (worker/mail/checks.ts). Each failure queues the job again
	 * with this one higher, so failures elsewhere, which the queue's own attempt count includes, don't use up its tries.
	 */
	checkFailures?: number;
	/**
	 * How many times checking it against the AI conditions of the mailbox's rules has failed (worker/mail/rules.ts),
	 * counted like checkFailures.
	 */
	ruleFailures?: number;
	/**
	 * What the checks said of it (IngestInput.check), kept when it's queued again because the rules' check failed, so
	 * its sender isn't checked, and billed, again. Null when it needed no check. Unset until then.
	 */
	check?: MailCheck | null;
	/**
	 * Mail imported from another provider (worker/mail/import.ts), placed as it was there instead of by triage. Its
	 * envelope fields come from its headers: envelopeTo is the address of ours it belongs to, when it names one.
	 */
	imported?: Imported;
}

export interface Imported {
	labels: string[];
	/** Its own labels' folders and labels there, by path (ImportPlacement.paths). Jobs queued before these came have none. */
	paths?: string[];
	read: boolean;
	/** Sent from the mailbox rather than received by it. */
	sent: boolean;
	/** The mailbox's addresses it's filed under, as message_addresses holds them. envelopeTo is the first. */
	addresses: string[];
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

// ─── Rules ───────────────────────────────────────────────────────────────────
// A mailbox's own filters for new mail, run in order once triage has placed it (Mailbox.ingest(), shared/rules.ts).

export const RULE_TEXT_FIELDS = ["from", "to", "cc", "recipient", "subject", "body", "list-id"] as const;
export type RuleTextField = (typeof RULE_TEXT_FIELDS)[number];
export const RULE_TEXT_OPS = ["contains", "is", "starts-with", "ends-with"] as const;
export type RuleTextOp = (typeof RULE_TEXT_OPS)[number];
export const RULE_FLAGS = ["has-attachment", "verified-sender", "mailing-list"] as const;
export type RuleFlag = (typeof RULE_FLAGS)[number];

/** What a rule asks of mail. `not` asks the opposite. */
export type RuleCondition =
	/** `recipient` is To, Cc, or the address it was delivered to, with or without its +tag. */
	| { field: RuleTextField; op: RuleTextOp; value: string; not?: boolean }
	/** Any header of that name, whatever its case. `exists` asks only that there's one. */
	| { field: "header"; name: string; op: RuleTextOp | "exists"; value?: string; not?: boolean }
	| { field: RuleFlag; not?: boolean };

export const RULE_ACTIONS = ["label", "skip-inbox", "star", "mark-read", "spam", "trash"] as const;
/** What a rule does to mail it matches. `label` is one of the mailbox's own labels, by key. */
export type RuleAction = { do: "label"; label: string } | { do: Exclude<(typeof RULE_ACTIONS)[number], "label"> };

export interface RuleInput {
	name: string;
	/** Off, it's kept but doesn't run. */
	enabled: boolean;
	/** Whether mail must meet every condition or any one. */
	match: "all" | "any";
	conditions: RuleCondition[];
	/**
	 * A condition in plain English, which Workers AI checks of new mail meeting the others (worker/mail/rules.ts). Not of
	 * mail going to Spam, and not of mail already here.
	 */
	ai: string | null;
	actions: RuleAction[];
	/** Later rules don't run on mail this one matched. */
	stop: boolean;
}

export interface Rule extends RuleInput {
	id: string;
	/** Written by someone, or by the mail agent for them. */
	createdBy: "user" | "agent";
	createdAt: number;
	updatedAt: number;
}

/** A rule that filed a message, and what the model said of its AI condition, if it has one. */
export interface RuleHit {
	id: string;
	/** As it was then. */
	name: string;
	reason: string | null;
}

/** The model's answer to one rule's AI condition. */
export interface RuleAnswer {
	match: boolean;
	reason: string;
}

/** A mailbox's rules, at most, and how many of them can have an AI condition: each costs a model's reading of new mail. */
export const MAX_RULES = 100;
export const MAX_AI_RULES = 20;

/** Which of the newest mail a rule would match, for trying it before it runs (Mailbox.previewRule()). */
export interface RulePreview {
	/** Newest first. */
	threads: ThreadSummary[];
	/** Messages it matched, of those scanned. */
	matched: number;
	scanned: number;
	/** It has an AI condition, which wasn't checked: only its other conditions were. */
	aiNotChecked: boolean;
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

/**
 * What the queue learned about inbound mail's sender, for Mailbox.ingest() to decide where it goes. Only a verified
 * sender can be trusted or marked: anyone can write any From address.
 */
export interface SenderCheck {
	/** The From address, normalized, when its domain's authentication vouches for it. */
	verified: string | null;
	/** Verified, and one of this install's own addresses. */
	internal: boolean;
	/** Failed its domain's authentication, so the From address is likely forged. */
	spoofed: boolean;
}

/** How a mailbox filters mail from senders it doesn't know. Settings › Spam. */
export interface MailSettings {
	/** First-time senders' mail waits in the Screener until someone lets them in. */
	screener: boolean;
	/** Cold outreach (MailCategory `outreach`) goes to Spam. Off, it's treated like other mail from someone new. */
	outreachToSpam: boolean;
}

/** What the checks sort mail from senders a mailbox doesn't know into (worker/mail/checks.ts). */
export const MAIL_CATEGORIES = ["personal", "transactional", "newsletter", "outreach", "spam", "phishing"] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

/** Workers AI's call on mail from a sender a mailbox doesn't know. */
export type MailCheck =
	/**
	 * `spam` is the quick model's probability that it's unsolicited (outreach, spam, or phishing); `model` is whichever
	 * model's category stood: the quick one when it was sure, else the deep one.
	 */
	| {
			kind: "checked";
			category: MailCategory;
			spam: number;
			model: string;
			/** Cold outreach that went to Spam because of the mailbox's setting (MailSettings.outreachToSpam). Set by the mailbox. */
			bySetting?: true;
	  }
	/** The models couldn't be reached or answered nonsense, every try. */
	| { kind: "unchecked"; error: string };

/** Why inbound mail went where it did, kept with it. Mail in Spam shows it. */
export type Verdict =
	/** From someone this mailbox writes to, a colleague here, or someone it took out of Spam. */
	| { kind: "trusted" }
	/** From someone whose mail this mailbox marked as spam. */
	| { kind: "marked" }
	/** Failed its sender's authentication. */
	| { kind: "spoofed" }
	/** Nothing to go on: a sender it didn't need to check when the queue asked. */
	| { kind: "unknown" }
	| MailCheck;

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

/**
 * Inbound mail the queue gave up parsing (Failed). Its original stays in R2, so it can be retried, downloaded, or
 * deleted. `id` is its ingest id, which becomes the message's id if a retry delivers it.
 */
export interface FailedMail {
	id: string;
	/** Envelope MAIL FROM: the message couldn't be read, so its headers weren't either. */
	from: string;
	/** Envelope RCPT TO as received, including any +tag. */
	to: string;
	size: number;
	receivedAt: number;
	/** The last error, if the attempt that gave up had one to report. */
	error: string | null;
	/** Retried since it last failed, so the queue has it again. */
	retrying: boolean;
}

export interface MailboxFailedMail extends FailedMail {
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
	/** Who sent mail was Bcc'd to. Empty for received mail, which never says. */
	bcc: Address[];
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
	/** Why inbound mail went where it did. Null for sent mail, and mail from before verdicts were kept. */
	verdict: Verdict | null;
	/** Its sender's domain vouched for the From address, so judging this message judges them (Mailbox.judgeMessage()). */
	senderVerified: boolean;
	/** The rules that filed it, in the order they ran. */
	rules: RuleHit[];
}

/** A message as its thread shows it. */
export interface ThreadMessage extends MessageDetail {
	/** Its parent for layout, falling back to a References ancestor. Null when it answers nothing here. */
	parentId: string | null;
	/** The layout parent matches In-Reply-To; a fallback ancestor isn't enough to fold its quote. */
	hasDirectParent: boolean;
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
	/** Messages under Failed, within the requested addresses. */
	failed: number;
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

/**
 * At most `limit` threads, starting after `before` (or from the top). With `through` instead, at most `limit` threads
 * from the top down to that place, then the first thread after it, if any, so the caller knows more follow.
 */
export type ListPage = { limit?: number } & ({ before?: ListCursor; through?: undefined } | { through: ListCursor; before?: undefined });

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
	/** Only for sent mail, which is the only kind that names its Bcc. */
	bcc?: Address[];
	replyTo: Address[];
	subject: string;
	date: number;
	text: string | null;
	/** R2 key of the (cid-rewritten) HTML body, if the message had one. */
	htmlKey: string | null;
	attachments: StoredAttachment[];
	auth: AuthResults | null;
	sender: SenderCheck;
	/** Set when the mailbox didn't know the sender (Mailbox.needsCheck()). Never for imported mail. */
	check: MailCheck | null;
	/** Labels besides where its verdict puts it: its +tag's. Imported mail isn't judged; these are all of its labels. */
	labels: string[];
	/** Read and sent as it was at the provider it came from. Its labels are already in `labels`. */
	imported?: Omit<Imported, "labels">;
	/** Its headers, for rules to match (MailHeader). Kept with it, so a rule can be tried on mail already here. */
	headers: MailHeader[];
	/**
	 * What the queue's model said of the AI conditions of the rules whose other conditions it matched, by rule id. A rule
	 * missing here doesn't match: its check failed every try, or it was added since.
	 */
	ruleAnswers?: Record<string, RuleAnswer>;
}

/**
 * One of a message's headers as rules see it: named in lower case, and cut to 500 characters. Only the first 60, less
 * the trace and signature headers every message has and no rule is about (worker/mail/ingest.ts).
 */
export interface MailHeader {
	name: string;
	value: string;
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
	/** Stable for retries of one saved draft's send; checked again after attachment I/O. */
	id?: string;
	/** Must equal the DO name; recorded so the outbox alarm can build R2 keys. */
	mailboxId: string;
	/** Who queued it. It goes only if they're still in the mailbox when it's due (Mailbox.alarm()). */
	senderId: string;
	from: Address;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	/** What the sender wrote, in markdown; noteBody() renders the message's text and HTML from it. */
	markdown: string;
	/** Local message id being replied to or forwarded; drives In-Reply-To/References and thread placement. */
	parentMessageId?: string;
	/** A forward's divider, header, and original (forwardedPart()), added below the note and any links. */
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

/**
 * Sent instead of an event once a mailbox WebSocket is past its time, just before the server closes it. The socket
 * was only authorized when it opened, so the client opens a new one, and the Worker checks the sign-in again.
 */
export const LIVE_RECHECK = "recheck";

/** Pushed to connected web clients over the mailbox WebSocket. */
export type LiveEvent =
	| { type: "threads.changed"; threadIds: string[] }
	| { type: "delivery.changed"; messageId: string; status: DeliveryStatus }
	| { type: "failed.changed" }
	| { type: "labels.changed" }
	| { type: "rules.changed" };

// ─── Mail agent (worker/agent.ts) ───────────────────────────────────────────
// The assistant in the app's side panel. The app keeps the conversation and sends it with each question; the server
// keeps nothing of it.

/** A tool the model asked for, with its arguments as the JSON it wrote. */
export interface AgentToolCall {
	id: string;
	name: string;
	arguments: string;
}

/** A conversation the panel links to, from what a tool found. */
export type AgentThread = Pick<MailboxThread, "mailboxId" | "id" | "subject" | "participants" | "lastMessageAt" | "unreadCount">;

export type AgentMessage =
	| { role: "user"; content: string }
	| { role: "assistant"; content: string; toolCalls?: AgentToolCall[] }
	/**
	 * What a tool did. `content` is what the model reads of it; `summary` and `threads` are what the panel shows, and the
	 * server doesn't take them back.
	 */
	| { role: "tool"; toolCallId: string; name: string; content: string; summary: string; threads?: AgentThread[] };

/**
 * A tool call waiting for the person to approve it (Trash, Spam, deleting or applying a rule, a rule that does those):
 * POST /api/agent never runs one, only POST /api/agent/approve does. `summary` says all it'll do.
 */
export interface PendingAction {
	id: string;
	name: string;
	args: Record<string, unknown>;
	summary: string;
	threads?: AgentThread[];
}

/** POST /api/agent: what the model said and did since the last message, and what it's waiting to be allowed to do. */
export interface AgentReply {
	messages: AgentMessage[];
	pending: PendingAction | null;
}
