import { z } from "zod";
import { AttachmentRefSchema, MAX_ATTACHMENTS, MAX_RECIPIENTS } from "./schemas";

// Drafts accept unfinished recipients; sending still uses ComposeSchema's email validation.
const Recipient = z.object({ address: z.string().max(320), name: z.string().max(200).optional() });
const File = z.object({
	id: z.string(), filename: z.string(), contentType: z.string(), size: z.number().nonnegative(),
	contentId: z.string().nullable(), inline: z.boolean(), link: z.object({ token: z.string(), shared: z.boolean() }).nullable(),
});

export const DraftSchema = z.object({
	mailboxId: z.string().min(1).max(200),
	from: z.string().max(320),
	to: z.array(Recipient).max(MAX_RECIPIENTS),
	cc: z.array(Recipient).max(MAX_RECIPIENTS),
	bcc: z.array(Recipient).max(MAX_RECIPIENTS),
	/** Recipient text not yet committed to a chip (including unfinished addresses). */
	recipientInputs: z.object({ to: z.string().max(10_000), cc: z.string().max(10_000), bcc: z.string().max(10_000) }).optional(),
	subject: z.string().max(998),
	text: z.string().max(1_000_000),
	attachments: z.array(AttachmentRefSchema).max(MAX_ATTACHMENTS),
	replyToMessageId: z.string().optional(),
	// Keep the preview too: a saved forward remains readable if its original has since been removed.
	forward: z.object({
		message: z.object({ id: z.string(), from: Recipient, date: z.number(), text: z.string().nullable(), hasHtml: z.boolean(), attachments: z.array(File) }),
		files: z.array(File).max(MAX_ATTACHMENTS),
	}).optional(),
});

export type Draft = z.infer<typeof DraftSchema>;
export const SaveDraftSchema = z.object({ revision: z.number().int().nonnegative(), changeId: z.uuid(), content: DraftSchema });
export type DraftWrite = z.infer<typeof SaveDraftSchema>;
export const DraftRevisionSchema = z.object({ revision: z.number().int().nonnegative() });
export const DraftIdSchema = z.uuid();

export interface SavedDraft {
	id: string;
	revision: number;
	changeId: string;
	updatedAt: number;
	content: Draft;
	state: "active" | "sending";
}

/** An untouched composer containing only a signature isn't a draft yet. */
export function hasDraftContent(draft: Draft, initial: Draft): boolean {
	return Boolean(draft.to.length || draft.cc.length || draft.bcc.length || Object.values(draft.recipientInputs ?? {}).some((input) => input.trim()) || draft.subject.trim() || draft.attachments.length || draft.forward || draft.replyToMessageId || draft.text.trim() !== initial.text.trim());
}
