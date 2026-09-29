import { zValidator } from "@hono/zod-validator";
import {
	canMatch,
	formatBytes,
	interleave,
	localRecipients,
	type MailboxQuery,
	type MailboxThread,
	MAX_UPLOAD_BYTES,
	mergeByRecency,
	mergeCounts,
	normalizeAddress,
	planAttachments,
	planScope,
	r2Keys,
	type SendAttachmentRef,
	type ThreadSummary,
	type User,
} from "#shared";
import { ComposeSchema, MarkReadSchema, ModifyThreadsSchema, ShareLinkSchema } from "#shared/schemas";
import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { admin } from "./admin";
import { auth, currentUser, googleEnabled } from "./auth";
import { CloudflareError } from "./cloudflare";
import { getSendIdentities, getUserMailboxes, isMailboxMember, resolveRecipient } from "./directory";
import { fileHeaders, renderEmailHtml, serveFile } from "./html";
import type { Mailbox } from "./mailbox/mailbox";
import { getInstall } from "./settings";
import { setup } from "./setup";

type MailboxStub = DurableObjectStub<Mailbox>;

export type AppEnv = {
	Bindings: Env;
	Variables: { user: User; mailboxId: string; mailbox: MailboxStub };
};

export const app = new Hono<AppEnv>().basePath("/api");

app.onError((err, c) => {
	// Worded for people already: a Cloudflare API refusal, or Better Auth turning something down.
	if (err instanceof CloudflareError) return c.json({ error: err.message }, 400);
	if (isAPIError(err)) return Response.json({ error: err.message }, { status: err.statusCode });
	console.error(JSON.stringify({ msg: "unhandled", path: c.req.path, error: String(err), stack: err.stack }));
	return c.json({ error: "Internal error" }, 500);
});

// ─── Auth ───────────────────────────────────────────────────────────────────

// Better Auth's own endpoints: sign-in, the OAuth callback, sign-out, session, admin. It checks origins itself.
app.on(["GET", "POST"], "/auth/*", async (c) => (await auth(c.req.raw)).handler(c.req.raw));

// ─── Views across mailboxes ─────────────────────────────────────────────────
// Lists, search, and counts span every mailbox the user belongs to. `?in=a@x.com,b@y.com`
// narrows them to some of the user's addresses. Everything else stays mailbox-scoped below.

const PAGE = 50;

const ScopeQuery = z.object({ in: z.string().optional() });
const ThreadsQuery = ScopeQuery.extend({ label: z.string().default("inbox"), before: z.coerce.number().optional() });
const SearchQuery = ScopeQuery.extend({ q: z.string().trim().default("") });

async function planRequest(c: Context<AppEnv>, scope = ""): Promise<MailboxQuery[]> {
	const mailboxes = await getUserMailboxes(c.env.DIRECTORY, c.var.user.id);
	const selected = scope.split(",").map(normalizeAddress).filter(Boolean);
	return planScope(
		mailboxes.map((m) => ({ id: m.id, addresses: m.addresses.map((a) => a.address) })),
		selected,
	);
}

/** Reads threads from every mailbox the request can match, tagging each with where it lives. */
async function readThreads(
	c: Context<AppEnv>,
	scope: string | undefined,
	read: (stub: MailboxStub, q: MailboxQuery) => Promise<ThreadSummary[]>,
): Promise<MailboxThread[][]> {
	const queries = (await planRequest(c, scope)).filter(canMatch);
	return Promise.all(
		queries.map(async (q) => (await read(c.env.MAILBOX.getByName(q.mailboxId), q)).map((t) => ({ ...t, mailboxId: q.mailboxId }))),
	);
}

const views = new Hono<AppEnv>()
	.get("/threads", zValidator("query", ThreadsQuery), async (c) => {
		const { label, before, in: scope } = c.req.valid("query");
		const lists = await readThreads(c, scope, (stub, q) => stub.listThreads({ label, before, limit: PAGE, addresses: q.addresses }));
		return c.json({ threads: mergeByRecency(lists, PAGE) });
	})

	.get("/search", zValidator("query", SearchQuery), async (c) => {
		const { q: query, in: scope } = c.req.valid("query");
		if (!query) return c.json({ threads: [] });
		const lists = await readThreads(c, scope, (stub, q) => stub.search({ query, limit: PAGE, addresses: q.addresses }));
		return c.json({ threads: interleave(lists, PAGE) });
	})

	// Every mailbox, not just matching ones: per-address unread counts cover all of the user's addresses.
	.get("/counts", zValidator("query", ScopeQuery), async (c) => {
		const queries = await planRequest(c, c.req.valid("query").in);
		const parts = await Promise.all(queries.map((q) => c.env.MAILBOX.getByName(q.mailboxId).counts({ addresses: q.addresses })));
		return c.json(mergeCounts(parts));
	});

// ─── Mailbox-scoped routes ──────────────────────────────────────────────────

const mb = new Hono<AppEnv>()
	.use("*", async (c, next) => {
		const mailboxId = c.req.param("mailboxId");
		if (!mailboxId || !(await isMailboxMember(c.env.DIRECTORY, c.var.user.id, mailboxId))) {
			return c.json({ error: "Not found" }, 404);
		}
		c.set("mailboxId", mailboxId);
		c.set("mailbox", c.env.MAILBOX.getByName(mailboxId));
		await next();
	})

	.get("/threads/:threadId", async (c) => {
		const detail = await c.var.mailbox.getThread(c.req.param("threadId"));
		return detail ? c.json(detail) : c.json({ error: "Not found" }, 404);
	})

	.post("/threads/modify", zValidator("json", ModifyThreadsSchema), async (c) => {
		await c.var.mailbox.modifyThreads(c.req.valid("json"));
		return c.body(null, 204);
	})

	.post("/threads/read", zValidator("json", MarkReadSchema), async (c) => {
		await c.var.mailbox.markRead(c.req.valid("json"));
		return c.body(null, 204);
	})

	.get("/messages/:messageId/body", async (c) => {
		const messageId = c.req.param("messageId");
		const blobs = await c.var.mailbox.getMessageBlobs(messageId);
		if (!blobs?.htmlKey) return c.json({ error: "Not found" }, 404);
		const obj = await c.env.MAIL.get(blobs.htmlKey);
		if (!obj) return c.json({ error: "Not found" }, 404);
		const base = `/api/mailboxes/${c.var.mailboxId}/messages/${messageId}/attachments`;
		return renderEmailHtml(obj.body, {
			attachments: blobs.attachments,
			attachmentUrl: (id) => `${base}/${id}`,
			allowRemote: c.req.query("images") === "1",
			origin: new URL(c.req.url).origin,
		});
	})

	// The optional name is ignored; it's there so viewers (Chrome's PDF viewer, "Save video as…") show and save it.
	.get("/messages/:messageId/attachments/:attachmentId/:filename?", async (c) => {
		const blobs = await c.var.mailbox.getMessageBlobs(c.req.param("messageId"));
		const att = blobs?.attachments.find((a) => a.id === c.req.param("attachmentId"));
		const file = att && (await serveFile(c.env.MAIL, att.r2Key, c.req.raw, fileHeaders(att, c.req.query("download") === "1")));
		return file || c.json({ error: "Not found" }, 404);
	})

	/** Stops or resumes sharing a file that was sent as a download link. */
	.patch("/messages/:messageId/attachments/:attachmentId", zValidator("json", ShareLinkSchema), async (c) => {
		const { messageId, attachmentId } = c.req.param();
		const ok = await c.var.mailbox.setLinkShared(messageId, attachmentId, c.req.valid("json").shared);
		return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
	})

	.get("/messages/:messageId/raw", async (c) => {
		const messageId = c.req.param("messageId");
		const blobs = await c.var.mailbox.getMessageBlobs(messageId);
		if (!blobs?.rawKey) return c.json({ error: "Not found" }, 404);
		const obj = await c.env.MAIL.get(blobs.rawKey);
		if (!obj) return c.json({ error: "Not found" }, 404);
		return new Response(obj.body, {
			headers: {
				"Content-Type": "message/rfc822",
				"Content-Disposition": `attachment; filename="${messageId}.eml"`,
				"X-Content-Type-Options": "nosniff",
			},
		});
	})

	/** Composer attachment upload: raw body, filename in X-Filename (URI-encoded). Whatever doesn't fit in the message goes as a link. */
	.post("/uploads", async (c) => {
		const length = Number(c.req.header("Content-Length") ?? 0);
		if (!length) return c.json({ error: "Content-Length required" }, 411);
		if (length > MAX_UPLOAD_BYTES) return c.json({ error: `Files are limited to ${formatBytes(MAX_UPLOAD_BYTES)}` }, 413);
		const body = c.req.raw.body;
		if (!body) return c.json({ error: "Empty body" }, 400);

		const filename = decodeURIComponent(c.req.header("X-Filename") ?? "attachment").slice(0, 255);
		const contentType = c.req.header("Content-Type") || "application/octet-stream";
		const r2Key = r2Keys.upload(c.var.mailboxId, crypto.randomUUID());
		const obj = await c.env.MAIL.put(r2Key, body, { httpMetadata: { contentType }, customMetadata: { filename } });
		const ref: SendAttachmentRef = { r2Key, filename, contentType, size: obj.size };
		return c.json(ref, 201);
	})

	.post("/send", zValidator("json", ComposeSchema), async (c) => {
		const req = c.req.valid("json");

		const identities = await getSendIdentities(c.env.DIRECTORY, c.var.mailboxId);
		const identity = identities.find((i) => i.address === normalizeAddress(req.from));
		if (!identity) return c.json({ error: `This mailbox can't send as ${req.from}` }, 403);

		// Only this mailbox's own uploads, with sizes taken from R2 rather than the client.
		const uploadPrefix = r2Keys.upload(c.var.mailboxId, "");
		const attachments: SendAttachmentRef[] = [];
		for (const a of req.attachments) {
			if (!a.r2Key.startsWith(uploadPrefix)) return c.json({ error: "Unknown attachment" }, 400);
			const head = await c.env.MAIL.head(a.r2Key);
			if (!head) return c.json({ error: `Attachment expired: ${a.filename}` }, 400);
			attachments.push({ ...a, size: head.size });
		}
		const linkBase = `${new URL(c.req.url).origin}/f/${c.var.mailboxId}/`;
		const { attached, linked, fits } = planAttachments(attachments, req, linkBase);
		if (!fits) return c.json({ error: "Message is too long to send" }, 413);

		const recipients = [...new Set([...req.to, ...req.cc, ...req.bcc].map((a) => normalizeAddress(a.address)))];
		const routed = await Promise.all(
			recipients.map(async (address) => ({ address, route: await resolveRecipient(c.env.DIRECTORY, identity.address, address) })),
		);
		const local = localRecipients(routed, c.var.mailboxId);

		const queued = await c.var.mailbox.enqueueSend({
			mailboxId: c.var.mailboxId,
			from: { address: identity.address, name: identity.displayName ?? c.var.user.name },
			to: req.to,
			cc: req.cc,
			bcc: req.bcc,
			subject: req.subject,
			text: req.text,
			html: req.html,
			replyToMessageId: req.replyToMessageId,
			attachments: attached,
			links: linked,
			linkBase,
			delayMs: req.delaySeconds * 1000,
			localRecipients: local,
			localOnly: local.length === recipients.length,
		});
		return c.json(queued, 202);
	})

	.post("/outbox/:messageId/cancel", async (c) => {
		const cancelled = await c.var.mailbox.cancelSend(c.req.param("messageId"));
		return cancelled ? c.body(null, 204) : c.json({ error: "Already sent" }, 409);
	})

	/** Live updates: the WebSocket terminates in the Mailbox DO (hibernatable). */
	.get("/live", async (c) => {
		if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected WebSocket" }, 426);
		return c.var.mailbox.fetch(c.req.raw);
	});

// ─── What the app calls ─────────────────────────────────────────────────────

const routes = app
	// Session cookies ride along on any request to this origin, so refuse ones another origin started
	// (form posts, WebSocket upgrades). Browsers always send Origin on those; same-origin GETs may omit it.
	.use(async (c, next) => {
		const origin = c.req.header("Origin");
		if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin request refused" }, 403);
		await next();
	})

	/** What the app needs before anyone signs in: whether to show /setup, and which sign-in options exist. */
	.get("/config", async (c) => c.json({ setupRequired: !(await getInstall(c.env.DIRECTORY)), google: googleEnabled() }))

	.route("/setup", setup)

	.use(async (c, next) => {
		const signedIn = await currentUser(c.req.raw);
		if (!signedIn) return c.json({ error: "Unauthenticated" }, 401);
		c.set("user", signedIn.user);
		await next();
		for (const cookie of signedIn.cookies) c.res.headers.append("Set-Cookie", cookie);
	})

	.route("/admin", admin)

	.get("/me", async (c) => {
		const user = c.var.user;
		return c.json({ user, mailboxes: await getUserMailboxes(c.env.DIRECTORY, user.id) });
	})

	.route("/", views)
	.route("/mailboxes/:mailboxId", mb);

/** Every route the app calls, for its typed client (src/api.ts). */
export type AppType = typeof routes;

app.all("*", (c) => c.json({ error: "Not found" }, 404));
