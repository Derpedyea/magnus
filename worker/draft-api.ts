import { zValidator } from "@hono/zod-validator";
import { DraftIdSchema, DraftRevisionSchema, SaveDraftSchema } from "#shared/drafts";
import { r2Keys } from "#shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "./api";
import { getUserMailboxes, isMailboxMember } from "./directory";
import { discardDraft, listDrafts, readDraft, saveDraft, toSavedDraft } from "./drafts";

export const draftRoutes = new Hono<AppEnv>()
	.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: "Draft is too large to save" }, 413) }))
	.use("/:id", async (c, next) => {
		if (!DraftIdSchema.safeParse(c.req.param("id")).success) return c.json({ error: "Not found" }, 404);
		await next();
	})
	.get("/", async (c) => c.json({ drafts: await listDrafts(c.env.DIRECTORY, c.var.user.id) }))
	.get("/:id", async (c) => {
		const row = await readDraft(c.env.DIRECTORY, c.var.user.id, c.req.param("id"));
		if (!row || !(await isMailboxMember(c.env.DIRECTORY, c.var.user.id, row.mailbox_id))) return c.json({ error: "Not found" }, 404);
		if (row.state !== "active" && row.state !== "sending") return c.json({ error: "This draft was sent or discarded" }, 410);
		return c.json(toSavedDraft(row));
	})
	.put("/:id", zValidator("json", SaveDraftSchema), async (c) => {
		const write = c.req.valid("json");
		const mailboxes = await getUserMailboxes(c.env.DIRECTORY, c.var.user.id);
		const mailbox = mailboxes.find((m) => m.id === write.content.mailboxId);
		if (!mailbox) return c.json({ error: "Not found" }, 404);
		if (write.content.from && !mailbox.addresses.some((a) => a.address === write.content.from && a.canSend)) return c.json({ error: "This From address is no longer available" }, 403);
		const prefix = r2Keys.draftFile(mailbox.id, c.var.user.id, "");
		for (const file of write.content.attachments) {
			if (!file.r2Key.startsWith(prefix)) return c.json({ error: "Unknown draft attachment" }, 400);
			const head = await c.env.MAIL.head(file.r2Key);
			if (!head || head.size !== file.size) return c.json({ error: `Attachment missing: ${file.filename}` }, 400);
		}
		const saved = await saveDraft(c.env.DIRECTORY, c.var.user.id, c.req.param("id"), write, Date.now());
		return saved ? c.json(saved) : c.json({ error: "This draft changed on another device, was sent, or was discarded. Save a copy to keep these edits." }, 409);
	})
	.delete("/:id", zValidator("json", DraftRevisionSchema), async (c) => {
		const row = await readDraft(c.env.DIRECTORY, c.var.user.id, c.req.param("id"));
		if (!row || !(await isMailboxMember(c.env.DIRECTORY, c.var.user.id, row.mailbox_id))) return c.json({ error: "Not found" }, 404);
		const discarded = await discardDraft(c.env.DIRECTORY, c.var.user.id, row.id, c.req.valid("json").revision);
		return discarded ? c.body(null, 204) : c.json({ error: "This draft changed on another device or is being sent" }, 409);
	});
