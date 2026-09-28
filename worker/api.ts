import { zValidator } from "@hono/zod-validator";
import {
	canMatch,
	interleave,
	localRecipients,
	type MailboxQuery,
	type MailboxThread,
	mergeByRecency,
	mergeCounts,
	normalizeAddress,
	planScope,
	r2Keys,
	type SendAttachmentRef,
	type ThreadSummary,
	type User,
} from "#shared";
import { ComposeSchema, MarkReadSchema, MAX_OUTBOUND_BYTES, ModifyThreadsSchema } from "#shared/schemas";
import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import { admin } from "./admin";
import { auth, currentUser, googleEnabled } from "./auth";
import { CloudflareError } from "./cloudflare";
import { getSendIdentities, getUserMailboxes, isMailboxMember, resolveRecipient } from "./directory";
import { attachmentHeaders, renderEmailHtml } from "./html";
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

// Session cookies ride along on any request to this origin, so refuse ones another origin started
// (form posts, WebSocket upgrades). Browsers always send Origin on those; same-origin GETs may omit it.
app.use("*", async (c, next) => {
	const origin = c.req.header("Origin");
	if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin request refused" }, 403);
	await next();
});

/** What the app needs before anyone signs in: whether to show /setup, and which sign-in options exist. */
app.get("/config", async (c) => c.json({ setupRequired: !(await getInstall(c.env.DIRECTORY)), google: googleEnabled() }));

app.route("/setup", setup);

app.use("*", async (c, next) => {
	const signedIn = await currentUser(c.req.raw);
	if (!signedIn) return c.json({ error: "Unauthenticated" }, 401);
	c.set("user", signedIn.user);
	await next();
	for (const cookie of signedIn.cookies) c.res.headers.append("Set-Cookie", cookie);
});

app.route("/admin", admin);

app.get("/me", async (c) => {
	const user = c.var.user;
	return c.json({ user, mailboxes: await getUserMailboxes(c.env.DIRECTORY, user.id) });
});

// ─── Views across mailboxes ─────────────────────────────────────────────────
// Lists, search, and counts span every mailbox the user belongs to. `?in=a@x.com,b@y.com`
// narrows them to some of the user's addresses. Everything else stays mailbox-scoped below.

const PAGE = 50;

async function planRequest(c: Context<AppEnv>): Promise<MailboxQuery[]> {
	const mailboxes = await getUserMailboxes(c.env.DIRECTORY, c.var.user.id);
	const selected = (c.req.query("in") ?? "").split(",").map(normalizeAddress).filter(Boolean);
	return planScope(
		mailboxes.map((m) => ({ id: m.id, addresses: m.addresses.map((a) => a.address) })),
		selected,
	);
}

/** Reads threads from every mailbox the request can match, tagging each with where it lives. */
async function readThreads(
	c: Context<AppEnv>,
	read: (stub: MailboxStub, q: MailboxQuery) => Promise<ThreadSummary[]>,
): Promise<MailboxThread[][]> {
	const queries = (await planRequest(c)).filter(canMatch);
	return Promise.all(
		queries.map(async (q) => (await read(c.env.MAILBOX.getByName(q.mailboxId), q)).map((t) => ({ ...t, mailboxId: q.mailboxId }))),
	);
}

app.get("/threads", async (c) => {
	const label = c.req.query("label") ?? "inbox";
	const before = c.req.query("before");
	const lists = await readThreads(c, (stub, q) =>
		stub.listThreads({ label, before: before ? Number(before) : undefined, limit: PAGE, addresses: q.addresses }),
	);
	return c.json({ threads: mergeByRecency(lists, PAGE) });
});

app.get("/search", async (c) => {
	const query = c.req.query("q")?.trim() ?? "";
	if (!query) return c.json({ threads: [] });
	const lists = await readThreads(c, (stub, q) => stub.search({ query, limit: PAGE, addresses: q.addresses }));
	return c.json({ threads: interleave(lists, PAGE) });
});

// Every mailbox, not just matching ones: per-address unread counts cover all of the user's addresses.
app.get("/counts", async (c) => {
	const queries = await planRequest(c);
	const parts = await Promise.all(queries.map((q) => c.env.MAILBOX.getByName(q.mailboxId).counts({ addresses: q.addresses })));
	return c.json(mergeCounts(parts));
});

// ─── Mailbox-scoped routes ──────────────────────────────────────────────────

const mb = new Hono<AppEnv>();

mb.use("*", async (c, next) => {
	const mailboxId = c.req.param("mailboxId");
	if (!mailboxId || !(await isMailboxMember(c.env.DIRECTORY, c.var.user.id, mailboxId))) {
		return c.json({ error: "Not found" }, 404);
	}
	c.set("mailboxId", mailboxId);
	c.set("mailbox", c.env.MAILBOX.getByName(mailboxId));
	await next();
});

mb.get("/threads/:threadId", async (c) => {
	const detail = await c.var.mailbox.getThread(c.req.param("threadId"));
	return detail ? c.json(detail) : c.json({ error: "Not found" }, 404);
});

mb.post("/threads/modify", zValidator("json", ModifyThreadsSchema), async (c) => {
	await c.var.mailbox.modifyThreads(c.req.valid("json"));
	return c.body(null, 204);
});

mb.post("/threads/read", zValidator("json", MarkReadSchema), async (c) => {
	await c.var.mailbox.markRead(c.req.valid("json"));
	return c.body(null, 204);
});

mb.get("/messages/:messageId/body", async (c) => {
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
});

mb.get("/messages/:messageId/attachments/:attachmentId", async (c) => {
	const blobs = await c.var.mailbox.getMessageBlobs(c.req.param("messageId"));
	const att = blobs?.attachments.find((a) => a.id === c.req.param("attachmentId"));
	if (!att) return c.json({ error: "Not found" }, 404);
	const obj = await c.env.MAIL.get(att.r2Key);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return new Response(obj.body, { headers: attachmentHeaders(att, c.req.query("download") === "1") });
});

mb.get("/messages/:messageId/raw", async (c) => {
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
});

/** Composer attachment upload: raw body, filename in X-Filename (URI-encoded). */
mb.post("/uploads", async (c) => {
	const length = Number(c.req.header("Content-Length") ?? 0);
	if (!length) return c.json({ error: "Content-Length required" }, 411);
	if (length >= MAX_OUTBOUND_BYTES) return c.json({ error: "Attachments are limited to 5 MiB per message" }, 413);
	const body = c.req.raw.body;
	if (!body) return c.json({ error: "Empty body" }, 400);

	const filename = decodeURIComponent(c.req.header("X-Filename") ?? "attachment").slice(0, 255);
	const contentType = c.req.header("Content-Type") || "application/octet-stream";
	const r2Key = r2Keys.upload(c.var.mailboxId, crypto.randomUUID());
	const obj = await c.env.MAIL.put(r2Key, body, { httpMetadata: { contentType }, customMetadata: { filename } });
	const ref: SendAttachmentRef = { r2Key, filename, contentType, size: obj.size };
	return c.json(ref, 201);
});

mb.post("/send", zValidator("json", ComposeSchema), async (c) => {
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
	const bodyBytes = new TextEncoder().encode(req.text + (req.html ?? "")).length;
	if (bodyBytes + attachments.reduce((n, a) => n + a.size, 0) >= MAX_OUTBOUND_BYTES) {
		return c.json({ error: "Message exceeds the 5 MiB outbound limit" }, 413);
	}

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
		attachments,
		delayMs: req.delaySeconds * 1000,
		localRecipients: local,
		localOnly: local.length === recipients.length,
	});
	return c.json(queued, 202);
});

mb.post("/outbox/:messageId/cancel", async (c) => {
	const cancelled = await c.var.mailbox.cancelSend(c.req.param("messageId"));
	return cancelled ? c.body(null, 204) : c.json({ error: "Already sent" }, 409);
});

/** Live updates: the WebSocket terminates in the Mailbox DO (hibernatable). */
mb.get("/live", async (c) => {
	if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "Expected WebSocket" }, 426);
	return c.var.mailbox.fetch(c.req.raw);
});

app.route("/mailboxes/:mailboxId", mb);

app.all("*", (c) => c.json({ error: "Not found" }, 404));
