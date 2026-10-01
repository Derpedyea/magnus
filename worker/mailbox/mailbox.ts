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
	ensureAngleBrackets,
	type IngestInput,
	isValidAddress,
	type ListPage,
	LIVE_RECHECK,
	type LiveEvent,
	type LocalRecipient,
	type MessageBlobs,
	type MessageDetail,
	makeSnippet,
	newLinkToken,
	normalizeAddress,
	normalizeSubject,
	r2Keys,
	replyParents,
	RETRYABLE,
	type SendAttachmentRef,
	type SendInput,
	type SendQueued,
	type StoredAttachment,
	stripSubaddress,
	type ThreadDetail,
	type ThreadSummary,
	ulid,
	withForward,
} from "#shared";
import { noteBody } from "#shared/markdown";
import { retryAddressing } from "./retry";
import { MIGRATIONS } from "./schema";

const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_SEND_ATTEMPTS = 8;
/** How soon R2 objects it wouldn't delete are tried again. */
const TRASH_RETRY_MS = 60_000;
const OUTBOX_BATCH = 10;
const MAX_PARTICIPANTS = 12;
/** Longer than the inbound queue keeps retrying a message (wrangler.jsonc: 10 retries, at most an hour apart). */
const INGEST_WINDOW_MS = 24 * 3600 * 1000;
/** Message ids per holding() call when a deleted mailbox asks the others what they still hold. */
const HOLDING_BATCH = 10_000;
/** A socket is authorized once, when it opens. After this long it has to reconnect, which checks the sign-in again. */
const SOCKET_MS = 5 * 60 * 1000;

/** Error codes worth retrying: Email Sending's, and R2 failing to keep an upload (E_STORAGE). Everything else is a permanent failure. */
const TRANSIENT_SEND_ERRORS = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_DELIVERY_FAILED", "E_STORAGE"]);

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
	in_reply_to: string;
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

interface RetryRow extends Row {
	thread_id: string;
	from_json: string;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string;
	text_body: string | null;
	in_reply_to: string;
	refs: string;
	provider_message_id: string | null;
	delivery_status: DeliveryStatus | null;
	/** JSON array of the recipients whose servers refused it. */
	refused: string;
}

/** A message to send again, addressed to just the recipients it goes to this time. */
interface Retry {
	row: RetryRow;
	from: Address;
	to: Address[];
	cc: Address[];
	bcc: Address[];
	/** Normalized. */
	recipients: Set<string>;
}

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

/** Predicate on deliveries alias `d`: the recipient's server refused the message, so a retry sends to them. */
const REFUSED = `d.status IN (${[...RETRYABLE].map((s) => `'${s}'`).join(", ")})`;

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
		pair[1].serializeAttachment(Date.now() + SOCKET_MS);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		ws.close(code, "closing");
	}

	/** A socket past its time gets LIVE_RECHECK and a close instead, so a suspended or removed person stops hearing. */
	private broadcast(event: LiveEvent): void {
		const data = JSON.stringify(event);
		const now = Date.now();
		for (const ws of this.ctx.getWebSockets()) {
			const expires: unknown = ws.deserializeAttachment();
			try {
				if (typeof expires === "number" && expires > now) {
					ws.send(data);
				} else {
					ws.send(LIVE_RECHECK);
					ws.close(1000, "Sign-in check due");
				}
			} catch {
				// Socket already closing; the runtime cleans it up.
			}
		}
	}

	/** Deletes everything this mailbox holds: its R2 objects, then its own storage. The directory rows go first. */
	async destroy(): Promise<void> {
		const mailboxId = this.ctx.id.name;
		if (!mailboxId) return;
		// If another mailbox can't be asked, keeping the originals is the safe side; the rest still goes.
		await this.deleteOriginals().catch((err) => console.error(JSON.stringify({ msg: "originals kept", mailboxId, error: String(err) })));
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

	/**
	 * An original under raw/ is shared by every mailbox its message was delivered to, so it goes only once no mailbox
	 * left in the directory holds that message. A recent one may still be queued for another mailbox; it stays if the
	 * copy's `mailboxes` names one that's left, or if the copy predates `mailboxes` and can't say.
	 */
	private async deleteOriginals(): Promise<void> {
		const rows = this.sql
			.exec<{ id: string; raw_key: string; received_at: number }>(`SELECT id, raw_key, received_at FROM messages WHERE raw_key IS NOT NULL`)
			.toArray();
		const { results } = await this.env.DIRECTORY.prepare(`SELECT id FROM mailboxes`).all<{ id: string }>();
		const others = new Set(results.map((r) => r.id));
		const held = new Set<string>();
		for (let i = 0; i < rows.length; i += HOLDING_BATCH) {
			const ids = rows.slice(i, i + HOLDING_BATCH).map((r) => r.id);
			const lists = await Promise.all([...others].map((id) => this.env.MAILBOX.getByName(id).holding(ids)));
			for (const id of lists.flat()) held.add(id);
		}

		const recent = Date.now() - INGEST_WINDOW_MS;
		const orphans: string[] = [];
		for (const row of rows) {
			if (held.has(row.id)) continue;
			if (row.received_at > recent) {
				const head = await this.env.MAIL.head(row.raw_key);
				const due = head?.customMetadata?.mailboxes?.split(",");
				if (head && (!due || due.some((id) => others.has(id)))) continue;
			}
			orphans.push(row.raw_key);
		}
		for (let i = 0; i < orphans.length; i += 1000) await this.env.MAIL.delete(orphans.slice(i, i + 1000));
	}

	/** Which of these messages this mailbox has, for a mailbox being deleted to check before it removes their originals. */
	async holding(messageIds: string[]): Promise<string[]> {
		return this.sql
			.exec<{ id: string }>(`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?1))`, JSON.stringify(messageIds))
			.toArray()
			.map((r) => r.id);
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
	async listThreads(query: { label: string } & ListPage & AddressFilter): Promise<ThreadSummary[]> {
		const filter =
			query.label === ALL_MAIL
				? `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id AND ${IN_ADDRESSES("?2")} AND NOT EXISTS (
						SELECT 1 FROM message_labels l WHERE l.message_id = m.id AND l.label IN ('trash', 'spam')))`
				: `EXISTS (SELECT 1 FROM messages m JOIN message_labels l ON l.message_id = m.id
						WHERE m.thread_id = t.id AND l.label = ?1 AND ${IN_ADDRESSES("?2")})`;
		return this.page(filter, query.label, query);
	}

	/** Threads with a matching message, in list order like any other view so they page the same way. */
	async search(query: { query: string } & ListPage & AddressFilter): Promise<ThreadSummary[]> {
		const match = toFtsQuery(query.query);
		if (!match) return [];
		const filter = `t.id IN (SELECT m.thread_id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
			WHERE messages_fts MATCH ?1 AND ${IN_ADDRESSES("?2")})`;
		return this.page(filter, match, query);
	}

	/** One page of threads passing `filter`, which reads its own parameter as ?1 and the address filter as ?2. */
	private page(filter: string, param: string, query: ListPage & AddressFilter): ThreadSummary[] {
		const before = query.before ?? { at: Number.MAX_SAFE_INTEGER, id: "" };
		return this.sql
			.exec<ThreadRow>(
				`${THREAD_SELECT} WHERE ${filter} AND (t.last_message_at, t.id) < (?3, ?4)
				 ORDER BY t.last_message_at DESC, t.id DESC LIMIT ?5`,
				param,
				addressParam(query),
				before.at,
				before.id,
				Math.min(query.limit ?? 50, 200),
			)
			.toArray()
			.map(toThreadSummary);
	}

	async getThread(threadId: string): Promise<ThreadDetail | null> {
		const thread = this.sql.exec<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?1`, threadId).toArray()[0];
		if (!thread) return null;
		const messages = this.sql
			.exec<MessageRow>(
				`SELECT m.*, (SELECT json_group_array(label) FROM message_labels l WHERE l.message_id = m.id) AS labels
				 FROM messages m WHERE m.thread_id = ?1 ORDER BY m.date, m.id`,
				threadId,
			)
			.toArray();
		const attachments = this.sql
			.exec<AttachmentRow>(
				`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?1`,
				threadId,
			)
			.toArray();
		const refused = this.sql
			.exec<{ message_id: string; recipient: string }>(
				`SELECT d.message_id, d.recipient FROM deliveries d JOIN messages m ON m.id = d.message_id
				 WHERE m.thread_id = ?1 AND ${REFUSED}`,
				threadId,
			)
			.toArray();
		// A reply can name any send of a retried message, not just the latest one in message_id_header.
		const sends = this.sql
			.exec<{ message_id: string; provider_message_id: string }>(
				`SELECT s.message_id, s.provider_message_id FROM sends s JOIN messages m ON m.id = s.message_id WHERE m.thread_id = ?1`,
				threadId,
			)
			.toArray();
		const parents = replyParents(
			messages.map((m) => ({
				id: m.id,
				messageIds: [
					...(m.message_id_header ? [m.message_id_header] : []),
					...sends.filter((s) => s.message_id === m.id).map((s) => s.provider_message_id),
				],
				inReplyTo: JSON.parse(m.in_reply_to),
				references: JSON.parse(m.refs),
			})),
		);
		return {
			thread: toThreadSummary(thread),
			messages: messages.map((m) => ({
				...toMessageDetail(
					m,
					attachments.filter((a) => a.message_id === m.id),
					refused.filter((d) => d.message_id === m.id).map((d) => d.recipient),
				),
				...(parents.get(m.id) ?? { parentId: null, hasDirectParent: false }),
			})),
		};
	}

	/** One message, with where its body and files are stored. */
	async getMessage(messageId: string): Promise<{ message: MessageDetail; blobs: MessageBlobs } | null> {
		const row = this.sql
			.exec<MessageRow>(
				`SELECT m.*, (SELECT json_group_array(label) FROM message_labels l WHERE l.message_id = m.id) AS labels
				 FROM messages m WHERE m.id = ?1`,
				messageId,
			)
			.toArray()[0];
		if (!row) return null;
		const attachments = this.sql.exec<AttachmentRow>(`SELECT * FROM attachments WHERE message_id = ?1`, messageId).toArray();
		const refused = this.sql
			.exec<{ recipient: string }>(`SELECT d.recipient FROM deliveries d WHERE d.message_id = ?1 AND ${REFUSED}`, messageId)
			.toArray();
		return {
			message: toMessageDetail(row, attachments, refused.map((d) => d.recipient)),
			blobs: { rawKey: row.raw_key, htmlKey: row.html_key, attachments: attachments.map(toStoredAttachment) },
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

		const parent = input.parentMessageId
			? this.sql
					.exec<{ thread_id: string; message_id_header: string | null; refs: string }>(
						`SELECT thread_id, message_id_header, refs FROM messages WHERE id = ?1`,
						input.parentMessageId,
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
			contentId: a.contentId ?? null,
			inline: a.contentId !== undefined,
			link,
			r2Key: a.r2Key,
		});
		const attached = input.attachments.map((a) => stored(a, null));
		const linked = input.links.map((a) => {
			const token = newLinkToken();
			return { file: stored(a, { token, shared: true }), url: input.linkBase + token };
		});
		const attachments = [...attached, ...linked.map((l) => l.file)];

		// The sent copy keeps the links too, so the sender sees what recipients got. They sit with the note, above a forward.
		const note = noteBody(input.markdown, linked.map((l) => ({ ...l.file, url: l.url })));
		const { text, html } = input.forward ? withForward(note, input.forward) : note;

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

	/**
	 * Undo send: only possible while the message is still waiting in the outbox. Not for a retry of mail that
	 * already went out to someone, since undoing deletes the message.
	 */
	async cancelSend(messageId: string): Promise<boolean> {
		const row = this.sql
			.exec<{ thread_id: string; rowid: number; payload: string; attempts: number }>(
				`SELECT m.thread_id, m.rowid, o.payload, o.attempts FROM outbox o JOIN messages m ON m.id = o.message_id
				 WHERE o.message_id = ?1 AND m.delivery_status = 'queued' AND m.provider_message_id IS NULL`,
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
			const left = this.sql
				.exec<{ date: number; snippet: string; from_json: string; to_json: string; cc_json: string }>(
					`SELECT date, snippet, from_json, to_json, cc_json FROM messages WHERE thread_id = ?1 ORDER BY date, id`,
					row.thread_id,
				)
				.toArray();
			if (left.length === 0) {
				this.sql.exec(`DELETE FROM thread_refs WHERE thread_id = ?1`, row.thread_id);
				this.sql.exec(`DELETE FROM threads WHERE id = ?1`, row.thread_id);
				return;
			}
			// The thread's preview may be the cancelled message's (its text, send time, recipients): rebuild it from the rest, oldest first.
			this.sql.exec(`UPDATE threads SET snippet = '', last_message_at = 0, participants = '[]' WHERE id = ?1`, row.thread_id);
			for (const m of left) {
				this.touchThread(row.thread_id, m.date, m.snippet, [JSON.parse(m.from_json), ...JSON.parse(m.to_json), ...JSON.parse(m.cc_json)]);
			}
		});
		// One that's been tried has copied its files (an attempt still copying clears up after itself).
		if (row.attempts > 0) {
			const payload: OutboxPayload = JSON.parse(row.payload);
			await this.deleteCopies(messageId, payload.attachments);
		}
		await this.scheduleOutbox();
		this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
		return true;
	}

	/** Who a retry would go to, and as whom, so the API can check the sender and route the recipients first. */
	async retryTarget(messageId: string): Promise<{ from: string; recipients: string[] } | null> {
		const target = this.findRetry(messageId);
		return target && { from: target.from.address, recipients: [...target.recipients] };
	}

	/**
	 * Puts a failed or bounced message back in the outbox, addressed to whoever it didn't reach (see findRetry).
	 * It's the same message: a retry of mail that already went out keeps its date, and delivery events for
	 * either send still land on it (the `sends` table).
	 */
	async retrySend(messageId: string, local: LocalRecipient[]): Promise<boolean> {
		const htmlKey = this.sql.exec<{ html_key: string | null }>(`SELECT html_key FROM messages WHERE id = ?1`, messageId).toArray()[0]?.html_key;
		const html = htmlKey ? await (await this.env.MAIL.get(htmlKey))?.text() : undefined;
		// Checked after reading R2, since other calls can run while it waits.
		const target = this.findRetry(messageId);
		if (!target) return false;

		const { row, recipients } = target;
		const inReplyTo: string[] = JSON.parse(row.in_reply_to);
		const refs: string[] = JSON.parse(row.refs);
		const localRecipients = local.filter((r) => recipients.has(r.address));
		const payload: OutboxPayload = {
			from: target.from,
			to: target.to,
			cc: target.cc,
			bcc: target.bcc,
			subject: row.subject,
			text: row.text_body ?? "",
			html,
			headers: {
				...(inReplyTo[0] ? { "In-Reply-To": inReplyTo[0] } : {}),
				...(refs.length ? { References: refs.join(" ") } : {}),
			},
			attachments: this.sql.exec<AttachmentRow>(`SELECT * FROM attachments WHERE message_id = ?1`, messageId).toArray().map(toStoredAttachment),
			localRecipients,
			localOnly: localRecipients.length === recipients.size,
		};

		this.ctx.storage.transactionSync(() => {
			this.sql.exec(`INSERT INTO outbox (message_id, send_at, payload) VALUES (?1, ?2, ?3)`, messageId, Date.now(), JSON.stringify(payload));
			this.sql.exec(`UPDATE messages SET delivery_status = 'queued', delivery_detail = NULL WHERE id = ?1`, messageId);
		});
		await this.scheduleOutbox();
		this.broadcast({ type: "delivery.changed", messageId, status: "queued" });
		this.broadcast({ type: "threads.changed", threadIds: [row.thread_id] });
		return true;
	}

	/** Who a retry goes to (see retryAddressing). Null when there's nothing to retry, including while one is queued. */
	private findRetry(messageId: string): Retry | null {
		const row = this.sql
			.exec<RetryRow>(
				`SELECT m.thread_id, m.from_json, m.to_json, m.cc_json, m.bcc_json, m.subject, m.text_body, m.in_reply_to, m.refs,
					m.provider_message_id, m.delivery_status,
					(SELECT json_group_array(d.recipient) FROM deliveries d WHERE d.message_id = m.id AND ${REFUSED}) AS refused
				 FROM messages m
				 WHERE m.id = ?1 AND m.direction = 'out' AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = m.id)`,
				messageId,
			)
			.toArray()[0];
		if (!row?.delivery_status || !RETRYABLE.has(row.delivery_status)) return null;
		const addressing = retryAddressing(
			{ to: JSON.parse(row.to_json), cc: JSON.parse(row.cc_json), bcc: JSON.parse(row.bcc_json) },
			row.provider_message_id === null ? null : new Set<string>(JSON.parse(row.refused)),
		);
		return addressing.recipients.size > 0 ? { row, from: JSON.parse(row.from_json), ...addressing } : null;
	}

	private async scheduleOutbox(): Promise<void> {
		const due = this.sql.exec<{ at: number | null }>(`SELECT min(send_at) AS at FROM outbox`).one().at;
		const retry = this.sql.exec(`SELECT 1 FROM trash LIMIT 1`).toArray().length > 0 ? Date.now() + TRASH_RETRY_MS : null;
		const next = due === null ? retry : retry === null ? due : Math.min(due, retry);
		if (next === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > next) await this.ctx.storage.setAlarm(next);
	}

	/**
	 * Recipients routed back into this mailbox get the sent copy as their received copy: labelled and
	 * unread like inbound mail. When the send also went out through Email Sending, the copy that loops
	 * back through MX is merged into this one by ingest().
	 */
	private deliverLocally(messageId: string, recipients: LocalRecipient[]): void {
		const now = Date.now();
		for (const r of recipients) {
			this.addLabels([messageId], r.labels);
			this.addAddress(messageId, stripSubaddress(r.address).base);
			this.sql.exec(
				`INSERT OR REPLACE INTO deliveries (message_id, recipient, status, detail, updated_at) VALUES (?1, ?2, 'delivered', NULL, ?3)`,
				messageId,
				normalizeAddress(r.address),
				now,
			);
		}
		this.sql.exec(`UPDATE messages SET is_read = 0 WHERE id = ?1`, messageId);
	}

	/** Drains due outbox rows. Each message is handled independently so one failure can't block the rest. */
	override async alarm(): Promise<void> {
		await this.emptyTrash();
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
				this.finishSend(row.message_id, row.thread_id, { status: "failed", detail: "Interrupted mid-send; check Sent logs before retrying." });
				continue;
			}
			this.sql.exec(`UPDATE outbox SET attempts = attempts + 1 WHERE message_id = ?1`, row.message_id);

			const payload: OutboxPayload = JSON.parse(row.payload);
			let providerMessageId: string | undefined;
			let handoff: number;
			try {
				// Kept while still `queued`, so Undo still works and a copy cut short is simply redone.
				const attachments = await this.keepAttachments(row.message_id, payload.attachments);
				// Linked files stay behind; the text already links to them. (Rows queued before links existed lack the field.)
				const attached = payload.localOnly ? [] : await this.loadAttachments(attachments.filter((a) => !a.link));
				// Undo may have landed during those, or while an earlier row sent: the message is gone, so its copies go too.
				if (!this.inOutbox(row.message_id)) {
					await this.deleteCopies(row.message_id, payload.attachments);
					continue;
				}
				// Taken before anything reaches Email Sending, so every delivery event for this send is newer.
				handoff = Date.now();
				if (!payload.localOnly) {
					// Only now could a crash leave the message with Email Sending, so only now is it `sending` (see above).
					this.sql.exec(`UPDATE messages SET delivery_status = 'sending' WHERE id = ?1`, row.message_id);
					providerMessageId = (await this.env.EMAIL.send(buildSendRequest(payload, attached))).messageId;
				}
			} catch (err) {
				// Undone while its files were copied or read, before this failed: nothing to retry, only the copies made since.
				if (!this.inOutbox(row.message_id)) {
					await this.deleteCopies(row.message_id, payload.attachments);
					continue;
				}
				const code = typeof err === "object" && err && "code" in err ? String(err.code) : "E_UNKNOWN";
				const detail = `${code}: ${err instanceof Error ? err.message : String(err)}`;
				const attempts = row.attempts + 1;
				if (TRANSIENT_SEND_ERRORS.has(code) && attempts < MAX_SEND_ATTEMPTS) {
					const backoff = Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
					this.sql.exec(`UPDATE outbox SET send_at = ?2 WHERE message_id = ?1`, row.message_id, Date.now() + backoff);
					this.sql.exec(`UPDATE messages SET delivery_status = 'queued', delivery_detail = ?2 WHERE id = ?1`, row.message_id, detail);
				} else {
					this.finishSend(row.message_id, row.thread_id, { status: "failed", detail });
				}
				console.error(JSON.stringify({ msg: "send failed", messageId: row.message_id, code, attempts }));
				continue;
			}

			this.finishSend(row.message_id, row.thread_id, { status: "sent", providerMessageId, payload, handoff });
			// It went from the kept copies, so the uploads can go. Any left behind are reaped by the uploads/ lifecycle rule.
			const uploads = payload.attachments.filter(isUpload).map((a) => a.r2Key);
			if (uploads.length > 0) await this.env.MAIL.delete(uploads).catch(() => {});
		}

		await this.scheduleOutbox();
	}

	private async loadAttachments(attachments: StoredAttachment[]): Promise<EmailAttachment[]> {
		return Promise.all(
			attachments.map(async (a) => {
				const obj = await this.env.MAIL.get(a.r2Key).catch(storageFailed);
				if (!obj) throw Object.assign(new Error(`Attachment missing: ${a.filename}`), { code: "E_ATTACHMENT_MISSING" });
				const part = { content: await obj.arrayBuffer().catch(storageFailed), filename: a.filename, type: a.contentType };
				return a.inline && a.contentId
					? { ...part, disposition: "inline" as const, contentId: a.contentId }
					: { ...part, disposition: "attachment" as const };
			}),
		);
	}

	/**
	 * Uploads live under a lifecycle-reaped prefix, so each gets a permanent copy with the message before it's sent,
	 * and is sent from there: nothing after the send can lose it. Returns the attachments at their permanent keys.
	 * The payload still names the uploads, so a retry skips any whose row already moved.
	 * Streamed rather than buffered: linked files run up to MAX_UPLOAD_BYTES.
	 */
	private async keepAttachments(messageId: string, attachments: StoredAttachment[]): Promise<StoredAttachment[]> {
		const kept: StoredAttachment[] = [];
		for (const a of attachments) {
			if (!isUpload(a)) {
				kept.push(a);
				continue;
			}
			const r2Key = r2Keys.attachment(this.mailboxId(), messageId, a.id);
			const moved = this.sql.exec(`SELECT 1 FROM attachments WHERE id = ?1 AND r2_key = ?2`, a.id, r2Key).toArray().length > 0;
			if (!moved) {
				const upload = await this.env.MAIL.get(a.r2Key).catch(storageFailed);
				if (!upload) throw Object.assign(new Error(`Attachment missing: ${a.filename}`), { code: "E_ATTACHMENT_MISSING" });
				await this.env.MAIL.put(r2Key, upload.body, { httpMetadata: { contentType: a.contentType } }).catch(storageFailed);
				this.sql.exec(`UPDATE attachments SET r2_key = ?2 WHERE id = ?1`, a.id, r2Key);
			}
			kept.push({ ...a, r2Key });
		}
		return kept;
	}

	/** Whether the message still waits to send. Undo takes it out, maybe while an alarm is working on it. */
	private inOutbox(messageId: string): boolean {
		return this.sql.exec(`SELECT 1 FROM outbox WHERE message_id = ?1`, messageId).toArray().length > 0;
	}

	/**
	 * Removes what keepAttachments made for a message that won't be sent. Its uploads stay: Undo reopens the draft with
	 * them. The copies go through trash, so any R2 won't delete now are tried again rather than left for good.
	 */
	private async deleteCopies(messageId: string, attachments: StoredAttachment[]): Promise<void> {
		for (const a of attachments.filter(isUpload)) {
			this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, r2Keys.attachment(this.mailboxId(), messageId, a.id));
		}
		await this.emptyTrash();
	}

	/** Deletes what's in trash from R2. Whatever R2 refuses stays, and scheduleOutbox brings the alarm back for it. */
	private async emptyTrash(): Promise<void> {
		const keys = this.sql.exec<{ r2_key: string }>(`SELECT r2_key FROM trash LIMIT 1000`).toArray().map((r) => r.r2_key);
		if (keys.length === 0) return;
		const deleted = await this.env.MAIL.delete(keys).then(
			() => true,
			() => false,
		);
		if (deleted) this.sql.exec(`DELETE FROM trash WHERE r2_key IN (SELECT value FROM json_each(?1))`, JSON.stringify(keys));
	}

	private finishSend(
		messageId: string,
		threadId: string,
		outcome: { status: "failed"; detail: string } | { status: "sent"; providerMessageId?: string; payload: OutboxPayload; handoff: number },
	): void {
		const now = Date.now();
		const sent = outcome.status === "sent" ? outcome : null;
		const headerId = sent?.providerMessageId ? ensureAngleBrackets(sent.providerMessageId) : null;
		const status = this.ctx.storage.transactionSync((): DeliveryStatus => {
			this.sql.exec(`DELETE FROM outbox WHERE message_id = ?1`, messageId);
			// A failed retry keeps the ids of the send before it, and a retry keeps the date the message first went out.
			this.sql.exec(
				`UPDATE messages SET delivery_status = ?2, delivery_detail = ?3,
					provider_message_id = coalesce(?4, provider_message_id), message_id_header = coalesce(?5, message_id_header),
					date = CASE WHEN ?2 = 'sent' AND provider_message_id IS NULL THEN ?6 ELSE date END
				 WHERE id = ?1`,
				messageId,
				outcome.status,
				outcome.status === "failed" ? outcome.detail : null,
				sent?.providerMessageId ?? null,
				headerId,
				now,
			);
			if (!sent) return outcome.status;
			this.removeLabels([messageId], ["outbox"]);
			this.addLabels([messageId], ["sent"]);
			if (headerId) {
				// We can't set Message-ID ourselves; register what Email Sending gave us so replies thread and its
				// delivery events find this message.
				this.registerRef(headerId, threadId);
				this.sql.exec(`INSERT OR IGNORE INTO sends (provider_message_id, message_id) VALUES (?1, ?2)`, headerId, messageId);
			}
			// Everyone it went to is `sent` until their server answers, so it's delivered only once they all are. A retry's
			// recipients start over from the handoff: events from the send before are older, so they no longer apply.
			// Everyone else in a retry of mail that already went out keeps their state, which may be worse than `sent`
			// (a complaint, a deferral).
			const { to, cc, bcc, localRecipients = [] } = sent.payload;
			this.sql.exec(
				`INSERT INTO deliveries (message_id, recipient, status, detail, updated_at)
				 SELECT ?1, value, 'sent', NULL, ?3 FROM json_each(?2) WHERE true
				 ON CONFLICT (message_id, recipient) DO UPDATE SET status = 'sent', detail = NULL, updated_at = excluded.updated_at`,
				messageId,
				JSON.stringify([...to, ...cc, ...bcc].map((a) => normalizeAddress(a.address))),
				sent.handoff,
			);
			if (localRecipients.length > 0) this.deliverLocally(messageId, localRecipients);
			return this.rollUpDelivery(messageId);
		});
		this.broadcast({ type: "delivery.changed", messageId, status });
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
	}

	/** Applies an Email Sending lifecycle event. Returns false if the message isn't in this mailbox. */
	async applyDeliveryEvent(event: DeliveryEventInput): Promise<boolean> {
		const msg = this.sql
			.exec<{ id: string; thread_id: string }>(
				`SELECT m.id, m.thread_id FROM sends s JOIN messages m ON m.id = s.message_id WHERE s.provider_message_id = ?1`,
				ensureAngleBrackets(event.providerMessageId),
			)
			.toArray()[0];
		if (!msg) return false;

		this.sql.exec(
			`INSERT INTO deliveries (message_id, recipient, status, detail, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT (message_id, recipient) DO UPDATE SET status = excluded.status, detail = excluded.detail,
				updated_at = excluded.updated_at
			 WHERE excluded.updated_at >= deliveries.updated_at`,
			msg.id,
			normalizeAddress(event.recipient),
			event.status,
			event.detail,
			event.at,
		);
		this.broadcast({ type: "delivery.changed", messageId: msg.id, status: this.rollUpDelivery(msg.id) });
		return true;
	}

	/** Sets a message's status to the worst of its recipients' (summarizeDelivery) and returns it. */
	private rollUpDelivery(messageId: string): DeliveryStatus {
		const statuses = this.sql
			.exec<{ status: DeliveryStatus; detail: string | null }>(`SELECT status, detail FROM deliveries WHERE message_id = ?1`, messageId)
			.toArray();
		const summary = summarizeDelivery(statuses);
		this.sql.exec(
			`UPDATE messages SET delivery_status = ?2, delivery_detail = ?3 WHERE id = ?1`,
			messageId,
			summary.status,
			summary.detail,
		);
		return summary.status;
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

/** A composer upload that hasn't been given a permanent copy yet (see Mailbox.keepAttachments). */
function isUpload(a: StoredAttachment): boolean {
	return a.r2Key.startsWith("uploads/");
}

/** R2 failing mid-copy passes, so it's retried like a transient send error. */
function storageFailed(err: unknown): never {
	throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { code: "E_STORAGE" });
}

function buildSendRequest(p: OutboxPayload, attachments: EmailAttachment[]): EmailMessageBuilder {
	const toEmail = (a: Address) => (a.name ? { email: a.address, name: a.name } : a.address);
	const cc = p.cc.length ? { cc: p.cc.map(toEmail) } : {};
	const bcc = p.bcc.length ? { bcc: p.bcc.map(toEmail) } : {};
	// A retry to Bcc'd recipients alone has nobody in To, which Email Sending allows as long as there's a Bcc.
	const destinations: EmailDestinations = p.to.length ? { to: p.to.map(toEmail), ...cc, ...bcc } : { bcc: p.bcc.map(toEmail) };
	return {
		from: toEmail(p.from),
		...destinations,
		subject: p.subject,
		text: p.text,
		...(p.html ? { html: p.html } : {}),
		...(Object.keys(p.headers).length ? { headers: p.headers } : {}),
		...(attachments.length ? { attachments } : {}),
	};
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

function toMessageDetail(m: MessageRow, attachments: AttachmentRow[], undelivered: string[]): MessageDetail {
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
		delivery: m.delivery_status ? { status: m.delivery_status, detail: m.delivery_detail, undelivered } : null,
		auth: m.auth_json ? JSON.parse(m.auth_json) : null,
	};
}
