import { z } from "zod";
import { SYSTEM_LABELS } from "./types";

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
 * Names Magnus uses itself: the system labels and the views routed like labels. A folder from elsewhere named like one
 * would otherwise turn into it (a "Spam" folder marking its mail as spam).
 */
const RESERVED = new Set<string>([...SYSTEM_LABELS, "all", "drafts", "failed", "search"]);

/** System labels an import can set; the outbox only ever holds mail Magnus is sending. */
const IMPORT_SYSTEM = new Set<string>(SYSTEM_LABELS.filter((l) => l !== "outbox"));

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
	read: z.enum(["0", "1"]).transform((v) => v === "1"),
	sent: z
		.enum(["0", "1"])
		.optional()
		.transform((v) => (v === undefined ? undefined : v === "1")),
});

/** Where a message was in the export, as the browser sends it. */
export interface ImportPlacement {
	labels: string[];
	read: boolean;
	/** Undefined when the export doesn't say. */
	sent?: boolean;
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

export const ProtonMetadataSchema = z.object({
	Payload: z.object({
		ID: z.string(),
		LabelIDs: z.array(z.string()),
		/** 0 or 1 (go-proton-api APIBool). */
		Unread: z.number(),
		Flags: z.number(),
		/** Unix seconds, when Proton received it. */
		Time: z.number(),
	}),
});

export const ProtonLabelsSchema = z.object({
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
	const out = new Set<string>();
	for (const id of meta.LabelIDs) {
		// Proton's own ids are numbers; the person's are base64 (proton-mail-export, go-lib/internal/mail/utils.go).
		if (/^\d+$/.test(id)) {
			const system = PROTON_SYSTEM[id];
			if (system) out.add(system);
			continue;
		}
		const label = labels.get(id);
		if (!label || label.Type === CONTACT_GROUP) continue;
		const name = importLabel(label.Path || label.Name);
		if (name) out.add(name);
	}
	return { labels: [...out].slice(0, MAX_IMPORT_LABELS), read: meta.Unread === 0, sent: (meta.Flags & SENT) !== 0 };
}
