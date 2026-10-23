import { decodeWords } from "postal-mime";
import { z } from "zod";
import { type LabelDef, MAX_LABEL_DEPTH, SYSTEM_LABELS, type SystemLabel } from "./types";

/**
 * Importing mail from another provider: the browser uploads each message as it was exported, with where it was there,
 * and the inbound queue parses it like any other mail (worker/mail/import.ts). Proton's Export Tool writes the
 * where-it-was beside each message; other exports are plain .eml files.
 */

/** Inbound's limit (Email Routing caps a message at 25 MiB), so the parser handles nothing bigger than it does already. */
export const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
/** Labels one imported message can bring along. */
export const MAX_IMPORT_LABELS = 20;
/**
 * What an import's labels and paths can take of its URL, counting each byte as percent-encoded. Workers take URLs of up
 * to 16 KB, and the rest of one is a few hundred bytes.
 */
const MAX_IMPORT_QUERY = 15 * 1024;

/**
 * Names Magnus uses itself: the system labels and the views routed like labels. A folder from elsewhere named like one
 * would otherwise turn into it (a "Spam" folder marking its mail as spam).
 */
const RESERVED = new Set<string>([...SYSTEM_LABELS, "all", "drafts", "failed", "search"]);

/**
 * System labels an import can set. The outbox only ever holds mail Magnus is sending, and the Screener mail Magnus held
 * for asking about its sender.
 */
const IMPORT_SYSTEM = new Set<string>(["inbox", "sent", "spam", "trash", "starred"] satisfies SystemLabel[]);

const LABEL_RE = /^[\p{L}\p{N}._-]{1,64}$/u;

/** A folder or label name from elsewhere as a label here: `Work/Clients` → `work-clients`. Null when nothing's left of it. */
export function importLabel(name: string): string | null {
	const label = Array.from(
		name
			.toLowerCase()
			.replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
			.replaceAll(/^[-.]+|[-.]+$/g, ""),
	)
		.slice(0, 55)
		.join("");
	if (!label) return null;
	return RESERVED.has(label) ? `${label}-imported` : label;
}

/**
 * The labels a folder or label from elsewhere makes, outermost first, as Mailbox.ingest() takes them on: `Work/Clients`
 * is Clients inside Work. Each is keyed by importLabel() of the path to it, so the last is the one mail gets. Labels go
 * MAX_LABEL_DEPTH deep, so the rest of a deeper path names the innermost (`A/B/C/D` is "C - D" inside B inside A, since a
 * name can't have a "/" in it). A part importLabel() makes nothing new of (`🙂/Receipts`) isn't a label of its own.
 */
export function importLabelChain(path: string): LabelDef[] {
	const parts = path.split("/").filter((p) => p.trim());
	const chain: LabelDef[] = [];
	for (let depth = 0; depth < Math.min(parts.length, MAX_LABEL_DEPTH); depth++) {
		const end = depth === MAX_LABEL_DEPTH - 1 ? parts.length : depth + 1;
		const key = importLabel(parts.slice(0, end).join("/"));
		const parent = chain.at(-1)?.key ?? null;
		if (!key || key === parent) continue;
		const name = parts.slice(depth, end).map((p) => p.trim()).join(" - ");
		// Within LabelNameSchema's 64, with room for the number defineLabels() adds to a name taken, and without half a
		// character at the end.
		chain.push({ key, name: name.slice(0, 60).replace(/[\uD800-\uDBFF]$/, "").trimEnd(), parent, color: null });
	}
	return chain;
}

/** What one uploaded message is labelled with: a system label an import can set, or what importLabel() writes. */
export const ImportLabelSchema = z
	.string()
	.refine((l) => IMPORT_SYSTEM.has(l) || (LABEL_RE.test(l) && l === l.toLowerCase() && !RESERVED.has(l)), "Not a label mail can be imported with");

/**
 * Query of POST /api/mailboxes/:id/import, whose body is the raw message. `sent` is left out when the export doesn't
 * say; the Worker then counts mail from one of the mailbox's own addresses as sent.
 */
export const ImportQuerySchema = z.object({
	labels: z
		.string()
		.default("")
		.transform((s) => (s ? s.split(",") : []))
		.pipe(z.array(ImportLabelSchema).max(MAX_IMPORT_LABELS)),
	/** One each (`paths=Work%2FClients&paths=…`), since a name can have a comma in it. Hono gives one as a string. */
	paths: z
		.union([z.string(), z.array(z.string())])
		.default([])
		.transform((p) => [p].flat())
		.pipe(z.array(z.string()).max(MAX_IMPORT_LABELS)),
	read: z.enum(["0", "1"]).transform((v) => v === "1"),
	sent: z
		.enum(["0", "1"])
		.optional()
		.transform((v) => (v === undefined ? undefined : v === "1")),
});

/** Where a message was in the export, as the browser sends it. */
export interface ImportPlacement {
	labels: string[];
	/**
	 * The folders and labels its own labels were made of, as they were named there (`Work/Clients`, "/" between a
	 * folder's parents and it). A label whose path is left out arrives named after its key.
	 */
	paths?: string[];
	read: boolean;
	/** Undefined when the export doesn't say. */
	sent?: boolean;
}

/**
 * A placement's labels and the paths of those that have one (`own` maps a label to its path), as many as fit in its URL.
 * Where it was (Inbox, Sent, Trash…) comes first, so a message with more labels than fit loses only some of its own.
 */
function placeLabels(system: Iterable<string>, own: ReadonlyMap<string, string | null>): Pick<ImportPlacement, "labels" | "paths"> {
	const labels = [...system, ...own.keys()].slice(0, MAX_IMPORT_LABELS);
	const size = (s: string) => new TextEncoder().encode(s).length * 3;
	let room = MAX_IMPORT_QUERY - size(labels.join(","));
	const paths: string[] = [];
	for (const label of labels) {
		const path = own.get(label);
		// `&paths=` and the path.
		if (!path || size(path) + 7 > room) continue;
		room -= size(path) + 7;
		paths.push(path);
	}
	return paths.length > 0 ? { labels, paths } : { labels };
}

// ─── Proton Export Tool ─────────────────────────────────────────────────────
// https://proton.me/support/proton-mail-export-tool writes `mail_<date>_<time>/` holding `<id>.eml` and
// `<id>.metadata.json` per message, and one `labels.json`. Both JSON files wrap their content as
// `{ "Version": 1, "Payload": … }` (proton-mail-export, go-lib/internal/utils/versioned_json.go).

/** go-proton-api's system label ids (message_types.go), as labels here. All mail, Archive, drafts and the rest aren't. */
const PROTON_SYSTEM: Record<string, string> = { "0": "inbox", "2": "sent", "3": "trash", "4": "spam", "7": "sent", "10": "starred" };
/** go-proton-api MessageFlagReceived and MessageFlagSent. A draft has neither. */
const RECEIVED = 1;
const SENT = 2;
/** labels.json types: 1 label, 2 contact group, 3 folder. */
const CONTACT_GROUP = 2;

// Version 1 only: a later one could mean something else by the same fields, and misfile mail rather than fail.
export const ProtonMetadataSchema = z.object({
	Version: z.literal(1),
	Payload: z.object({
		ID: z.string(),
		LabelIDs: z.array(z.string()),
		/** 0 or 1 (go-proton-api APIBool). Anything else is corrupt, and its message unreadable. */
		Unread: z.union([z.literal(0), z.literal(1)]),
		/** A bitmask (go-proton-api MessageFlag…): a fraction or a negative is corrupt, not some mix of flags. */
		Flags: z.number().int().nonnegative(),
		/** Unix seconds, when Proton received it. */
		Time: z.number(),
	}),
});

export const ProtonLabelsSchema = z.object({
	Version: z.literal(1),
	Payload: z.array(
		z.object({
			ID: z.string(),
			Name: z.string(),
			/** Parent folders and the name, "/"-joined. */
			Path: z.string().optional(),
			Type: z.number(),
		}),
	),
});

export type ProtonMetadata = z.infer<typeof ProtonMetadataSchema>["Payload"];
export type ProtonLabel = z.infer<typeof ProtonLabelsSchema>["Payload"][number];

/**
 * Where a message was in Proton, or null for a draft, which isn't mail yet. A folder or label of the person's own
 * becomes a label; Archive and All mail need none, since leaving the inbox is archiving here.
 */
export function protonPlacement(meta: ProtonMetadata, labels: ReadonlyMap<string, ProtonLabel>): ImportPlacement | null {
	if ((meta.Flags & (RECEIVED | SENT)) === 0) return null;
	const system = new Set<string>();
	const own = new Map<string, string>();
	for (const id of meta.LabelIDs) {
		// Proton's own ids are numbers; the person's are base64 (proton-mail-export, go-lib/internal/mail/utils.go).
		if (/^\d+$/.test(id)) {
			const label = PROTON_SYSTEM[id];
			if (label) system.add(label);
			continue;
		}
		const label = labels.get(id);
		if (!label || label.Type === CONTACT_GROUP) continue;
		const path = label.Path || label.Name;
		const name = importLabel(path);
		if (name && !own.has(name)) own.set(name, path);
	}
	return { ...placeLabels(system, own), read: meta.Unread === 0, sent: (meta.Flags & SENT) !== 0 };
}

// ─── mbox: Gmail's Takeout, Thunderbird, and the rest ───────────────────────
// One file holds a folder's messages, each after a `From ` line (RFC 4155). Takeout writes one file of All mail with
// each message's labels in X-Gmail-Labels; Thunderbird writes one file per folder, named like it, with subfolders in a
// `<name>.sbd/` beside it, and keeps read and starred in X-Mozilla-Status.

/** Gmail's own labels in X-Gmail-Labels, as labels here or as nothing. The inbox's categories (`Category …`) are nothing too. */
const GMAIL_SYSTEM = new Map<string, string | null>([
	["Inbox", "inbox"], ["Sent", "sent"], ["Spam", "spam"], ["Trash", "trash"], ["Starred", "starred"],
	["Important", null], ["Opened", null], ["Unread", null], ["Archived", null],
]);

/**
 * Where a message was in Gmail, from Takeout's X-Gmail-Labels (`Inbox,Opened,Work/Clients`), or null for a draft. The
 * whole header can be one encoded word, commas and all (`=?UTF-8?Q?=C3=85pnet,Kategori:_Reklame?=`), so it's decoded
 * before it's split, and a label with a comma in it is quoted (`Inbox,"Work, Client"`). Gmail names its own labels in
 * the account's language; only English ones are known here, and the rest become labels.
 */
export function gmailPlacement(header: string): ImportPlacement | null {
	const names = Array.from(decodeWords(header).matchAll(/\s*(?:"([^"]*)"|([^,]*))\s*(?:,|$)/g), (m) => (m[1] ?? m[2] ?? "").trim()).filter(Boolean);
	if (names.includes("Drafts")) return null;
	const system = new Set<string>();
	const own = new Map<string, string>();
	for (const name of names) {
		const label = GMAIL_SYSTEM.get(name);
		if (label !== undefined) {
			if (label) system.add(label);
		} else if (!name.startsWith("Category ")) {
			const imported = importLabel(name);
			if (imported && !own.has(imported)) own.set(imported, name);
		}
	}
	return {
		...placeLabels(system, own),
		// Takeout writes one or the other; with neither, it's read, like an .eml with nothing to say.
		read: names.includes("Opened") || !names.includes("Unread"),
		// Gmail labels everything you sent Sent. Without it, the Worker still counts mail from your addresses as sent.
		...(names.includes("Sent") ? { sent: true } : {}),
	};
}

/** Folder names programs give their own folders, lowercased. Anything else is the person's own and becomes a label. */
const FOLDERS = new Map<string, "inbox" | "sent" | "trash" | "spam" | "starred" | "archive" | "draft">([
	["inbox", "inbox"],
	["sent", "sent"], ["sent mail", "sent"], ["sent messages", "sent"], ["sent items", "sent"],
	["trash", "trash"], ["bin", "trash"], ["deleted items", "trash"], ["deleted messages", "trash"],
	["spam", "spam"], ["junk", "spam"], ["junk e-mail", "spam"], ["junk email", "spam"],
	["archive", "archive"], ["archives", "archive"], ["all mail", "archive"],
	["drafts", "draft"], ["templates", "draft"], ["outbox", "draft"], ["unsent messages", "draft"],
]);
/** Gmail's folders over IMAP, which Thunderbird keeps under `[Gmail]`, besides the ones above. */
const GMAIL_FOLDERS = new Map<string, "starred" | "archive">([["starred", "starred"], ["important", "archive"]]);

/** Thunderbird's X-Mozilla-Status bits (nsMsgMessageFlags.idl). */
const MOZILLA_READ = 0x1;
const MOZILLA_MARKED = 0x4;
/** Deleted, but still in the file until the folder is compacted. */
const MOZILLA_EXPUNGED = 0x8;
/** Thunderbird's tags in X-Mozilla-Keys: its five built-in ones, and keywords that aren't tags. */
const MOZILLA_TAGS = new Map([["$label1", "important"], ["$label2", "work"], ["$label3", "personal"], ["$label4", "todo"], ["$label5", "later"]]);
const NOT_TAGS = new Set(["junk", "nonjunk", "notjunk"]);

/**
 * Where a message in an mbox file was, or why it's left out: drafts aren't mail yet, and Thunderbird keeps mail it
 * deleted until the folder is compacted. `folder` is the file's folder and its parents, outermost first
 * (`Work.sbd/Clients` → `["Work", "Clients"]`); `headers` are the message's, by lowercased name.
 *
 * Takeout's labels say everything. Otherwise the folder says where it was, and Thunderbird's X-Mozilla-Status or the
 * Status and X-Status other programs write say whether it was read and starred. With none of them it's read.
 */
export function mboxPlacement(headers: ReadonlyMap<string, string>, folder: readonly string[]): ImportPlacement | "draft" | "deleted" {
	// First: mail Thunderbird once held can keep its X-Mozilla-Status in Gmail, deleted bit and all.
	const gmail = headers.get("x-gmail-labels");
	if (gmail !== undefined) return gmailPlacement(gmail) ?? "draft";
	const status = headers.get("x-mozilla-status");
	const mozilla = status && /^[0-9a-f]{4}$/i.test(status) ? Number.parseInt(status, 16) : null;
	if (mozilla !== null && mozilla & MOZILLA_EXPUNGED) return "deleted";

	const gmailImap = /^\[(gmail|google mail)\]$/i.test(folder[0] ?? "");
	const path = gmailImap ? folder.slice(1) : folder;
	const name = path[0]?.toLowerCase() ?? "";
	const top = FOLDERS.get(name) ?? (gmailImap ? GMAIL_FOLDERS.get(name) : undefined);
	if (top === "draft") return "draft";
	const system = new Set<string>();
	const own = new Map<string, string | null>();
	if (path.length === 1 && top && top !== "archive") system.add(top);
	// A subfolder of Inbox is the person's own; Archives files by year, and those are archived mail. One of Sent
	// (`Sent.sbd/2024`) is still mail you sent.
	else if (path.length > 0 && top !== "archive") {
		if (top === "sent") system.add("sent");
		const label = importLabel(path.join("/"));
		if (label) own.set(label, path.join("/"));
	}
	const read = mozilla !== null ? (mozilla & MOZILLA_READ) !== 0 : (headers.get("status")?.includes("R") ?? true);
	if ((mozilla !== null && mozilla & MOZILLA_MARKED) || headers.get("x-status")?.includes("F")) system.add("starred");
	for (const key of (headers.get("x-mozilla-keys") ?? "").split(/\s+/)) {
		const tag = MOZILLA_TAGS.get(key.toLowerCase()) ?? (key.startsWith("$") || NOT_TAGS.has(key.toLowerCase()) ? null : importLabel(key));
		if (tag && !own.has(tag)) own.set(tag, null);
	}
	return {
		...placeLabels(system, own),
		read,
		...(top === "sent" ? { sent: true } : {}),
	};
}

/**
 * A message's header block as lowercased name → unfolded value, the first of each name. X-Gmail-Labels is the
 * exception: a long one can be split over several, so they're joined.
 */
export function parseHeaders(block: string): Map<string, string> {
	const headers = new Map<string, string>();
	for (const field of block.replaceAll(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const colon = field.indexOf(":");
		if (colon <= 0) continue;
		const name = field.slice(0, colon).trim().toLowerCase();
		const value = field.slice(colon + 1).trim();
		const seen = headers.get(name);
		if (seen === undefined) headers.set(name, value);
		else if (name === "x-gmail-labels") headers.set(name, `${seen},${value}`);
	}
	return headers;
}

/**
 * One message found in two places in an export, as it goes here: in both, read only if both say so, and sent if either
 * does. Where it was comes first among its labels, as everywhere else.
 */
export function mergePlacements(a: ImportPlacement, b: ImportPlacement): ImportPlacement {
	const labels = [...new Set([...a.labels, ...b.labels])];
	const paths = new Map([...(a.paths ?? []), ...(b.paths ?? [])].map((p) => [importLabel(p), p]));
	const own = new Map(labels.filter((l) => !IMPORT_SYSTEM.has(l)).map((l) => [l, paths.get(l) ?? null]));
	return {
		...placeLabels(labels.filter((l) => IMPORT_SYSTEM.has(l)), own),
		read: a.read && b.read,
		...(a.sent || b.sent ? { sent: true } : {}),
	};
}
