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
	type FailedMail,
	type InboundJob,
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
	type SenderCheck,
	type SendQueued,
	type StoredAttachment,
	stripSubaddress,
	type ThreadDetail,
	type ThreadSummary,
	ulid,
	type Verdict,
	withForward,
} from "#shared";
import { noteBody } from "#shared/markdown";
import { retryAddressing } from "./retry";
import { MIGRATIONS } from "./schema";

const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_SEND_ATTEMPTS = 8;
/** How soon R2 objects it wouldn't delete are tried again. */
const TRASH_RETRY_MS = 60_000;
/** Keys in trash no message has any more. A forward sends from the original's keys, so one can outlive its message. */
const DELETABLE_TRASH = `SELECT r2_key FROM trash t WHERE NOT EXISTS (SELECT 1 FROM attachments a WHERE a.r2_key = t.r2_key)`;
const OUTBOX_BATCH = 10;
const MAX_PARTICIPANTS = 12;
/**
 * Longer than the inbound queue keeps a message: 10 tries to parse it, then up to 10 more to list it under Failed, at
 * most an hour apart (worker/mail/inbound.ts, wrangler.jsonc).
 */
const INGEST_WINDOW_MS = 24 * 3600 * 1000;
/** Failed mail listed at once. counts() has the total. */
const FAILED_LIMIT = 200;
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
	verdict_json: string | null;
	delivery_status: DeliveryStatus | null;
	delivery_detail: string | null;
	labels: string;
}

interface ContactRow extends Row, Contact {}

interface FailedRow extends Row {
	id: string;
	raw_key: string;
	envelope_from: string;
	envelope_to: string;
	subaddress: string | null;
	raw_size: number;
	received_at: number;
	error: string | null;
	failed_at: number;
	retried_at: number | null;
}

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
/** IN_ADDRESSES for the failed table, whose rows carry the one address they were delivered to. */
const FAILED_IN_ADDRESSES = (param: string) => `(${param} IS NULL OR address IN (SELECT value FROM json_each(${param})))`;

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
		// Preserve pending mail cleanup too. A failed check or delete leaves storage and this alarm for a retry.
		await this.ctx.storage.setAlarm(Date.now() + TRASH_RETRY_MS);
		this.sql.exec(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('destroying', '1')`);
		await this.deleteOriginals();
		for (const prefix of [r2Keys.mailbox(mailboxId), r2Keys.upload(mailboxId, "")]) {
			let cursor: string | undefined;
			do {
				const page = await this.env.MAIL.list({ prefix, cursor });
				if (page.objects.length > 0) await this.env.MAIL.delete(page.objects.map((o) => o.key));
				cursor = page.truncated ? page.cursor : undefined;
			} while (cursor);
		}
		for (const ws of this.ctx.getWebSockets()) ws.close(1000, "mailbox deleted");
		await this.ctx.storage.deleteAll();
		await this.ctx.storage.deleteAlarm();
	}

	/**
	 * An original under raw/ is shared by every mailbox its message was delivered to, so it goes only once no mailbox
	 * left in the directory holds that message. A recent one may still be queued for another mailbox; it stays if the
	 * copy's `mailboxes` names one that's left, or if the copy predates `mailboxes` and can't say.
	 */
	private async deleteOriginals(): Promise<void> {
		const rows = this.sql
			.exec<{ id: string; raw_key: string; received_at: number }>(
				`SELECT id, raw_key, received_at FROM messages WHERE raw_key IS NOT NULL
				 UNION SELECT id, raw_key, received_at FROM deleted_messages WHERE raw_key IS NOT NULL
				 UNION SELECT id, raw_key, received_at FROM failed`,
			)
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

	/**
	 * Which of these messages this mailbox has, under Failed too, for a mailbox deleting them to check before it removes
	 * their originals.
	 */
	async holding(messageIds: string[]): Promise<string[]> {
		return this.sql
			.exec<{ id: string }>(
				`SELECT id FROM messages WHERE id IN (SELECT value FROM json_each(?1))
				 UNION SELECT id FROM failed WHERE id IN (SELECT value FROM json_each(?1))`,
				JSON.stringify(messageIds),
			)
			.toArray()
			.map((r) => r.id);
	}

	// ─── Inbound ────────────────────────────────────────────────────────────

	/** `inbox`: this delivery put new mail in the inbox, rather than in Spam or onto a copy already here. */
	async ingest(input: IngestInput): Promise<{ threadId: string; duplicate: boolean; inbox: boolean } | { deleted: true }> {
		if (this.sql.exec(`SELECT 1 FROM _meta WHERE key = 'destroying'`).toArray().length > 0) return { deleted: true };
		if (this.sql.exec(`SELECT 1 FROM deleted_messages WHERE id = ?1`, input.id).toArray().length > 0) {
			// The parser may already have rewritten these objects before it reached the tombstone.
			// Arm recovery before recording cleanup, so a crash cannot strand those bytes.
			await this.ctx.storage.setAlarm(Date.now());
			this.ctx.storage.transactionSync(() => {
				if (input.htmlKey) this.queueTrash(input.htmlKey);
				for (const a of input.attachments) this.queueTrash(a.r2Key);
				this.sql.exec(`UPDATE deleted_messages SET raw_key = ?2 WHERE id = ?1`, input.id, input.rawKey);
			});
			await this.emptyTrash();
			await this.scheduleOutbox();
			return { deleted: true };
		}
		const existing = this.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM messages WHERE id = ?1`, input.id).toArray()[0];
		if (existing) {
			this.clearFailed(input.id);
			return { threadId: existing.thread_id, duplicate: true, inbox: false };
		}

		const verdict = this.judge(input.sender);
		const labels = [placeFor(verdict), ...input.labels];

		// Same message delivered twice to this mailbox (e.g. sent to two of our addresses,
		// or our own outbound copy coming back): keep one copy, merge labels.
		if (input.messageIdHeader) {
			const twin = this.sql
				.exec<{ id: string; thread_id: string; direction: "in" | "out" }>(
					`SELECT id, thread_id, direction FROM messages WHERE message_id_header = ?1 OR provider_message_id = ?1 LIMIT 1`,
					input.messageIdHeader,
				)
				.toArray()[0];
			if (twin) {
				// Our own mail came back because it was sent to us too: it arrives like local delivery would leave it. A copy
				// that came in before keeps where its verdict put it, since this one's could disagree.
				this.addLabels([twin.id], twin.direction === "out" ? ["inbox", ...input.labels] : input.labels);
				this.addAddress(twin.id, stripSubaddress(input.envelopeTo).base);
				this.clearFailed(input.id);
				this.broadcast({ type: "threads.changed", threadIds: [twin.thread_id] });
				return { threadId: twin.thread_id, duplicate: true, inbox: false };
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
						date, received_at, text_body, html_key, raw_key, is_read, auth_json, verdict_json, sender)
					 VALUES (?1, ?2, 'in', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 0, ?19, ?20, ?21)
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
					JSON.stringify(verdict),
					input.sender.verified,
				)
				.one();

			this.addLabels([input.id], labels);
			this.addAddress(input.id, stripSubaddress(input.envelopeTo).base);
			for (const a of input.attachments) this.insertAttachment(input.id, a);
			if (input.messageIdHeader) this.registerRef(input.messageIdHeader, threadId);
			this.indexMessage(rowid, input.subject, input.from, [...input.to, ...input.cc], input.text);
			this.touchThread(threadId, input.date, snippet, [input.from, ...input.to, ...input.cc]);
			if (!labels.includes("spam")) this.recordContacts([input.from], false, input.date);
			// Delivered by a retry.
			this.sql.exec(`DELETE FROM failed WHERE id = ?1`, input.id);
			return threadId;
		});

		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return { threadId, duplicate: false, inbox: labels.includes("inbox") };
	}

	/**
	 * Where inbound mail goes, from what the queue checked of its sender and what this mailbox has said about them. A
	 * forged From address can't borrow anyone's standing: only a verified sender has one.
	 */
	private judge(sender: SenderCheck): Verdict {
		if (sender.spoofed) return { kind: "spoofed" };
		const judged = sender.verified
			? this.sql.exec<{ verdict: string }>(`SELECT verdict FROM senders WHERE address = ?1`, sender.verified).toArray()[0]
			: undefined;
		if (judged) return { kind: judged.verdict === "spam" ? "marked" : "trusted" };
		if (sender.internal) return { kind: "trusted" };
		return { kind: "unknown" };
	}

	/**
	 * Judges who verifiably sent these messages, so their next mail goes where this mail was put. Mail they didn't
	 * verifiably send says nothing about them.
	 */
	private judgeSenders(messageIds: string[], verdict: "trusted" | "spam"): void {
		this.sql.exec(
			`INSERT INTO senders (address, verdict)
			 SELECT DISTINCT sender, ?2 FROM messages WHERE id IN (SELECT value FROM json_each(?1)) AND direction = 'in' AND sender IS NOT NULL
			 ON CONFLICT (address) DO UPDATE SET verdict = excluded.verdict`,
			JSON.stringify(messageIds),
			verdict,
		);
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
	 * Remembers who this mailbox writes to (`sent`) and hears from, for recipient suggestions. Writing to someone also
	 * trusts their mail, even if it was marked as spam before. An undone send still counts: the address was typed on
	 * purpose.
	 */
	private recordContacts(people: Address[], sent: boolean, at: number): void {
		for (const p of people) {
			if (!isValidAddress(p.address)) continue;
			if (sent) {
				this.sql.exec(
					`INSERT INTO senders (address, verdict) VALUES (?1, 'trusted') ON CONFLICT (address) DO UPDATE SET verdict = 'trusted'`,
					normalizeAddress(p.address),
				);
			}
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

	/** Draft-file cleanup must keep originals until a queued send has copied them. */
	async holdsFile(key: string): Promise<boolean> {
		return this.sql.exec(`SELECT 1 FROM attachments WHERE r2_key = ?1 LIMIT 1`, key).toArray().length > 0;
	}

	/** A saved draft's stable send id also recovers an acknowledgement lost after the queue insert. */
	async queuedSend(id: string): Promise<SendQueued | null> {
		const row = this.sql.exec<{ thread_id: string; date: number }>(`SELECT thread_id, date FROM messages WHERE id = ?1`, id).toArray()[0];
		if (!row) return null;
		await this.scheduleOutbox();
		return { id, threadId: row.thread_id, sendAt: row.date };
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
		const failed = this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM failed WHERE ${FAILED_IN_ADDRESSES("?1")}`, addressParam(query)).one().n;
		return { labels, addresses, failed };
	}

	// ─── Failed ─────────────────────────────────────────────────────────────

	/**
	 * Lists inbound mail the queue gave up on under Failed, or updates the error of mail already there. Mail this mailbox
	 * has, or has deleted, stays out: an attempt that got it here can still fail on something after. A try with no error
	 * to report (inbound.ts) keeps the last one.
	 */
	async recordFailed(job: InboundJob, error: string | null): Promise<void> {
		if (this.sql.exec(`SELECT 1 FROM _meta WHERE key = 'destroying'`).toArray().length > 0) return;
		const known = this.sql.exec(`SELECT 1 FROM messages WHERE id = ?1 UNION ALL SELECT 1 FROM deleted_messages WHERE id = ?1`, job.ingestId);
		if (known.toArray().length > 0) return;
		this.sql.exec(
			`INSERT INTO failed (id, raw_key, envelope_from, envelope_to, address, subaddress, raw_size, received_at, error, failed_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
			 ON CONFLICT (id) DO UPDATE SET error = coalesce(excluded.error, failed.error), failed_at = excluded.failed_at`,
			job.ingestId,
			job.rawKey,
			job.envelopeFrom,
			job.envelopeTo,
			stripSubaddress(job.envelopeTo).base,
			job.subaddress,
			job.rawSize,
			job.receivedAt,
			error,
			Date.now(),
		);
		this.broadcast({ type: "failed.changed" });
	}

	/** Newest first. */
	async listFailed(query: AddressFilter): Promise<FailedMail[]> {
		return this.sql
			.exec<FailedRow>(
				`SELECT * FROM failed WHERE ${FAILED_IN_ADDRESSES("?1")} ORDER BY received_at DESC, id DESC LIMIT ?2`,
				addressParam(query),
				FAILED_LIMIT,
			)
			.toArray()
			.map((r) => ({
				id: r.id,
				from: r.envelope_from,
				to: r.envelope_to,
				size: r.raw_size,
				receivedAt: r.received_at,
				error: r.error,
				// A retry can only follow the failure it retries, even within the same millisecond. One older than the queue keeps
				// a job was dropped without being listed again, so it can be retried again.
				retrying: r.retried_at !== null && r.retried_at >= r.failed_at && r.retried_at > Date.now() - INGEST_WINDOW_MS,
			}));
	}

	/** Queues failed mail to be parsed again. It leaves Failed once ingest() delivers it, or comes back if it fails again. */
	async retryFailed(id: string): Promise<boolean> {
		const row = this.sql.exec<FailedRow>(`SELECT * FROM failed WHERE id = ?1`, id).toArray()[0];
		if (!row) return false;
		const job: InboundJob = {
			v: 1,
			ingestId: row.id,
			rawKey: row.raw_key,
			rawSize: row.raw_size,
			mailboxId: this.mailboxId(),
			envelopeFrom: row.envelope_from,
			envelopeTo: row.envelope_to,
			subaddress: row.subaddress,
			receivedAt: row.received_at,
		};
		await this.env.INBOUND.send(job);
		// Changes nothing if the retry delivered it, or someone deleted it, while it was being queued.
		this.sql.exec(`UPDATE failed SET retried_at = ?2 WHERE id = ?1`, id, Date.now());
		this.broadcast({ type: "failed.changed" });
		return true;
	}

	/**
	 * Deletes failed mail for good, as permanent deletion does: the tombstone keeps a retry still queued from delivering
	 * it, and its original goes once no other mailbox holds it (deleteTrashedOriginals). Files an attempt extracted
	 * before it failed go through trash; no row names them, so they're found by their prefix.
	 */
	async deleteFailed(id: string): Promise<boolean> {
		if (this.sql.exec(`SELECT 1 FROM failed WHERE id = ?1`, id).toArray().length === 0) return false;
		// Listed before anything changes, so a failed listing leaves the mail under Failed to delete again.
		const extracted: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.env.MAIL.list({ prefix: r2Keys.message(this.mailboxId(), id), cursor });
			extracted.push(...page.objects.map((o) => o.key));
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		// Armed before the commit, as deleteTrash() does, so a crash after it still has an alarm to finish the cleanup.
		await this.ctx.storage.setAlarm(Date.now());
		const deleted = this.ctx.storage.transactionSync(() => {
			// Checked again: it can have been delivered or deleted while the files were listed.
			const row = this.sql.exec<{ raw_key: string; received_at: number }>(`SELECT raw_key, received_at FROM failed WHERE id = ?1`, id).toArray()[0];
			if (!row) return false;
			this.sql.exec(`DELETE FROM failed WHERE id = ?1`, id);
			this.sql.exec(`INSERT OR IGNORE INTO deleted_messages (id, raw_key, received_at) VALUES (?1, ?2, ?3)`, id, row.raw_key, row.received_at);
			for (const key of extracted) this.queueTrash(key);
			return true;
		});
		if (!deleted) return false;
		await this.emptyTrash();
		await this.scheduleOutbox();
		this.broadcast({ type: "failed.changed" });
		return true;
	}

	/** Where failed mail's original is, to download it. */
	async failedRawKey(id: string): Promise<string | null> {
		return this.sql.exec<{ raw_key: string }>(`SELECT raw_key FROM failed WHERE id = ?1`, id).toArray()[0]?.raw_key ?? null;
	}

	/** For ingest() paths that find the message already here. */
	private clearFailed(id: string): void {
		if (this.sql.exec(`DELETE FROM failed WHERE id = ?1`, id).rowsWritten > 0) this.broadcast({ type: "failed.changed" });
	}

	// ─── Mutations ──────────────────────────────────────────────────────────

	/** Deletes only mail still in Trash at commit time, never an untrashed reply or an active send. Idempotent. */
	async deleteTrash(input: AddressFilter & { threadId?: string }): Promise<{ blocked: boolean; deleted: number }> {
		// This alarm is durable before the transaction. It recovers cleanup after a crash or a lost response.
		await this.ctx.storage.setAlarm(Date.now());
		const result = this.ctx.storage.transactionSync(() => {
			const messages = this.sql.exec<{
				id: string; thread_id: string; html_key: string | null; raw_key: string | null; received_at: number; pending: number;
			}>(
				`SELECT m.id, m.thread_id, m.html_key, m.raw_key, m.received_at,
					EXISTS (SELECT 1 FROM outbox o WHERE o.message_id = m.id) OR m.delivery_status = 'sending' AS pending
				 FROM messages m JOIN message_labels l ON l.message_id = m.id AND l.label = 'trash'
				 WHERE (?1 IS NULL OR m.thread_id = ?1) AND ${IN_ADDRESSES("?2")}`,
				input.threadId ?? null, addressParam(input),
			).toArray();
			if (messages.some((m) => m.pending)) return { blocked: true, deleted: 0, threadIds: [] };
			const ids = JSON.stringify(messages.map((m) => m.id));
			const attachments = this.sql.exec<{ r2_key: string }>(
				`SELECT r2_key FROM attachments WHERE message_id IN (SELECT value FROM json_each(?1))`, ids,
			).toArray();
			for (const a of attachments) this.queueTrash(a.r2_key);
			for (const m of messages) {
				if (m.html_key) this.queueTrash(m.html_key);
				this.sql.exec(`INSERT INTO deleted_messages (id, raw_key, received_at) VALUES (?1, ?2, ?3)`, m.id, m.raw_key, m.received_at);
			}
			this.sql.exec(`DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages WHERE id IN (SELECT value FROM json_each(?1)))`, ids);
			// Foreign keys cascade labels, addresses, files, delivery state, and send ids together.
			this.sql.exec(`DELETE FROM messages WHERE id IN (SELECT value FROM json_each(?1))`, ids);
			const threadIds = [...new Set(messages.map((m) => m.thread_id))];
			for (const id of threadIds) this.rebuildThread(id);
			return { blocked: false, deleted: messages.length, threadIds };
		});
		if (result.threadIds.length > 0) this.broadcast({ type: "threads.changed", threadIds: result.threadIds });
		await this.emptyTrash();
		await this.deleteTrashedOriginals();
		await this.scheduleOutbox();
		return { blocked: result.blocked, deleted: result.deleted };
	}

	private queueTrash(key: string): void {
		// Draft sources can still belong to another draft. Only the account's reference-aware cleanup owns them.
		if (isDraftFile(key)) return;
		this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, key);
	}

	/** Rebuild previews from surviving messages so deleted text and participants never linger in the list. */
	private rebuildThread(threadId: string): void {
		const left = this.sql.exec<{ date: number; snippet: string; from_json: string; to_json: string; cc_json: string }>(
			`SELECT date, snippet, from_json, to_json, cc_json FROM messages WHERE thread_id = ?1 ORDER BY date, id`, threadId,
		).toArray();
		if (left.length === 0) {
			this.sql.exec(`DELETE FROM threads WHERE id = ?1`, threadId);
			return;
		}
		this.sql.exec(`UPDATE threads SET snippet = '', last_message_at = 0, participants = '[]' WHERE id = ?1`, threadId);
		for (const m of left) this.touchThread(threadId, m.date, m.snippet, [JSON.parse(m.from_json), ...JSON.parse(m.to_json), ...JSON.parse(m.cc_json)]);
	}

	async modifyThreads(input: { threadIds: string[]; add?: string[]; remove?: string[] }): Promise<void> {
		const add = input.add ?? [];
		// Trash and spam imply leaving the inbox.
		const remove = [...(input.remove ?? []), ...(add.some((l) => l === "trash" || l === "spam") ? ["inbox"] : [])];
		this.ctx.storage.transactionSync(() => {
			const ids = this.messageIdsForThreads(input.threadIds);
			// Spam and Not spam teach it about the senders.
			if (add.includes("spam")) this.judgeSenders(this.reported(ids), "spam");
			else if (remove.includes("spam") && add.includes("inbox")) this.judgeSenders(this.labeled(ids, "spam"), "trusted");
			this.removeLabels(ids, remove);
			this.addLabels(ids, add);
		});
		this.broadcast({ type: "threads.changed", threadIds: input.threadIds });
	}

	/**
	 * A banner's answer about one inbound message: Not spam (trusted) or Spam. It moves only that message and judges only
	 * its sender, whoever else is in the thread. False if there's no such inbound message.
	 */
	async judgeMessage(input: { messageId: string; verdict: "trusted" | "spam" }): Promise<boolean> {
		const threadId = this.ctx.storage.transactionSync(() => {
			const row = this.sql
				.exec<{ thread_id: string }>(`SELECT thread_id FROM messages WHERE id = ?1 AND direction = 'in'`, input.messageId)
				.toArray()[0];
			if (!row) return null;
			const ids = [input.messageId];
			this.judgeSenders(ids, input.verdict);
			// Out of Spam is into the inbox, not left in Trash too, as Move to inbox does.
			this.removeLabels(ids, input.verdict === "spam" ? ["inbox"] : ["spam", "trash"]);
			this.addLabels(ids, [input.verdict === "spam" ? "spam" : "inbox"]);
			return row.thread_id;
		});
		if (threadId === null) return false;
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return true;
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

	/**
	 * Of these messages, the ones whose senders a Spam click on their threads reports. A thread from one sender speaks for
	 * them. In a conversation with several, someone already trusted isn't reported for what the others sent. Mail no one
	 * verifiably sent counts as someone else, even under a trusted sender's address: it may be forged to get them reported.
	 */
	private reported(messageIds: string[]): string[] {
		const rows = this.sql
			.exec<{ id: string; thread_id: string; sender: string | null; from_address: string; trusted: number }>(
				`SELECT m.id, m.thread_id, m.sender, lower(json_extract(m.from_json, '$.address')) AS from_address,
					json_extract(m.verdict_json, '$.kind') = 'trusted' OR EXISTS (SELECT 1 FROM senders s WHERE s.address = m.sender AND s.verdict = 'trusted') AS trusted
				 FROM messages m WHERE m.id IN (SELECT value FROM json_each(?1)) AND m.direction = 'in'`,
				JSON.stringify(messageIds),
			)
			.toArray();
		const people = new Map<string, Set<string>>();
		for (const r of rows) people.set(r.thread_id, (people.get(r.thread_id) ?? new Set()).add(r.sender ?? `unverified:${r.from_address}`));
		return rows.filter((r) => r.sender !== null && ((people.get(r.thread_id)?.size ?? 0) <= 1 || !r.trusted)).map((r) => r.id);
	}

	private labeled(messageIds: string[], label: string): string[] {
		return this.sql
			.exec<{ message_id: string }>(
				`SELECT message_id FROM message_labels WHERE label = ?2 AND message_id IN (SELECT value FROM json_each(?1))`,
				JSON.stringify(messageIds),
				label,
			)
			.toArray()
			.map((r) => r.message_id);
	}

	private messageIdsForThreads(threadIds: string[]): string[] {
		return threadIds.flatMap((t) =>
			this.sql.exec<{ id: string }>(`SELECT id FROM messages WHERE thread_id = ?1`, t).toArray().map((r) => r.id),
		);
	}

	// ─── Outbound ───────────────────────────────────────────────────────────

	/** Null when a forward's original was cancelled while the forward was put together, taking its files with it. */
	async enqueueSend(input: SendInput): Promise<SendQueued | null> {
		if (!input.id) return this.enqueueSendOnce(input);
		const pending = this.pendingSends.get(input.id);
		if (pending) return pending;
		// Coalesce concurrent retries before R2 I/O, so a duplicate cannot overwrite the HTML with new file-link tokens.
		const task = this.enqueueSendOnce(input);
		this.pendingSends.set(input.id, task);
		try {
			return await task;
		} finally {
			this.pendingSends.delete(input.id);
		}
	}

	private readonly pendingSends = new Map<string, Promise<SendQueued | null>>();

	private async enqueueSendOnce(input: SendInput): Promise<SendQueued | null> {
		this.bindMailboxId(input.mailboxId);
		if (input.id) {
			const queued = await this.queuedSend(input.id);
			if (queued) return queued;
		}
		const now = Date.now();
		const id = input.id ?? ulid(now);
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
		// A forward's files are the original's (keepAttachments copies only composer sources). Asked with the insert,
		// so either the original's cancel sees this message has them (emptyTrash) or this sees they're gone.
		const forwarded = attachments.filter((a) => !needsAttachmentCopy(a)).map((a) => a.r2Key);
		const threadId = this.ctx.storage.transactionSync(() => {
			// Another retry can commit while HTML is written. Check in the insert's transaction, after the await.
			const existing = this.sql.exec<{ thread_id: string }>(`SELECT thread_id FROM messages WHERE id = ?1`, id).toArray()[0];
			if (existing) return existing.thread_id;
			if (forwarded.some((key) => this.sql.exec(`SELECT 1 FROM attachments WHERE r2_key = ?1`, key).toArray().length === 0)) return null;
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
		if (threadId === null) {
			if (htmlKey) this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, htmlKey);
			await this.emptyTrash();
			return null;
		}

		await this.scheduleOutbox();
		this.broadcast({ type: "threads.changed", threadIds: [threadId] });
		return this.queuedSend(id);
	}

	/**
	 * Undo send: only possible while the message is still waiting in the outbox. Not for a retry of mail that
	 * already went out to someone, since undoing deletes the message.
	 */
	async cancelSend(messageId: string): Promise<boolean> {
		const row = this.sql
			.exec<{ thread_id: string; rowid: number; html_key: string | null }>(
				`SELECT m.thread_id, m.rowid, m.html_key FROM outbox o JOIN messages m ON m.id = o.message_id
				 WHERE o.message_id = ?1 AND m.delivery_status = 'queued' AND m.provider_message_id IS NULL`,
				messageId,
			)
			.toArray()[0];
		if (!row) return false;
		// Its own files in R2 go with it: copies an attempt made (keepAttachments), a retry's, and its body. A forward's are
		// the original's, and trash keeps any another message still has. Composer sources stay for Undo's new draft.
		// (An attempt still copying clears up after itself.)
		const own = this.sql
			.exec<{ id: string; r2_key: string }>(`SELECT id, r2_key FROM attachments WHERE message_id = ?1`, messageId)
			.toArray()
			.filter((a) => a.r2_key === r2Keys.attachment(this.mailboxId(), messageId, a.id))
			.map((a) => a.r2_key);
		if (row.html_key) own.push(row.html_key);
		this.ctx.storage.transactionSync(() => {
			for (const key of own) this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, key);
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
		await this.emptyTrash();
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
		if (this.sql.exec(`SELECT 1 FROM _meta WHERE key = 'destroying'`).toArray().length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + TRASH_RETRY_MS);
			return;
		}
		const due = this.sql.exec<{ at: number | null }>(`SELECT min(send_at) AS at FROM outbox`).one().at;
		const retry = this.sql.exec(`${DELETABLE_TRASH} LIMIT 1`).toArray().length > 0 ? Date.now() + TRASH_RETRY_MS : null;
		const raw = this.sql.exec<{ at: number | null }>(`SELECT min(received_at) + ?1 AS at FROM deleted_messages WHERE raw_key IS NOT NULL`, INGEST_WINDOW_MS).one().at;
		const times = [due, retry, raw === null ? null : Math.max(raw, Date.now() + TRASH_RETRY_MS)].filter((at) => at !== null);
		const next = times.length > 0 ? Math.min(...times) : null;
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
		if (this.sql.exec(`SELECT 1 FROM _meta WHERE key = 'destroying'`).toArray().length > 0) return this.destroy();
		await this.emptyTrash();
		await this.deleteTrashedOriginals();
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
			await this.emptyTrash();
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
	 * Composer files get a permanent copy with each sent message. Legacy uploads may expire; account-owned draft
	 * sources can be shared by conflict copies and are kept until draft cleanup finds no references.
	 * The payload still names the sources, so a retry skips any whose row already moved.
	 * Streamed rather than buffered: linked files run up to MAX_UPLOAD_BYTES.
	 */
	private async keepAttachments(messageId: string, attachments: StoredAttachment[]): Promise<StoredAttachment[]> {
		const kept: StoredAttachment[] = [];
		for (const a of attachments) {
			if (!needsAttachmentCopy(a)) {
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
	 * Removes what keepAttachments made for a message that won't be sent. Its sources stay for Undo's new draft.
	 * The copies go through trash, so any R2 won't delete now are tried again rather than left for good.
	 */
	private async deleteCopies(messageId: string, attachments: StoredAttachment[]): Promise<void> {
		for (const a of attachments.filter(needsAttachmentCopy)) {
			this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, r2Keys.attachment(this.mailboxId(), messageId, a.id));
		}
		await this.emptyTrash();
	}

	/**
	 * Deletes from R2 what's in trash and no message has. Whatever R2 refuses stays, and the alarm comes back for it
	 * (scheduleOutbox), as it does once the last message to have one is cancelled too.
	 */
	private async emptyTrash(): Promise<void> {
		const keys = this.sql.exec<{ r2_key: string }>(`${DELETABLE_TRASH} LIMIT 1000`).toArray().map((r) => r.r2_key);
		if (keys.length === 0) return;
		const deleted = await this.env.MAIL.delete(keys).then(
			() => true,
			() => false,
		);
		if (deleted) this.sql.exec(`DELETE FROM trash WHERE r2_key IN (SELECT value FROM json_each(?1))`, JSON.stringify(keys));
		// More than one batch, or an R2 failure: remaining work always gets another alarm.
		await this.scheduleOutbox();
	}

	/** Shared originals wait out inbound retries, then go only if every other mailbox has let them go. */
	private async deleteTrashedOriginals(): Promise<void> {
		const rows = this.sql.exec<{ id: string; raw_key: string }>(
			`SELECT id, raw_key FROM deleted_messages WHERE raw_key IS NOT NULL AND received_at <= ?1 LIMIT 1000`,
			Date.now() - INGEST_WINDOW_MS,
		).toArray();
		if (rows.length === 0) return;
		try {
			const { results } = await this.env.DIRECTORY.prepare(`SELECT id FROM mailboxes WHERE id != ?1`).bind(this.mailboxId()).all<{ id: string }>();
			const held = new Set((await Promise.all(results.map((m) => this.env.MAILBOX.getByName(m.id).holding(rows.map((r) => r.id))))).flat());
			const keys = rows.filter((r) => !held.has(r.id)).map((r) => r.raw_key);
			if (keys.length > 0) await this.env.MAIL.delete(keys);
			// Another holder owns its original's eventual cleanup. Keep the id even after cleanup to block replay.
			for (const row of rows) this.sql.exec(`UPDATE deleted_messages SET raw_key = NULL WHERE id = ?1 AND raw_key = ?2`, row.id, row.raw_key);
		} catch (error) {
			console.error(JSON.stringify({ msg: "deleted originals cleanup failed", mailboxId: this.mailboxId(), error: String(error) }));
			// Fail closed: keep the jobs and retry both failed checks and failed R2 deletes.
			await this.scheduleOutbox();
		}
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
			// Commit legacy-upload cleanup with the send. Shared draft sources belong to cleanDraftFiles instead.
			for (const a of sent.payload.attachments.filter((file) => file.r2Key.startsWith("uploads/"))) {
				this.sql.exec(`INSERT OR IGNORE INTO trash (r2_key) VALUES (?1)`, a.r2Key);
			}
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

/** Composer sources need per-message copies, independently of who owns their eventual cleanup. */
function needsAttachmentCopy(a: StoredAttachment): boolean {
	return a.r2Key.startsWith("uploads/") || isDraftFile(a.r2Key);
}

function isDraftFile(key: string): boolean { return /^m\/[^/]+\/draft-files\//.test(key); }

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
		verdict: m.verdict_json ? JSON.parse(m.verdict_json) : null,
	};
}

/** Where a verdict puts inbound mail. */
function placeFor(verdict: Verdict): string {
	return verdict.kind === "spoofed" || verdict.kind === "marked" ? "spam" : "inbox";
}
