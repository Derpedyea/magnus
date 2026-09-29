import { zValidator } from "@hono/zod-validator";
import {
	canMatch,
	formatBytes,
	forwardedPart,
	type ListCursor,
	type ListPage,
	type LocalRecipient,
	localRecipients,
	type MailboxQuery,
	MAX_UPLOAD_BYTES,
	type MessageBody,
	mergeContacts,
	mergeCounts,
	mergePage,
	normalizeAddress,
	parseCursor,
	planAttachments,
	planScope,
	r2Keys,
	type SendAttachmentRef,
	type ThreadSummary,
	type User,
	withForward,
} from "#shared";
import { ComposeSchema, MarkReadSchema, MAX_ATTACHMENTS, ModifyThreadsSchema, ShareLinkSchema, SignatureSchema } from "#shared/schemas";
import { isAPIError } from "better-auth/api";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { admin } from "./admin";
import { auth, currentUser, googleEnabled } from "./auth";
import { CloudflareError } from "./cloudflare";
import { getSendIdentities, getUserMailboxes, isMailboxMember, resolveRecipient, setSignature } from "./directory";
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
/** Enough to find anyone by typing, small enough to send whole so matching needs no round trip. */
const CONTACTS = 1000;

const ScopeQuery = z.object({ in: z.string().optional() });
/** `cursor` is a previous page's `next`; without one (or with a malformed one) a list starts at the top. */
const PageQuery = ScopeQuery.extend({ cursor: z.string().optional().transform(parseCursor) });
const ThreadsQuery = PageQuery.extend({ label: z.string().default("inbox") });
const SearchQuery = PageQuery.extend({ q: z.string().trim().default("") });

async function planRequest(c: Context<AppEnv>, scope = ""): Promise<MailboxQuery[]> {
	const mailboxes = await getUserMailboxes(c.env.DIRECTORY, c.var.user.id);
	const selected = scope.split(",").map(normalizeAddress).filter(Boolean);
	return planScope(
		mailboxes.map((m) => ({ id: m.id, addresses: m.addresses.map((a) => a.address) })),
		selected,
	);
}

/** A page of threads from every mailbox the request can match, each tagged with where it lives. */
async function readPage(
	c: Context<AppEnv>,
	scope: string | undefined,
	before: ListCursor | undefined,
	read: (stub: MailboxStub, q: MailboxQuery, page: ListPage) => Promise<ThreadSummary[]>,
) {
	const page = { before, limit: PAGE + 1 };
	const queries = (await planRequest(c, scope)).filter(canMatch);
	const lists = await Promise.all(
		queries.map(async (q) => (await read(c.env.MAILBOX.getByName(q.mailboxId), q, page)).map((t) => ({ ...t, mailboxId: q.mailboxId }))),
	);
	return mergePage(lists, PAGE);
}

const views = new Hono<AppEnv>()
	.get("/threads", zValidator("query", ThreadsQuery), async (c) => {
		const { label, cursor, in: scope } = c.req.valid("query");
		return c.json(await readPage(c, scope, cursor, (stub, q, page) => stub.listThreads({ label, ...page, addresses: q.addresses })));
	})

	.get("/search", zValidator("query", SearchQuery), async (c) => {
		const { q: query, cursor, in: scope } = c.req.valid("query");
		if (!query) return c.json({ threads: [], next: null });
		return c.json(await readPage(c, scope, cursor, (stub, q, page) => stub.search({ query, ...page, addresses: q.addresses })));
	})

	// Every mailbox, not just matching ones: per-address unread counts cover all of the user's addresses.
	.get("/counts", zValidator("query", ScopeQuery), async (c) => {
		const queries = await planRequest(c, c.req.valid("query").in);
		const parts = await Promise.all(queries.map((q) => c.env.MAILBOX.getByName(q.mailboxId).counts({ addresses: q.addresses })));
		return c.json(mergeCounts(parts));
	})

	/** Everyone the user's mailboxes have written to or heard from, best first, for the composer to suggest. */
	.get("/contacts", async (c) => {
		const queries = await planRequest(c);
		const lists = await Promise.all(queries.map((q) => c.env.MAILBOX.getByName(q.mailboxId).contacts(CONTACTS)));
		return c.json({ contacts: mergeContacts(lists, CONTACTS) });
	});

// ─── Mailbox-scoped routes ──────────────────────────────────────────────────

/** The identity this mailbox sends `from` as, if it may. */
async function sendIdentity(c: Context<AppEnv>, from: string) {
	const identities = await getSendIdentities(c.env.DIRECTORY, c.var.mailboxId);
	return identities.find((i) => i.address === normalizeAddress(from));
}

/** Of these normalized recipients, the ones a send from `from` delivers by itself (see localRecipients()). */
async function localTo(c: Context<AppEnv>, from: string, recipients: string[]): Promise<LocalRecipient[]> {
	const routed = await Promise.all(
		recipients.map(async (address) => ({ address, route: await resolveRecipient(c.env.DIRECTORY, [from], address) })),
	);
	return localRecipients(routed, c.var.mailboxId);
}

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

		const identity = await sendIdentity(c, req.from);
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

		// A forward carries the original below the note, with the files picked from it and the images its HTML shows.
		let forward: MessageBody | undefined;
		const embedded: SendAttachmentRef[] = [];
		if (req.forward) {
			const original = await c.var.mailbox.getMessage(req.forward.messageId);
			if (!original) return c.json({ error: "The message to forward is gone" }, 404);
			const files = original.blobs.attachments;
			if (req.forward.attachmentIds.some((id) => !files.some((a) => a.id === id && !a.inline))) return c.json({ error: "Unknown attachment" }, 400);
			const kept = new Set(req.forward.attachmentIds);
			const html = original.blobs.htmlKey ? ((await (await c.env.MAIL.get(original.blobs.htmlKey))?.text()) ?? null) : null;
			const cids = html?.toLowerCase() ?? "";
			for (const a of files) {
				// The renderer resolves cid: against every part, whatever its disposition, so the HTML can show a listed file too.
				const shown = a.contentId !== null && cids.includes(`cid:${a.contentId.toLowerCase()}`);
				if (!(a.inline ? shown : kept.has(a.id))) continue;
				// A message keeps its files in uploads/ until its send copies them out and deletes the uploads, which would break this forward.
				if (a.r2Key.startsWith(uploadPrefix)) return c.json({ error: "Its files are still being sent. Try again in a moment." }, 409);
				const ref = { r2Key: a.r2Key, filename: a.filename, contentType: a.contentType, size: a.size };
				if (a.contentId && shown) embedded.push({ ...ref, contentId: a.contentId });
				else attachments.push(ref);
			}
			forward = forwardedPart({ ...original.message, html }, req.forward.timeZone);
		}

		const linkBase = `${new URL(c.req.url).origin}/f/${c.var.mailboxId}/`;
		const body = forward ? withForward(req, forward) : req;
		const embeddedBytes = embedded.reduce((n, a) => n + a.size, 0);
		const { attached, linked, fits } = planAttachments(attachments, body, linkBase, embeddedBytes);
		if (!fits) return c.json({ error: "Message is too long to send" }, 413);
		// The schema counts uploads and kept files; a forward's images add parts that can't become links.
		if (attached.length + embedded.length > MAX_ATTACHMENTS) {
			return c.json({ error: `At most ${MAX_ATTACHMENTS} attachments, counting the forwarded message's images` }, 400);
		}

		const recipients = [...new Set([...req.to, ...req.cc, ...req.bcc].map((a) => normalizeAddress(a.address)))];
		const local = await localTo(c, identity.address, recipients);

		const queued = await c.var.mailbox.enqueueSend({
			mailboxId: c.var.mailboxId,
			from: { address: identity.address, name: identity.displayName ?? c.var.user.name },
			to: req.to,
			cc: req.cc,
			bcc: req.bcc,
			subject: req.subject,
			text: req.text,
			html: req.html,
			parentMessageId: req.replyToMessageId ?? req.forward?.messageId,
			forward,
			attachments: [...attached, ...embedded],
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

	/** Sends a failed or bounced message again, to whoever it didn't reach. The sender is checked again first. */
	.post("/messages/:messageId/retry", async (c) => {
		const messageId = c.req.param("messageId");
		const target = await c.var.mailbox.retryTarget(messageId);
		if (!target) return c.json({ error: "Nothing to retry" }, 409);
		const identity = await sendIdentity(c, target.from);
		if (!identity) return c.json({ error: `This mailbox can't send as ${target.from}` }, 403);
		const local = await localTo(c, identity.address, target.recipients);
		return (await c.var.mailbox.retrySend(messageId, local)) ? c.body(null, 204) : c.json({ error: "Nothing to retry" }, 409);
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

	/** Your signature for one of the addresses you send as. /me returns them. */
	.put("/signatures", zValidator("json", SignatureSchema), async (c) => {
		const { text } = c.req.valid("json");
		const address = normalizeAddress(c.req.valid("json").address);
		const mailboxes = await getUserMailboxes(c.env.DIRECTORY, c.var.user.id);
		if (!mailboxes.some((m) => m.addresses.some((a) => a.address === address && a.canSend))) return c.json({ error: `You can't send as ${address}` }, 403);
		return c.json({ signature: await setSignature(c.env.DIRECTORY, c.var.user.id, address, text) });
	})

	.route("/", views)
	.route("/mailboxes/:mailboxId", mb);

/** Every route the app calls, for its typed client (src/api.ts). */
export type AppType = typeof routes;

app.all("*", (c) => c.json({ error: "Not found" }, 404));
