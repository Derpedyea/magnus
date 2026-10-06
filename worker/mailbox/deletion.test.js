// Run production mailbox queries against SQLite; only Cloudflare I/O and time are substituted.
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mailbox } from "./mailbox";

vi.mock("cloudflare:workers", () => ({
    DurableObject: class {
        constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    },
}));

const NOW = Date.UTC(2026, 9, 2);
const DAY = 24 * 3600 * 1000;
const databases = [];

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("WebSocketRequestResponsePair", class {});
});
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function mailbox() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    // SqlStorage.exec accepts multiple statements for migrations; ordinary calls expose a cursor.
    const sql = { exec(query, ...bindings) {
        if (bindings.length === 0 && query.includes("CREATE TABLE")) {
            db.exec(query);
            return { toArray: () => [] };
        }
        const rows = db.prepare(query).all(...bindings);
        return { toArray: () => rows, one: () => {
            if (rows.length !== 1) throw new Error("Expected one row");
            return rows[0];
        } };
    } };
    let alarm = null;
    const storage = {
        sql,
        transactionSync: (action) => {
            db.exec("BEGIN");
            try { const result = action(); db.exec("COMMIT"); return result; }
            catch (error) { db.exec("ROLLBACK"); throw error; }
        },
        getAlarm: vi.fn(async () => alarm),
        setAlarm: vi.fn(async (at) => { alarm = at; }),
        deleteAlarm: vi.fn(async () => { alarm = null; }),
        deleteAll: vi.fn(async () => {
            db.exec("PRAGMA foreign_keys = OFF");
            for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%'").all())
                db.exec(`DELETE FROM ${name}`);
            db.exec("PRAGMA foreign_keys = ON");
        }),
    };
    const ctx = {
        id: { name: "mb" }, storage,
        setWebSocketAutoResponse: vi.fn(),
        blockConcurrencyWhile: (action) => action(),
        getWebSockets: () => [],
    };
    const bucket = { delete: vi.fn(async () => {}), list: vi.fn(async () => ({ objects: [], truncated: false })), head: vi.fn(async () => ({ customMetadata: { mailboxes: "mb" } })) };
    const holding = vi.fn(async () => []);
    const directory = { all: vi.fn(async () => ({ results: [] })) };
    const env = {
        MAIL: bucket,
        DIRECTORY: { prepare: () => ({ ...directory, bind: () => directory }) },
        MAILBOX: { getByName: () => ({ holding }) },
    };
    const box = new Mailbox(ctx, env);
    return { box, sql, db, storage, bucket, directory, holding, runAlarm: async () => { alarm = null; await box.alarm(); }, get alarm() { return alarm; } };
}

function message(id, options = {}) {
    return {
        id, rawKey: `raw/${id}`, receivedAt: NOW - 2 * DAY,
        envelopeFrom: "sender@example.org", envelopeTo: "me@example.com",
        messageIdHeader: `<${id}@example.org>`, inReplyTo: [], references: [],
        from: { address: "sender@example.org" }, to: [{ address: "me@example.com" }],
        cc: [], replyTo: [], subject: "Order receipt", date: NOW - DAY, text: `Body ${id}`,
        htmlKey: `m/mb/${id}/body.html`, attachments: [], auth: null, sender: { verified: null, internal: false, spoofed: false }, check: null, labels: ["trash"],
        ...options,
    };
}
function attachment(id, key = `m/mb/original/att/${id}`) {
    return { id, r2Key: key, filename: "receipt.pdf", contentType: "application/pdf", size: 10, contentId: null, inline: false, link: { token: `token-${id}`, shared: true } };
}

// These repeat with a fixed clock and injected I/O; no timers or sleeps drive assertions.
describe("permanent deletion", () => {
    it("removes message content, search, labels, files, delivery state, send ids and the empty thread; retries are idempotent", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one", { attachments: [attachment("file")] }));
        h.sql.exec("INSERT INTO deliveries VALUES (?1, ?2, 'delivered', NULL, ?3)", "one", "me@example.com", NOW);
        h.sql.exec("INSERT INTO sends VALUES (?1, ?2)", "provider-id", "one");
        await expect(h.box.deleteTrash({ threadId })).resolves.toEqual({ blocked: false, deleted: 1 });
        expect(await h.box.getThread(threadId)).toBeNull();
        for (const table of ["messages", "messages_fts", "attachments", "message_labels", "message_addresses", "deliveries", "sends", "thread_refs", "trash"])
            expect(h.sql.exec(`SELECT * FROM ${table}`).toArray()).toEqual([]);
        expect(await h.box.search({ query: "Body one" })).toEqual([]);
        expect(await h.box.getLinkedFile("token-file")).toBeNull();
        expect(h.bucket.delete.mock.calls.flat(2)).toEqual(expect.arrayContaining(["m/mb/one/body.html", "m/mb/original/att/file", "raw/one"]));
        await expect(h.box.deleteTrash({ threadId })).resolves.toEqual({ blocked: false, deleted: 0 });
    });

    it("keeps an inbox reply and rebuilds the conversation preview without deleted participants or text", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("old", { date: NOW, from: { address: "old@example.org" } }));
        await h.box.ingest(message("reply", { inReplyTo: ["<old@example.org>"], labels: ["inbox"], date: NOW - 1, text: "Kept reply", from: { address: "new@example.org" } }));
        await h.box.deleteTrash({ threadId });
        const detail = await h.box.getThread(threadId);
        expect(detail.messages.map((m) => m.id)).toEqual(["reply"]);
        expect(detail.thread.snippet).toBe("Kept reply");
        expect(detail.thread.participants.map((p) => p.address)).not.toContain("old@example.org");
        expect(detail.thread.lastMessageAt).toBe(NOW - 1);
    });

    it("emptying filtered Trash removes only matching messages, across more than one list page", async () => {
        const h = mailbox();
        for (let i = 0; i < 55; i++) await h.box.ingest(message(`one-${i}`));
        await h.box.ingest(message("other", { envelopeTo: "other@example.com" }));
        await h.box.ingest(message("inbox", { labels: ["inbox"] }));
        await expect(h.box.deleteTrash({ addresses: ["me@example.com"] })).resolves.toEqual({ blocked: false, deleted: 55 });
        expect(h.sql.exec("SELECT id FROM messages ORDER BY id").toArray().map((m) => m.id)).toEqual(["inbox", "other"]);
        await expect(h.box.deleteTrash({ addresses: [] })).resolves.toEqual({ blocked: false, deleted: 0 });
    });

    it.each(["queued", "sending"])("blocks a %s send without deleting any selected mail", async (status) => {
        const h = mailbox();
        await h.box.ingest(message("safe"));
        await h.box.ingest(message("pending"));
        h.sql.exec("UPDATE messages SET delivery_status = ?1 WHERE id = 'pending'", status);
        if (status === "queued") h.sql.exec("INSERT INTO outbox VALUES ('pending', ?1, 0, '{}')", NOW + DAY);
        await expect(h.box.deleteTrash({})).resolves.toEqual({ blocked: true, deleted: 0 });
        expect(h.sql.exec("SELECT count(*) AS n FROM messages").one().n).toBe(2);
        expect(h.bucket.delete).not.toHaveBeenCalled();
    });

    it("rechecks Trash after arming the alarm, so a concurrent restore is respected", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("restore"));
        h.storage.setAlarm.mockImplementationOnce(async () => {
            await h.box.modifyThreads({ threadIds: [threadId], add: ["inbox"], remove: ["trash"] });
        });
        await expect(h.box.deleteTrash({ threadId })).resolves.toEqual({ blocked: false, deleted: 0 });
        expect((await h.box.getThread(threadId)).messages).toHaveLength(1);
    });

    it("fails before deleting mail if crash recovery cannot be scheduled", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one"));
        h.storage.setAlarm.mockRejectedValueOnce(new Error("Storage unavailable"));
        await expect(h.box.deleteTrash({ threadId })).rejects.toThrow("Storage unavailable");
        expect((await h.box.getThread(threadId)).messages).toHaveLength(1);
    });

    it("a crash after committing deletion leaves durable cleanup jobs for the next alarm", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one"));
        h.storage.getAlarm.mockRejectedValueOnce(new Error("interrupted"));
        await expect(h.box.deleteTrash({ threadId })).rejects.toThrow("interrupted");
        expect(await h.box.getThread(threadId)).toBeNull();
        expect(h.alarm).toBe(NOW);
        await h.runAlarm();
        expect(h.sql.exec("SELECT raw_key FROM deleted_messages").one().raw_key).toBeNull();
        expect(h.bucket.delete.mock.calls.flat(2)).toContain("raw/one");
    });

    it("retries failed object deletion without bringing back the message", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one"));
        h.bucket.delete.mockRejectedValueOnce(new Error("R2 unavailable"));
        await h.box.deleteTrash({ threadId });
        expect(await h.box.getThread(threadId)).toBeNull();
        expect(h.sql.exec("SELECT * FROM trash").toArray()).toHaveLength(1);
        expect(h.alarm).toBeLessThanOrEqual(NOW + 60_000);
        await h.runAlarm();
        expect(h.sql.exec("SELECT * FROM trash").toArray()).toEqual([]);
    });

    it("a surviving forward holds the file until it too is deleted", async () => {
        const h = mailbox();
        const file = attachment("file");
        const original = await h.box.ingest(message("one", { attachments: [file] }));
        const forward = await h.box.ingest(message("two", { labels: ["sent"], attachments: [attachment("forward-file", file.r2Key)] }));
        await h.box.deleteTrash({ threadId: original.threadId });
        expect(h.bucket.delete.mock.calls.flat(2)).not.toContain(file.r2Key);
        await h.box.modifyThreads({ threadIds: [forward.threadId], add: ["trash"] });
        await h.box.deleteTrash({ threadId: forward.threadId });
        expect(h.bucket.delete.mock.calls.flat(2)).toContain(file.r2Key);
    });

    it("a retry of inbound parsing cannot resurrect deleted mail, and its rewritten files are cleaned again", async () => {
        const h = mailbox();
        const input = message("one", { attachments: [attachment("file")] });
        const { threadId } = await h.box.ingest(input);
        await h.box.deleteTrash({ threadId });
        await expect(h.box.ingest(input)).resolves.toEqual({ deleted: true });
        expect(await h.box.getThread(threadId)).toBeNull();
        expect(h.bucket.delete.mock.calls.filter(([keys]) => keys.includes(input.htmlKey))).toHaveLength(2);
    });

    it("retains a recent shared original for queued delivery, then deletes it after the retry window", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one", { receivedAt: NOW }));
        await h.box.deleteTrash({ threadId });
        expect(h.bucket.delete.mock.calls.flat(2)).not.toContain("raw/one");
        await h.runAlarm();
        expect(h.alarm).toBe(NOW + DAY);
        vi.setSystemTime(NOW + DAY);
        await h.runAlarm();
        expect(h.bucket.delete.mock.calls.flat(2)).toContain("raw/one");
    });

    it("retains an original held by another mailbox, whose deletion owns eventual cleanup", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one"));
        h.directory.all.mockResolvedValue({ results: [{ id: "other" }] });
        h.holding.mockResolvedValue(["one"]);
        await h.box.deleteTrash({ threadId });
        expect(h.bucket.delete.mock.calls.flat(2)).not.toContain("raw/one");
        expect(h.sql.exec("SELECT raw_key FROM deleted_messages").one().raw_key).toBeNull();
    });

    it.each(["directory", "holding", "delete"])("retries a failed %s check/delete and fails closed on shared originals", async (failure) => {
        const h = mailbox();
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { threadId } = await h.box.ingest(message("one"));
        if (failure === "directory") h.directory.all.mockRejectedValueOnce(new Error("Directory unavailable"));
        if (failure === "holding") {
            h.directory.all.mockResolvedValue({ results: [{ id: "other" }] });
            h.holding.mockRejectedValueOnce(new Error("Mailbox unavailable"));
        }
        if (failure === "delete") h.bucket.delete.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error("R2 unavailable"));
        await h.box.deleteTrash({ threadId });
        expect(h.sql.exec("SELECT raw_key FROM deleted_messages").one().raw_key).toBe("raw/one");
        expect(h.alarm).toBeLessThanOrEqual(NOW + 60_000);
        await h.runAlarm();
        expect(h.sql.exec("SELECT raw_key FROM deleted_messages").one().raw_key).toBeNull();
    });

    it("cleanup beyond one R2 batch always schedules another alarm", async () => {
        const h = mailbox();
        for (let i = 0; i < 1001; i++) h.sql.exec("INSERT INTO trash VALUES (?1)", `orphan-${i}`);
        await h.runAlarm();
        expect(h.sql.exec("SELECT count(*) AS n FROM trash").one().n).toBe(1);
        expect(h.alarm).toBeLessThanOrEqual(NOW + 60_000);
        await h.runAlarm();
        expect(h.sql.exec("SELECT count(*) AS n FROM trash").one().n).toBe(0);
    });

    it("destroying the mailbox also removes originals awaiting permanent-deletion cleanup", async () => {
        const h = mailbox();
        const { threadId } = await h.box.ingest(message("one", { receivedAt: NOW }));
        await h.box.deleteTrash({ threadId });
        await h.box.destroy();
        expect(h.bucket.delete.mock.calls.flat(2)).toContain("raw/one");
        expect(h.storage.deleteAll).toHaveBeenCalledOnce();
        expect(h.alarm).toBeNull();
    });

    it("a failed mailbox destruction preserves pending cleanup, blocks inbound revival, and retries on its alarm", async () => {
        const h = mailbox();
        const input = message("one", { receivedAt: NOW });
        const { threadId } = await h.box.ingest(input);
        await h.box.deleteTrash({ threadId });
        h.directory.all.mockRejectedValueOnce(new Error("Directory unavailable"));
        await expect(h.box.destroy()).rejects.toThrow("Directory unavailable");
        expect(h.storage.deleteAll).not.toHaveBeenCalled();
        expect(h.alarm).toBe(NOW + 60_000);
        await expect(h.box.ingest(input)).resolves.toEqual({ deleted: true });
        await h.runAlarm();
        expect(h.bucket.delete.mock.calls.flat(2)).toContain("raw/one");
        expect(h.storage.deleteAll).toHaveBeenCalledOnce();
    });

});
