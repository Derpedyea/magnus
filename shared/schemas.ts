import { z } from "zod";
import { MAX_SIGNATURE } from "./directory";

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

export const ModifyThreadsSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	add: z.array(z.string().min(1).max(64)).default([]),
	remove: z.array(z.string().min(1).max(64)).default([]),
});

/** Stops or resumes sharing a file sent as a link. The link itself never changes. */
export const ShareLinkSchema = z.object({ shared: z.boolean() });

/** Markdown, like the note it's added to. Empty clears it. */
export const SignatureSchema = z.object({
	address: z.email(),
	text: z.string().max(MAX_SIGNATURE),
});

export const MarkReadSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	read: z.boolean(),
});
