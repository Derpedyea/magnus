import { z } from "zod";
import { RESERVED_LABELS } from "./address";
import { fromBase64Url } from "./base64url";
import { type CustomHotkeys, MAX_SIGNATURE } from "./directory";
import { LABEL_COLORS, type LabelChange, type LabelDef, type MailSettings, MAX_RULES, RULE_FLAGS, RULE_TEXT_FIELDS, RULE_TEXT_OPS, type RuleAction, type RuleCondition, type RuleInput } from "./types";

/** Email Service: to + cc + bcc combined. */
export const MAX_RECIPIENTS = 50;
/** Email Service: max entries in the attachments array. */
export const MAX_ATTACHMENTS = 32;

export const AddressSchema = z.object({
	address: z.email(),
	name: z.string().trim().max(200).optional(),
});

export const AttachmentRefSchema = z.object({
	r2Key: z.string().min(1),
	filename: z.string().min(1).max(255),
	contentType: z.string().min(1).max(255),
	size: z.number().int().nonnegative(),
});

export const ComposeSchema = z
	.object({
		from: z.email(),
		to: z.array(AddressSchema).min(1),
		cc: z.array(AddressSchema).default([]),
		bcc: z.array(AddressSchema).default([]),
		subject: z.string().max(998),
		/** Markdown (plain text reads the same). The message's text and HTML parts are both rendered from it (noteBody()). */
		text: z.string(),
		replyToMessageId: z.string().optional(),
		/** Forwards a message in this mailbox below the note. The images its HTML shows come along by themselves. */
		forward: z
			.object({
				messageId: z.string(),
				/** Which of its files to include. */
				attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS).default([]),
				/** The sender's, for the forwarded header's Date line. */
				timeZone: z.string().max(64).optional(),
			})
			.optional(),
		attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
		/** Saved draft consumed by this send. Its revision locks edits on other devices. */
		draft: z.object({ id: z.uuid(), revision: z.number().int().positive() }).optional(),
		/** Undo window. 0 sends on the next alarm tick; larger values are scheduled send. */
		delaySeconds: z.number().int().min(0).max(7 * 24 * 3600).default(10),
	})
	.refine((c) => c.to.length + c.cc.length + c.bcc.length <= MAX_RECIPIENTS, {
		message: `At most ${MAX_RECIPIENTS} recipients (to + cc + bcc)`,
	})
	.refine((c) => c.attachments.length + (c.forward?.attachmentIds.length ?? 0) <= MAX_ATTACHMENTS, {
		message: `At most ${MAX_ATTACHMENTS} attachments`,
	})
	.refine((c) => !(c.replyToMessageId && c.forward), { message: "A message can't be both a reply and a forward" });

export type ComposeRequest = z.infer<typeof ComposeSchema>;

/** System labels someone can put mail under (archiving is taking `inbox` away), and the ones they can take it out of. */
const ADDABLE = new Set(["inbox", "starred", "trash", "spam"]);
const REMOVABLE = new Set([...ADDABLE, "screener"]);
/**
 * A label of the person's own, by key: letters, digits, and `._-`, as labelKey(), labelFromTag(), and importLabel() make
 * them, and not dots alone. Keys go in URLs (/labels/:key), where anything else could name another label or route.
 */
const OwnLabelKey = z
	.string()
	.regex(/^(?!\.+$)[\p{L}\p{N}._-]{1,64}$/u, "Not a label's key")
	.refine((key) => !RESERVED_LABELS.has(key), "Not a label of your own");
const labelOr = (system: ReadonlySet<string>) => z.union([z.enum([...system]), OwnLabelKey]);

export const LabelNameSchema = z.string().trim().min(1, "Name it").max(64).refine((name) => !name.includes("/"), "A label's name can't have a / in it");
const LabelColorSchema = z.enum(LABEL_COLORS).nullable();

/** A label as one mailbox has it, to copy into another. */
export const LabelDefSchema = z.object({ key: OwnLabelKey, name: LabelNameSchema, parent: OwnLabelKey.nullable(), color: LabelColorSchema }) satisfies z.ZodType<LabelDef>;

export const ModifyThreadsSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	add: z.array(labelOr(ADDABLE)).max(50).default([]),
	remove: z.array(labelOr(REMOVABLE)).max(50).default([]),
	/**
	 * Labels being added, as the mailboxes that have them have them, outermost first. The threads' mailbox takes on any it
	 * doesn't have yet; one it has stays as it is.
	 */
	define: z.array(LabelDefSchema).max(50).default([]),
});

/** A new label in the mailboxes of the addresses in view. */
export const CreateLabelSchema = z.object({ name: LabelNameSchema, parent: OwnLabelKey.nullable().default(null), color: LabelColorSchema.default(null) });

export const UpdateLabelSchema = z
	.object({ name: LabelNameSchema, parent: OwnLabelKey.nullable(), color: LabelColorSchema, position: z.number().finite(), hidden: z.boolean() })
	.partial() satisfies z.ZodType<LabelChange>;

/** Stops or resumes sharing a file sent as a link. The link itself never changes. */
export const ShareLinkSchema = z.object({ shared: z.boolean() });

/** Markdown, like the note it's added to. Empty clears it. */
export const SignatureSchema = z.object({
	address: z.email(),
	text: z.string().max(MAX_SIGNATURE),
});

/**
 * Every shortcut someone has rebound (Me["hotkeys"]), replacing what was saved. Bounded rather than checked against
 * the app's list, which the browser checks when it loads them; one it doesn't know is dropped there.
 */
export const HotkeysSchema = z.object({
	hotkeys: z.record(z.string().max(64), z.union([z.string().min(1).max(64), z.array(z.string().min(1).max(64)).min(1).max(8), z.null()])).refine((h) => Object.keys(h).length <= 100, "Too many shortcuts"),
}) satisfies z.ZodType<{ hotkeys: CustomHotkeys }>;

/** A banner's answer about one message's sender (Mailbox.judgeMessage()). */
export const JudgeSchema = z.object({ verdict: z.enum(["trusted", "spam"]) });

/** A change to some of a mailbox's MailSettings; what it leaves out stays as it is. */
export const MailSettingsSchema = z.object({ screener: z.boolean(), outreachToSpam: z.boolean() }).partial() satisfies z.ZodType<Partial<MailSettings>>;

export const MarkReadSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	read: z.boolean(),
});

const RuleValue = z.string().trim().min(1, "Say what to look for").max(200);

export const RuleConditionSchema = z.union([
	z.object({ field: z.enum(RULE_TEXT_FIELDS), op: z.enum(RULE_TEXT_OPS), value: RuleValue, not: z.boolean().optional() }),
	z
		.object({
			field: z.literal("header"),
			// A header's name as RFC 5322 has it: printable characters but the colon.
			name: z.string().trim().toLowerCase().regex(/^[!-9;-~]{1,100}$/, "Not a header's name"),
			op: z.enum([...RULE_TEXT_OPS, "exists"]),
			value: RuleValue.optional(),
			not: z.boolean().optional(),
		})
		.refine((c) => c.op === "exists" || c.value !== undefined, { message: "Say what to look for", path: ["value"] }),
	z.object({ field: z.enum(RULE_FLAGS), not: z.boolean().optional() }),
]) satisfies z.ZodType<RuleCondition>;

export const RuleActionSchema = z.union([
	z.object({ do: z.literal("label"), label: OwnLabelKey }),
	z.object({ do: z.enum(["skip-inbox", "star", "mark-read", "spam", "trash"]) }),
]) satisfies z.ZodType<RuleAction>;

/** A rule as someone writes it. Which labels it names exist, and how many rules a mailbox has, the mailbox checks. */
export const RuleInputSchema = z
	.object({
		name: z.string().trim().min(1, "Name it").max(100),
		enabled: z.boolean().default(true),
		match: z.enum(["all", "any"]).default("all"),
		conditions: z.array(RuleConditionSchema).max(20).default([]),
		ai: z.string().trim().min(1).max(500).nullable().default(null),
		actions: z.array(RuleActionSchema).min(1, "Say what it does").max(10),
		stop: z.boolean().default(false),
	})
	.refine((r) => r.conditions.length > 0 || r.ai !== null, "Give it a condition")
	// Each thing once: the same label twice, or Spam twice, says nothing more.
	.refine((r) => new Set(r.actions.map((a) => (a.do === "label" ? `label:${a.label}` : a.do))).size === r.actions.length, "It does that twice") satisfies z.ZodType<RuleInput>;

/** Every rule of a mailbox, in the order they run. */
export const RuleOrderSchema = z.object({ ids: z.array(z.string()).max(MAX_RULES) });

/** How much of a conversation with the mail agent the app sends back, at most (worker/agent.ts bounds what it says). */
export const MAX_AGENT_MESSAGES = 40;
export const MAX_AGENT_QUESTION = 4000;
/** Characters of the agent's own text, and of a call's arguments, that it can send back. */
export const MAX_AGENT_TEXT = 10_000;
export const MAX_AGENT_ARGUMENTS = 20_000;
const AgentId = z.string().min(1).max(200);

/** What the model reads of each message: the panel's own parts of a tool's (AgentMessage) are dropped. */
const AgentMessageSchema = z.discriminatedUnion("role", [
	z.object({ role: z.literal("user"), content: z.string().trim().min(1).max(MAX_AGENT_QUESTION) }),
	z.object({
		role: z.literal("assistant"),
		content: z.string().max(MAX_AGENT_TEXT),
		toolCalls: z.array(z.object({ id: AgentId, name: z.string().max(64), arguments: z.string().max(MAX_AGENT_ARGUMENTS) })).max(10).optional(),
	}),
	z.object({ role: z.literal("tool"), toolCallId: AgentId, content: z.string().max(60_000) }),
]);

export const AgentRequestSchema = z.object({
	messages: z.array(AgentMessageSchema).min(1).max(MAX_AGENT_MESSAGES),
	/** The conversation open beside the panel, if any. */
	context: z.object({ mailboxId: AgentId, threadId: AgentId }).nullable().default(null),
});

/** A PendingAction the person approved, which is checked again as if the model had just asked for it. */
export const AgentApproveSchema = z.object({ action: z.object({ id: AgentId, name: z.string().max(64), args: z.record(z.string(), z.unknown()) }) });

/** `bytes` long once decoded, as a browser writes a subscription's keys. */
const base64url = (bytes: number, check: (decoded: Uint8Array) => boolean = () => true) =>
	z
		.string()
		.regex(/^[A-Za-z0-9_-]+={0,2}$/)
		.refine((text) => {
			let decoded: Uint8Array;
			try {
				decoded = fromBase64Url(text);
			} catch {
				// Not base64 at all, which makes it invalid rather than an error.
				return false;
			}
			return decoded.length === bytes && check(decoded);
		}, `Expected ${bytes} bytes`);

/**
 * A browser's push subscription (PushSubscription.toJSON()). The Worker posts to the endpoint, so it has to be an
 * https URL of bounded length.
 */
export const PushSubscriptionSchema = z.object({
	endpoint: z.url({ protocol: /^https$/ }).max(2048),
	keys: z.object({
		/** An uncompressed P-256 point. */
		p256dh: base64url(65, (point) => point[0] === 4),
		auth: base64url(16),
	}),
});
