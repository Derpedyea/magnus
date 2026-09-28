import { z } from "zod";

/** Email Service: to + cc + bcc combined. */
export const MAX_RECIPIENTS = 50;
/** Email Service: total outbound message size (body + attachments) for non-verified recipients. */
export const MAX_OUTBOUND_BYTES = 5 * 1024 * 1024;
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
		text: z.string(),
		html: z.string().optional(),
		replyToMessageId: z.string().optional(),
		attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS).default([]),
		/** Undo window. 0 sends on the next alarm tick; larger values are scheduled send. */
		delaySeconds: z.number().int().min(0).max(7 * 24 * 3600).default(10),
	})
	.refine((c) => c.to.length + c.cc.length + c.bcc.length <= MAX_RECIPIENTS, {
		message: `At most ${MAX_RECIPIENTS} recipients (to + cc + bcc)`,
	})
	.refine((c) => c.attachments.reduce((n, a) => n + a.size, 0) < MAX_OUTBOUND_BYTES, {
		message: "Attachments exceed the 5 MiB outbound limit",
	});

export type ComposeRequest = z.infer<typeof ComposeSchema>;

export const ModifyThreadsSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	add: z.array(z.string().min(1).max(64)).default([]),
	remove: z.array(z.string().min(1).max(64)).default([]),
});

export const MarkReadSchema = z.object({
	threadIds: z.array(z.string()).min(1).max(500),
	read: z.boolean(),
});
