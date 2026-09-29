import { DurableObject } from "cloudflare:workers";
import {
	type Address,
	type AddressFilter,
	ALL_MAIL,
	type AttachmentMeta,
	buildReferences,
	type Contact,
	type Counts,
	type DeliveryEventInput,
	type DeliveryStatus,
	type IngestInput,
	isValidAddress,
	type LiveEvent,
	type LocalRecipient,
	type MessageBlobs,
	type MessageDetail,
	makeSnippet,
	newLinkToken,
	normalizeAddress,
	normalizeSubject,
	r2Keys,
	type SendAttachmentRef,
	type SendInput,
	type SendQueued,
	type StoredAttachment,
	stripSubaddress,
	type ThreadDetail,
	type ThreadSummary,
	ulid,
	withLinks,
} from "#shared";
import { MIGRATIONS } from "./schema";

const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_SEND_ATTEMPTS = 8;
const OUTBOX_BATCH = 10;
const MAX_PARTICIPANTS = 12;

/** Email Sending error codes worth retrying. Everything else is a permanent failure. */
const TRANSIENT_SEND_ERRORS = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED"]);

interface OutboxPayload {
	from: Address;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	subject: string;
	text: string;
	html?: string;
	headers: Record<string, string>;
	attachments: StoredAttachment[];
	// Optional so rows queued before local delivery existed still go out through Email Sending.
	localRecipients?: LocalRecipient[];
	localOnly?: boolean;
}

type Row = Record<string, SqlStorageValue>;

interface ThreadRow extends Row {
	id: string;
	subject: string;
	snippet: string;
	last_message_at: number;
	participants: string;
	message_count: number;
	unread_count: number;
	labels: string;
	addresses: string;
}

interface MessageRow extends Row {
	id: string;
	thread_id: string;
	direction: "in" | "out";
	message_id_header: string | null;
	refs: string;
	from_json: string;
	to_json: string;
	cc_json: string;
	reply_to_json: string;
	subject: string;
	date: number;
	text_body: string | null;
	html_key: string | null;
	raw_key: string | null;
	is_read: number;
	auth_json: string | null;
	delivery_status: DeliveryStatus | null;
	delivery_detail: string | null;
	labels: string;
}

interface ContactRow extends Row, Contact {}

interface AttachmentRow extends Row {
	id: string;
	message_id: string;
	filename: string;
	content_type: string;
	size: number;
	content_id: string | null;
	inline: number;
	r2_key: string;
	link_token: string | null;
	link_stopped: number;
}

const THREAD_SELECT = `
	SELECT t.id, t.subject, t.snippet, t.last_message_at, t.participants,
		(SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count,
		(SELECT count(*) FROM messages m WHERE m.thread_id = t.id AND m.is_read = 0) AS unread_count,
		(SELECT json_group_array(DISTINCT l.label) FROM messages m
			JOIN message_labels l ON l.message_id = m.id WHERE m.thread_id = t.id) AS labels,
		(SELECT json_group_array(DISTINCT a.address) FROM messages m
			JOIN message_addresses a ON a.message_id = m.id WHERE m.thread_id = t.id) AS addresses
	FROM threads t`;

/** Predicate on message alias `m`: NULL = any message, else a JSON array of addresses it must belong to. */
const IN_ADDRESSES = (param: string) =>
	`(${param} IS NULL OR EXISTS (SELECT 1 FROM message_addresses a
		WHERE a.message_id = m.id AND a.address IN (SELECT value FROM json_each(${param}))))`;
const addressParam = (filter: AddressFilter) => (filter.addresses ? JSON.stringify(filter.addresses) : null);

/**
 * One instance per mailbox (name = mailbox id from the D1 directory).
 * Holds every message's metadata, threads, labels, search index, and the outbox.
 * Bodies and attachments live in R2; this object stores their keys.
 */
export class Mailbox extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// Heartbeats from the web client are answered without waking the object.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate(): void {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
		const row = this.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'schema_version'`).toArray()[0];
		const applied = row ? Number(row.value) : 0;
		for (let i = applied; i < MIGRATIONS.length; i++) {
			this.ctx.storage.transactionSync(() => {
				this.sql.exec(MIGRATIONS[i]!);
				this.sql.exec(
					`INSERT INTO _meta (key, value) VALUES ('schema_version', ?1)
					 ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
					String(i + 1),
				);
			});
		}
	}

	// ─── Live updates ───────────────────────────────────────────────────────

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Expected WebSocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		ws.close(code, "closing");
	}

	private broadcast(event: LiveEvent): void {
		const data = JSON.stringify(event);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(data);
			} catch {
				// Socket already closing; the runtime cleans it up.
			}
		}
	}

	/** Deletes everything this mailbox holds: its R2 objects, then its own storage. The directory rows go first. */
	async destroy(): Promise<void> {
		const mailboxId = this.ctx.id.name;
		if (!mailboxId) return;
		for (const prefix of [r2Keys.mailbox(mailboxId), r2Keys.upload(mailboxId, "")]) {
			let cursor: string | undefined;
			do {
				const page = await this.env.MAIL.list({ prefix, cursor });
				if (page.objects.length > 0) await this.env.MAIL.delete(page.objects.map((o) => o.key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		}
		for (const ws of this.ctx.getWebSockets()) ws.close(1000, "mailbox deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}

	// ─── Inbound ────────────────────────────────────────────────────────────

	async ingest(input: IngestInput): Promise<{ threadId: string; duplicate: boolean }> {
		const existing = this.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM messages WHERE id = ?1`, input.id).toArray()[0];
		if (existing) return { threadId: existing.thread_id, duplicate: true };

		// Same message delivered twice to this mailbox (e.g. sent to two of our addresses,
		// or our own outbound copy coming back): keep one copy, merge labels.
		if (input.messageIdHeader) {
			const twin = this.sql
				.exec<{ id: string; thread_id: string }>(
					`SELECT id, thread_id FROM messages WHERE message_id_header = ?1 OR provider_message_id = ?1 LIMIT 1`,
					input.messageIdHeader,
				)
				.toArray()[0];
			if (twin) {
				this.addLabels([twin.id], input.labels);
				this.addAddress(twin.id, stripSubaddress(input.envelopeTo).base);
				this.broadcast({ type: "threads.changed", threadIds: [twin.thread_id] });
				return { threadId: twin.thread_id, duplicate: true };
			}
		}

		const snippet = makeSnippet(input.text);
		const threadId = this.ctx.storage.transactionSync(() => {
			const threadId =
				this.findThread(input) ?? this.createThread(input.subject, input.date);

			const { rowid } = this.sql
				.exec<{ rowid: number }>(
					`INSERT INTO messages (id, thread_id, direction, message_id_header, in_reply_to, refs,
						envelope_from, envelope_to, from_json, to_json, cc_json, reply_to_json, subject, snippet,
						date, received_at, text_body, html_key, raw_key, is_read, auth_json)
					 VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, ?19)
					 RETURNING rowid`,
					input.id,
					threadId,
					input.messageIdHeader,
					JSON.stringify(input.inReplyTo),
					JSON.stringify(input.references),
					input.envelopeFrom,
					input.envelopeTo,
					JSON.stringify(input.from),
					JSON.stringify(input.to),
					JSON.stringify(input.cc),
					JSON.stringify(input.replyTo),
					input.subject,
					snippet,
					input.date,
					input.receivedAt,
					input.text,
					input.htmlKey,
					input.rawKey,
					input.auth ? JSON.stringify(input.auth) : null,
				)
				.one();

			this.addLabels([input.id], input.labels);
			this.addAddress(input.id, stripSubaddress(input.envelopeTo).base);
			for (const a of input.attachments) this.insertAttachment(input.id, a);
			if (input.messageIdHeader) this.registerRef(input.messageIdHeader, threadId);
			this.indexMessage(rowid, input.subject, input.from, [...input.to, ...input.cc], input.text);
			this.touchThread(threadId, input.date, snippet, [input.from, ...input.to, ...input.cc]);
			if (!input.labels.includes("spam")) this.recordContacts([input.from], false, input.date);
			return threadId;
		});

		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return { threadId, duplicate: false };
	}

	/**
	 * RFC 5322 threading: match In-Reply-To/References against known Message-IDs.
	 * If the message claims to be a reply but nothing matches (e.g. a reply to an outbound
	 * message whose final Message-ID we never saw), fall back to normalized subject + sender
	 * already being a participant, within a recent window.
	 */
	private findThread(input: Pick<IngestInput, "inReplyTo" | "references" | "subject" | "from" | "date">): string | null {
		const candidates = [...new Set([...input.inReplyTo, ...input.references.toReversed()])];
		for (const id of candidates) {
			const hit = this.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM thread_refs WHERE message_id_header = ?1`, id).toArray()[0];
			if (hit) return hit.thread_id;
		}
		if (candidates.length === 0) return null;

		const key = normalizeSubject(input.subject);
		if (!key) return null;
		const hit = this.sql
			.exec<{ id: string }>(
				`SELECT t.id FROM threads t
				 WHERE t.subject_key = ?1 AND t.last_message_at >= ?2
				   AND EXISTS (SELECT 1 FROM json_each(t.participants) p WHERE json_extract(p.value, '$.address') = ?3)
				 ORDER BY t.last_message_at DESC LIMIT 1`,
				key,
				input.date - SUBJECT_FALLBACK_WINDOW_MS,
				input.from.address.toLowerCase(),
			)
			.toArray()[0];
		return hit?.id ?? null;
	}

	private createThread(subject: string, at: number): string {
		const id = ulid(at);
		this.sql.exec(
			`INSERT INTO threads (id, subject, subject_key, last_message_at) VALUES (?1, ?2, ?3, ?4)`,
			id,
			subject,
			normalizeSubject(subject),
			at,
		);
		return id;
	}

	private touchThread(threadId: string, at: number, snippet: string, people: Address[]): void {
		const row = this.sql.exec<{ last_message_at: number; participants: string }>(
			`SELECT last_message_at, participants FROM threads WHERE id = ?1`,
			threadId,
		).one();
		const participants: Address[] = JSON.parse(row.participants);
		for (const p of people) {
			const address = p.address.toLowerCase();
			if (participants.length >= MAX_PARTICIPANTS) break;
			if (!participants.some((x) => x.address === address)) participants.push({ address, name: p.name });
		}
		const newest = at >= row.last_message_at;
		this.sql.exec(
			`UPDATE threads SET participants = ?2, last_message_at = max(last_message_at, ?3),
				snippet = CASE WHEN ?4 THEN ?5 ELSE snippet END
			 WHERE id = ?1`,
			threadId,
			JSON.stringify(participants),
			at,
			newest ? 1 : 0,
			snippet,
		);
	}

	private registerRef(messageIdHeader: string, threadId: string): void {
		this.sql.exec(`INSERT OR IGNORE INTO thread_refs (message_id_header, thread_id) VALUES (?1, ?2)`, messageIdHeader, threadId);
	}

	private indexMessage(rowid: number, subject: string, from: Address, recipients: Address[], body: string | null): void {
		const fmt = (a: Address) => `${a.name ?? ""} ${a.address}`;
		this.sql.exec(
			`INSERT INTO messages_fts (rowid, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, ?5)`,
			rowid,
			subject,
			fmt(from),
			recipients.map(fmt).join(" "),
			body ?? "",
		);
	}

	private insertAttachment(messageId: string, a: StoredAttachment): void {
		this.sql.exec(
			`INSERT INTO attachments (id, message_id, filename, content_type, size, content_id, inline, r2_key, link_token)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
			a.id,
			messageId,
			a.filename,
			a.contentType,
			a.size,
			a.contentId,
			a.inline ? 1 : 0,
			a.r2Key,
			a.link?.token ?? null,
		);
	}

	private addLabels(messageIds: string[], labels: string[]): void {
		for (const id of messageIds) {
			for (const label of labels) {
				this.sql.exec(`INSERT OR IGNORE INTO message_labels (message_id, label) VALUES (?1, ?2)`, id, label);
			}
		}
	}

	/**
	 * Remembers who this mailbox writes to (`sent`) and hears from, for recipient suggestions. An undone send still
	 * counts: the address was typed on purpose.
	 */
	private recordContacts(people: Address[], sent: boolean, at: number): void {
		for (const p of people) {
			if (!isValidAddress(p.address)) continue;
			this.sql.exec(
				`INSERT INTO contacts (address, name, sent, last_at) VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT (address) DO UPDATE SET
					name = CASE WHEN excluded.name IS NOT NULL AND excluded.last_at >= last_at THEN excluded.name ELSE name END,
					sent = sent + excluded.sent,
					last_at = max(last_at, excluded.last_at)`,
				normalizeAddress(p.address),
				p.name?.trim() || null,
				sent ? 1 : 0,
				at,
			);
		}
	}

	private addAddress(messageId: string, address: string): void {
		this.sql.exec(`INSERT OR IGNORE INTO message_addresses (message_id, address) VALUES (?1, ?2)`, messageId, address);
	}

	private removeLabels(messageIds: string[], labels: string[]): void {
		for (const id of messageIds) {
			for (const label of labels) {
				this.sql.exec(`DELETE FROM message_labels WHERE message_id = ?1 AND label = ?2`, id, label);
			}
		}
	}

	// ─── Reads ──────────────────────────────────────────────────────────────

	/** A thread is listed when one of its messages carries the label and belongs to the filtered addresses. */
	async listThreads(query: { label: string; before?: number; limit?: number } & AddressFilter): Promise<ThreadSummary[]> {
		const limit = Math.min(query.limit ?? 50, 200);
		const before = query.before ?? Number.MAX_SAFE_INTEGER;
		const filter =
			query.label === ALL_MAIL
				? `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND ${IN_ADDRESSES("?4")} AND NOT EXISTS (
						SELECT 1 FROM message_labels l WHERE l.message_id = m.id AND l.label IN ('trash', 'spam')))`
				: `EXISTS (SELECT 1 FROM messages m JOIN message_labels l ON l.message_id = m.id
						WHERE m.thread_id = t.id AND l.label = ?1 AND ${IN_ADDRESSES("?4")})`;
		const rows = this.sql
			.exec<ThreadRow>(
				`${THREAD_SELECT} WHERE ${filter} AND t.last_message_at < ?2 ORDER BY t.last_message_at DESC LIMIT ?3`,
				query.label,
				before,
				limit,
				addressParam(query),
			)
			.toArray();
		return rows.map(toThreadSummary);
	}

	async search(query: { query: string; limit?: number } & AddressFilter): Promise<ThreadSummary[]> {
		const match = toFtsQuery(query.query);
		if (!match) return [];
		const limit = Math.min(query.limit ?? 50, 200);
		const rows = this.sql
			.exec<ThreadRow>(
				`WITH hits AS (
					SELECT m.thread_id, min(f.rank) AS score FROM messages_fts f
					JOIN messages m ON m.rowid = f.rowid
					WHERE messages_fts MATCH ?1 AND ${IN_ADDRESSES("?3")}
					GROUP BY m.thread_id ORDER BY score LIMIT ?2
				)
				${THREAD_SELECT} JOIN hits h ON h.thread_id = t.id ORDER BY h.score`,
				match,
				limit,
				addressParam(query),
			)
			.toArray();
		return rows.map(toThreadSummary);
	}

	async getThread(threadId: string): Promise<ThreadDetail | null> {
		const thread = this.sql.exec<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?1`, threadId).toArray()[0];
		if (!thread) return null;
		const messages = this.sql
			.exec<MessageRow>(
				`SELECT m.*, (SELECT json_group_array(label) FROM message_labels l WHERE l.message_id = m.id) AS labels
				 FROM messages m WHERE m.thread_id = ?1 ORDER BY m.date`,
				threadId,
			)
			.toArray();
		const attachments = this.sql
			.exec<AttachmentRow>(
				`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?1`,
				threadId,
			)
			.toArray();
		return {
			thread: toThreadSummary(thread),
			messages: messages.map((m) => toMessageDetail(m, attachments.filter((a) => a.message_id === m.id))),
		};
	}

	async getMessageBlobs(messageId: string): Promise<MessageBlobs | null> {
		const msg = this.sql
			.exec<{ raw_key: string | null; html_key: string | null }>(`SELECT raw_key, html_key FROM messages WHERE id = ?1`, messageId)
			.toArray()[0];
		if (!msg) return null;
		const attachments = this.sql.exec<AttachmentRow>(`SELECT * FROM attachments WHERE message_id = ?1`, messageId).toArray();
		return { rawKey: msg.raw_key, htmlKey: msg.html_key, attachments: attachments.map(toStoredAttachment) };
	}

	/** A file sent as a link, found by its token for the public download route, which checks it's still shared. */
	async getLinkedFile(token: string): Promise<{ file: StoredAttachment; from: Address } | null> {
		const row = this.sql
			.exec<AttachmentRow & { from_json: string }>(
				`SELECT a.*, m.from_json FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.link_token = ?1`,
				token,
			)
			.toArray()[0];
		return row ? { file: toStoredAttachment(row), from: JSON.parse(row.from_json) } : null;
	}

	/** People written to first, then newest first: mergeContacts() keeps the same order across mailboxes. */
	async contacts(limit: number): Promise<Contact[]> {
		return this.sql
			.exec<ContactRow>(`SELECT address, name, sent, last_at AS lastAt FROM contacts ORDER BY sent > 0 DESC, last_at DESC LIMIT ?1`, limit)
			.toArray();
	}

	async counts(query: AddressFilter): Promise<Counts> {
		const labels = this.sql
			.exec<{ label: string; threads: number; unread: number }>(
				`SELECT l.label, count(DISTINCT m.thread_id) AS threads,
					count(DISTINCT CASE WHEN m.is_read = 0 THEN m.thread_id END) AS unread
				 FROM message_labels l JOIN messages m ON m.id = l.message_id
				 WHERE ${IN_ADDRESSES("?1")} GROUP BY l.label`,
				addressParam(query),
			)
			.toArray();
		const addresses = this.sql
			.exec<{ address: string; unread: number }>(
				`SELECT a.address, count(DISTINCT m.thread_id) AS unread
				 FROM message_addresses a JOIN messages m ON m.id = a.message_id
				 JOIN message_labels l ON l.message_id = m.id AND l.label = 'inbox'
				 WHERE m.is_read = 0 GROUP BY a.address`,
			)
			.toArray();
		return { labels, addresses };
	}

	// ─── Mutations ──────────────────────────────────────────────────────────

	async modifyThreads(input: { threadIds: string[]; add?: string[]; remove?: string[] }): Promise<void> {
		const add = input.add ?? [];
		// Trash and spam imply leaving the inbox.
		const remove = [...(input.remove ?? []), ...(add.some((l) => l === "trash" || l === "spam") ? ["inbox"] : [])];
		this.ctx.storage.transactionSync(() => {
			const ids = this.messageIdsForThreads(input.threadIds);
			this.removeLabels(ids, remove);
			this.addLabels(ids, add);
		});
		this.broadcast({ type: "threads.changed", threadIds: input.threadIds });
	}

	/** Stops or resumes a linked file's download link. Returns false if there's no such linked file. */
	async setLinkShared(messageId: string, attachmentId: string, shared: boolean): Promise<boolean> {
		const updated = this.sql
			.exec(
				`UPDATE attachments SET link_stopped = ?3 WHERE id = ?1 AND message_id = ?2 AND link_token IS NOT NULL RETURNING id`,
				attachmentId,
				messageId,
				shared ? 0 : 1,
			)
			.toArray();
		if (updated.length === 0) return false;
		const { thread_id } = this.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM messages WHERE id = ?1`, messageId).one();
		this.broadcast({ type: "threads.changed", threadIds: [thread_id] });
		return true;
	}

	async markRead(input: { threadIds: string[]; read: boolean }): Promise<void> {
		for (const threadId of input.threadIds) {
			this.sql.exec(`UPDATE messages SET is_read = ?2 WHERE thread_id = ?1`, threadId, input.read ? 1 : 0);
		}
		this.broadcast({ type: "threads.changed", threadIds: input.threadIds });
	}

	private messageIdsForThreads(threadIds: string[]): string[] {
		return threadIds.flatMap((t) =>
			this.sql.exec<{ id: string }>(`SELECT id FROM messages WHERE thread_id = ?1`, t).toArray().map((r) => r.id),
		);
	}

	// ─── Outbound ───────────────────────────────────────────────────────────

	async enqueueSend(input: SendInput): Promise<SendQueued> {
		this.bindMailboxId(input.mailboxId);
		const now = Date.now();
		const id = ulid(now);
		const sendAt = now + Math.max(0, input.delayMs);

		const parent = input.replyToMessageId
			? this.sql
					.exec<{ thread_id: string; message_id_header: string | null; refs: string }>(
						`SELECT thread_id, message_id_header, refs FROM messages WHERE id = ?1`,
						input.replyToMessageId,
					)
					.toArray()[0]
			: undefined;

		const headers: Record<string, string> = {};
		if (parent?.message_id_header) {
			headers["In-Reply-To"] = parent.message_id_header;
			headers.References = buildReferences(JSON.parse(parent.refs), parent.message_id_header).join(" ");
		}

		const stored = (a: SendAttachmentRef, link: StoredAttachment["link"]): StoredAttachment => ({
			id: ulid(now),
			filename: a.filename,
			contentType: a.contentType,
			size: a.size,
			contentId: null,
			inline: false,
			link,
			r2Key: a.r2Key,
		});
		const attached = input.attachments.map((a) => stored(a, null));
		const linked = input.links.map((a) => {
			const token = newLinkToken();
			return { file: stored(a, { token, shared: true }), url: input.linkBase + token };
		});
		const attachments = [...attached, ...linked.map((l) => l.file)];

		// The sent copy keeps the links too, so the sender sees what recipients got.
		let { text, html } = input;
		if (linked.length > 0) {
			({ text, html } = withLinks({ text, html }, linked.map((l) => ({ ...l.file, url: l.url }))));
		}

		let htmlKey: string | null = null;
		if (html) {
			htmlKey = r2Keys.html(input.mailboxId, id);
			await this.env.MAIL.put(htmlKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
		}

		const payload: OutboxPayload = {
			from: input.from,
			to: input.to,
			cc: input.cc,
			bcc: input.bcc,
			subject: input.subject,
			text,
			html,
			headers,
			attachments,
			localRecipients: input.localRecipients,
			localOnly: input.localOnly,
		};

		const snippet = makeSnippet(text);
		const threadId = this.ctx.storage.transactionSync(() => {
			const threadId = parent?.thread_id ?? this.createThread(input.subject, now);
			const { rowid } = this.sql
				.exec<{ rowid: number }>(
					`INSERT INTO messages (id, thread_id, direction, in_reply_to, refs, from_json, to_json, cc_json, bcc_json,
						subject, snippet, date, received_at, text_body, html_key, is_read, delivery_status)
					 VALUES (?1, ?2, 'out', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, 1, 'queued')
					 RETURNING rowid`,
					id,
					threadId,
					JSON.stringify(headers["In-Reply-To"] ? [headers["In-Reply-To"]] : []),
					JSON.stringify(headers.References ? headers.References.split(" ") : []),
					JSON.stringify(input.from),
					JSON.stringify(input.to),
					JSON.stringify(input.cc),
					JSON.stringify(input.bcc),
					input.subject,
					snippet,
					sendAt,
					text,
					htmlKey,
				)
				.one();
			this.addLabels([id], ["outbox"]);
			this.addAddress(id, normalizeAddress(input.from.address));
			for (const a of attachments) this.insertAttachment(id, a);
			this.indexMessage(rowid, input.subject, input.from, [...input.to, ...input.cc, ...input.bcc], text);
			this.touchThread(threadId, sendAt, snippet, [input.from, ...input.to, ...input.cc]);
			this.recordContacts([...input.to, ...input.cc, ...input.bcc], true, now);
			this.sql.exec(`INSERT INTO outbox (message_id, send_at, payload) VALUES (?1, ?2, ?3)`, id, sendAt, JSON.stringify(payload));
			return threadId;
		});

		await this.scheduleOutbox();
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return { id, threadId, sendAt };
	}

	/** Undo send: only possible while the message is still waiting in the outbox. */
	async cancelSend(messageId: string): Promise<boolean> {
		const row = this.sql
			.exec<{ thread_id: string; rowid: number }>(
				`SELECT m.thread_id, m.rowid FROM outbox o JOIN messages m ON m.id = o.message_id
				 WHERE o.message_id = ?1 AND m.delivery_status = 'queued'`,
				messageId,
			)
			.toArray()[0];
		if (!row) return false;
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM messages_fts WHERE rowid = ?1`, row.rowid);
			this.sql.exec(`DELETE FROM outbox WHERE message_id = ?1`, messageId);
			this.sql.exec(`DELETE FROM message_labels WHERE message_id = ?1`, messageId);
			this.sql.exec(`DELETE FROM attachments WHERE message_id = ?1`, messageId);
			this.sql.exec(`DELETE FROM messages WHERE id = ?1`, messageId);
			const left = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM messages WHERE thread_id = ?1`, row.thread_id).one();
			if (left.n === 0) {
				this.sql.exec(`DELETE FROM thread_refs WHERE thread_id = ?1`, row.thread_id);
				this.sql.exec(`DELETE FROM threads WHERE id = ?1`, row.thread_id);
			}
		});
		await this.scheduleOutbox();
		this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
		return true;
	}

	private async scheduleOutbox(): Promise<void> {
		const next = this.sql.exec<{ at: number | null }>(`SELECT min(send_at) AS at FROM outbox`).one().at;
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next) await this.ctx.storage.setAlarm(next);
	}

	/** Drains due outbox rows. Each message is handled independently so one failure can't block the rest. */
	/**
	 * Recipients routed back into this mailbox get the sent copy as their received copy: labelled and
	 * unread like inbound mail. When the send also went out through Email Sending, the copy that loops
	 * back through MX is merged into this one by ingest().
	 */
	private deliverLocally(messageId: string, recipients: LocalRecipient[], everyone: boolean): void {
		const now = Date.now();
		for (const r of recipients) {
			this.addLabels([messageId], r.labels);
			this.addAddress(messageId, stripSubaddress(r.address).base);
			this.sql.exec(
				`INSERT OR REPLACE INTO deliveries (message_id, recipient, status, detail, updated_at) VALUES (?1, ?2, 'delivered', NULL, ?3)`,
				messageId,
				r.address,
				now,
			);
		}
		this.sql.exec(
			`UPDATE messages SET is_read = 0, delivery_status = CASE WHEN ?2 THEN 'delivered' ELSE delivery_status END WHERE id = ?1`,
			messageId,
			everyone ? 1 : 0,
		);
	}

	override async alarm(): Promise<void> {
		const due = this.sql
			.exec<{ message_id: string; attempts: number; payload: string; delivery_status: DeliveryStatus; thread_id: string }>(
				`SELECT o.message_id, o.attempts, o.payload, m.delivery_status, m.thread_id
				 FROM outbox o JOIN messages m ON m.id = o.message_id
				 WHERE o.send_at <= ?1 ORDER BY o.send_at LIMIT ?2`,
				Date.now(),
				OUTBOX_BATCH,
			)
			.toArray();

		for (const row of due) {
			if (row.delivery_status === "sending") {
				// A previous attempt was interrupted after handing off to Email Sending.
				// Don't risk a duplicate: surface it to the user instead.
				this.finishSend(row.message_id, row.thread_id, "failed", "Interrupted mid-send; check Sent logs before retrying.");
				continue;
			}
			this.sql.exec(`UPDATE messages SET delivery_status = 'sending' WHERE id = ?1`, row.message_id);
			this.sql.exec(`UPDATE outbox SET attempts = attempts + 1 WHERE message_id = ?1`, row.message_id);

			const payload: OutboxPayload = JSON.parse(row.payload);
			let providerMessageId: string | undefined;
			try {
				if (!payload.localOnly) {
					// Linked files stay behind; the text already links to them. (Rows queued before links existed lack the field.)
					const attached = await this.loadAttachments(payload.attachments.filter((a) => !a.link));
					providerMessageId = (await this.env.EMAIL.send(buildSendRequest(payload, attached))).messageId;
				}
			} catch (err) {
				const code = typeof err === "object" && err && "code" in err ? String(err.code) : "E_UNKNOWN";
				const detail = `${code}: ${err instanceof Error ? err.message : String(err)}`;
				const attempts = row.attempts + 1;
				if (TRANSIENT_SEND_ERRORS.has(code) && attempts < MAX_SEND_ATTEMPTS) {
					const backoff = Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
					this.sql.exec(`UPDATE outbox SET send_at = ?2 WHERE message_id = ?1`, row.message_id, Date.now() + backoff);
					this.sql.exec(`UPDATE messages SET delivery_status = 'queued', delivery_detail = ?2 WHERE id = ?1`, row.message_id, detail);
				} else {
					this.finishSend(row.message_id, row.thread_id, "failed", detail);
				}
				console.error(JSON.stringify({ msg: "send failed", messageId: row.message_id, code, attempts }));
				continue;
			}

			this.finishSend(row.message_id, row.thread_id, "sent", null, providerMessageId, payload.localRecipients);
			try {
				await this.persistSentAttachments(row.message_id, payload.attachments);
			} catch (err) {
				// The mail went out; the attachment rows still point at the upload copies.
				console.error(JSON.stringify({ msg: "persisting sent attachments failed", messageId: row.message_id, error: String(err) }));
			}
		}

		await this.scheduleOutbox();
	}

	private async loadAttachments(attachments: StoredAttachment[]): Promise<EmailAttachment[]> {
		return Promise.all(
			attachments.map(async (a) => {
				const obj = await this.env.MAIL.get(a.r2Key);
				if (!obj) throw Object.assign(new Error(`Attachment missing: ${a.filename}`), { code: "E_ATTACHMENT_MISSING" });
				return { content: await obj.arrayBuffer(), filename: a.filename, type: a.contentType, disposition: "attachment" as const };
			}),
		);
	}

	/**
	 * Uploads live under a lifecycle-reaped prefix; keep a permanent copy with the sent message.
	 * Streamed rather than buffered: linked files run up to MAX_UPLOAD_BYTES.
	 */
	private async persistSentAttachments(messageId: string, attachments: StoredAttachment[]): Promise<void> {
		if (attachments.length === 0) return;
		const mailboxId = this.mailboxId();
		for (const a of attachments) {
			const upload = await this.env.MAIL.get(a.r2Key);
			if (!upload) throw new Error(`Attachment missing: ${a.filename}`);
			const r2Key = r2Keys.attachment(mailboxId, messageId, a.id);
			await this.env.MAIL.put(r2Key, upload.body, { httpMetadata: { contentType: a.contentType } });
			this.sql.exec(`UPDATE attachments SET r2_key = ?2 WHERE id = ?1`, a.id, r2Key);
			if (a.r2Key.startsWith("uploads/")) await this.env.MAIL.delete(a.r2Key);
		}
	}

	private finishSend(
		messageId: string,
		threadId: string,
		status: "sent" | "failed",
		detail: string | null,
		providerMessageId?: string,
		local: LocalRecipient[] = [],
	): void {
		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`DELETE FROM outbox WHERE message_id = ?1`, messageId);
			this.sql.exec(
				`UPDATE messages SET delivery_status = ?2, delivery_detail = ?3, provider_message_id = ?4,
					message_id_header = ?5, date = CASE WHEN ?2 = 'sent' THEN ?6 ELSE date END
				 WHERE id = ?1`,
				messageId,
				status,
				detail,
				providerMessageId ?? null,
				providerMessageId ? toHeaderId(providerMessageId) : null,
				Date.now(),
			);
			if (status === "sent") {
				this.removeLabels([messageId], ["outbox"]);
				this.addLabels([messageId], ["sent"]);
				if (providerMessageId) {
					// We can't set Message-ID ourselves; register what Email Sending gave us so replies thread.
					this.registerRef(toHeaderId(providerMessageId), threadId);
				}
				if (local.length > 0) this.deliverLocally(messageId, local, providerMessageId === undefined);
			}
		});
		this.broadcast({ type: "delivery.changed", messageId, status });
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
	}

	/** Applies an Email Sending lifecycle event. Returns false if the message isn't in this mailbox. */
	async applyDeliveryEvent(event: DeliveryEventInput): Promise<boolean> {
		const msg = this.sql
			.exec<{ id: string; thread_id: string }>(
				`SELECT id, thread_id FROM messages WHERE provider_message_id = ?1 OR message_id_header = ?2 LIMIT 1`,
				event.providerMessageId,
				toHeaderId(event.providerMessageId),
			)
			.toArray()[0];
		if (!msg) return false;

		this.sql.exec(
			`INSERT INTO deliveries (message_id, recipient, status, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT (message_id, recipient) DO UPDATE SET status = excluded.status, detail = excluded.detail,
				updated_at = excluded.updated_at
			 WHERE excluded.updated_at >= deliveries.updated_at`,
			msg.id,
			event.recipient.toLowerCase(),
			event.status,
			event.detail,
			event.at,
		);
		const statuses = this.sql
			.exec<{ status: DeliveryStatus; detail: string | null }>(`SELECT status, detail FROM deliveries WHERE message_id = ?1`, msg.id)
			.toArray();
		const summary = summarizeDelivery(statuses);
		this.sql.exec(
			`UPDATE messages SET delivery_status = ?2, delivery_detail = ?3 WHERE id = ?1`,
			msg.id,
			summary.status,
			summary.detail,
		);
		this.broadcast({ type: "delivery.changed", messageId: msg.id, status: summary.status });
		return true;
	}

	/**
	 * The DO name is the mailbox id, but `ctx.id.name` isn't populated in every context
	 * (alarms, cross-process local dev), so callers pass it and we remember it for the alarm.
	 */
	private bindMailboxId(mailboxId: string): string {
		const stored = this.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'mailbox_id'`).toArray()[0];
		if (stored && stored.value !== mailboxId) throw new Error(`Mailbox id mismatch: ${mailboxId} != ${stored.value}`);
		if (!stored) this.sql.exec(`INSERT INTO _meta (key, value) VALUES ('mailbox_id', ?1)`, mailboxId);
		return mailboxId;
	}

	private mailboxId(): string {
		const stored = this.sql.exec<{ value: string }>(`SELECT value FROM _meta WHERE key = 'mailbox_id'`).toArray()[0];
		const id = stored?.value ?? this.ctx.id.name;
		if (!id) throw new Error("Mailbox id unknown; enqueueSend binds it before any alarm runs");
		return id;
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function buildSendRequest(p: OutboxPayload, attachments: EmailAttachment[]): EmailMessageBuilder {
	const toEmail = (a: Address) => (a.name ? { email: a.address, name: a.name } : a.address);
	return {
		from: toEmail(p.from),
		to: p.to.map(toEmail),
		...(p.cc.length ? { cc: p.cc.map(toEmail) } : {}),
		...(p.bcc.length ? { bcc: p.bcc.map(toEmail) } : {}),
		subject: p.subject,
		text: p.text,
		...(p.html ? { html: p.html } : {}),
		...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
		...(attachments.length ? { attachments } : {}),
	};
}

function toHeaderId(id: string): string {
	const trimmed = id.trim();
	return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/** Worst-first: any hard failure wins, then in-flight states, then delivered. */
function summarizeDelivery(rows: { status: DeliveryStatus; detail: string | null }[]): {
	status: DeliveryStatus;
	detail: string | null;
} {
	const order: DeliveryStatus[] = ["bounced", "rejected", "failed", "complained", "deferred", "sent", "delivered"];
	for (const status of order) {
		const hit = rows.find((r) => r.status === status);
		if (hit) return { status, detail: hit.detail };
	}
	return { status: "sent", detail: null };
}

/** Turn free text into a safe FTS5 query: every term quoted, last term prefix-matched. */
function toFtsQuery(input: string): string | null {
	const terms = input
		.split(/\s+/)
		.map((t) => t.replaceAll('"', ""))
		.filter(Boolean)
		.slice(0, 12);
	if (terms.length === 0) return null;
	return terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
}

function toThreadSummary(r: ThreadRow): ThreadSummary {
	return {
		id: r.id,
		subject: r.subject,
		snippet: r.snippet,
		lastMessageAt: r.last_message_at,
		messageCount: r.message_count,
		unreadCount: r.unread_count,
		participants: JSON.parse(r.participants),
		labels: JSON.parse(r.labels),
		addresses: JSON.parse(r.addresses),
	};
}

function toStoredAttachment(a: AttachmentRow): StoredAttachment {
	return { ...toAttachmentMeta(a), r2Key: a.r2_key };
}

function toAttachmentMeta(a: AttachmentRow): AttachmentMeta {
	return {
		id: a.id,
		filename: a.filename,
		contentType: a.content_type,
		size: a.size,
		contentId: a.content_id,
		inline: a.inline === 1,
		link: a.link_token === null ? null : { token: a.link_token, shared: a.link_stopped === 0 },
	};
}

function toMessageDetail(m: MessageRow, attachments: AttachmentRow[]): MessageDetail {
	return {
		id: m.id,
		threadId: m.thread_id,
		direction: m.direction,
		messageIdHeader: m.message_id_header,
		from: JSON.parse(m.from_json),
		to: JSON.parse(m.to_json),
		cc: JSON.parse(m.cc_json),
		replyTo: JSON.parse(m.reply_to_json),
		subject: m.subject,
		date: m.date,
		text: m.text_body,
		hasHtml: m.html_key !== null,
		isRead: m.is_read === 1,
		labels: JSON.parse(m.labels),
		attachments: attachments.map(toAttachmentMeta),
		delivery: m.delivery_status ? { status: m.delivery_status, detail: m.delivery_detail } : null,
		auth: m.auth_json ? JSON.parse(m.auth_json) : null,
	};
}
