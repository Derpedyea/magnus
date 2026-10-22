import { z } from "zod";
import { byteBudget } from "#shared";
import {
	type ImportPlacement, MAX_IMPORT_BYTES, mboxPlacement, mergePlacements, parseHeaders, type ProtonLabel, ProtonLabelsSchema,
	ProtonMetadataSchema, protonPlacement,
} from "#shared/import";
import { decodeWords } from "postal-mime";
import { ApiError } from "./api";
import { isMbox, type MboxMessage, mboxBody, splitMbox } from "./mbox";

/** A file from the folder or files chosen, with its path inside what was chosen. */
export interface PickedFile {
	path: string;
	file: File;
}

export interface ImportItem {
	/** Unique in the import: an mbox message's is its file's and its place in it (`Inbox #12`). */
	path: string;
	/** What to call it: the file's name, or an mbox message's subject. */
	name: string;
	file: File;
	/** Where in `file` it is, when that's an mbox holding many. */
	mbox?: Pick<MboxMessage, "start" | "end" | "escaped">;
	size: number;
	placement: ImportPlacement;
	/** When it arrived, if the export says, to send the newest first. 0 when it doesn't. */
	at: number;
}

/** What a chosen folder holds, before anything is sent. */
export interface ImportPlan {
	items: ImportItem[];
	bytes: number;
	/** Proton's Export Tool wrote it. */
	proton: boolean;
	/** Messages in it came from Gmail's Takeout. */
	gmail: boolean;
	/** It holds mbox files. */
	mbox: boolean;
	drafts: number;
	/** Mail Thunderbird deleted but kept in the file until the folder is compacted. */
	deleted: number;
	/** Messages Proton listed but couldn't export as mail (it saves their parts in a folder instead). */
	unexported: number;
	tooBig: string[];
	/** Messages whose Proton details couldn't be read, so where they go isn't known. */
	unreadable: string[];
}

const METADATA = ".metadata.json";
/** Proton's details for one message run to a few KB. */
const MAX_METADATA_BYTES = 1024 * 1024;
/** Its labels.json runs to a few hundred bytes a label, so thousands fit; anything bigger is another program's. */
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Files read at once while planning. */
const READERS = 16;

/**
 * Pairs each .eml with what Proton's Export Tool wrote beside it: `<id>.metadata.json`, and the folder's `labels.json`.
 * An .eml outside a Proton export is filed as archived and read, since nothing says otherwise.
 *
 * A folder is Proton's export when one of those files in it is shaped like Proton's (`{ Version, Payload }`). There,
 * one that can't be read stops the import or lists its message as unreadable, rather than misfiling mail. Anywhere
 * else they're another program's, and left alone.
 *
 * Any other file that starts with a `From ` line is an mbox, and is read through once (`onProgress` hears how far) for
 * where each message in it is and where it goes (mboxPlacement()). The same message in two of them (Thunderbird keeps
 * Gmail's mail in All Mail and each folder it's in) is sent once, with the labels of both, unless one of them is a
 * draft. `signal` stops reading them.
 */
export async function planImport(files: PickedFile[], onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<ImportPlan> {
	const byPath = new Map(files.map((f) => [f.path, f.file]));
	const emls = files.filter((f) => /\.eml$/i.test(f.file.name));
	const sidecars = new Map(
		await pool(emls, READERS, async ({ path }) => {
			const metadata = byPath.get(sidecarOf(path));
			return [path, metadata && metadata.size <= MAX_METADATA_BYTES ? await readJson(metadata) : metadata ? TOO_BIG : NONE] as const;
		}),
	);
	const manifests = await pool(files.filter((f) => f.file.name === "labels.json"), READERS, async (f) => ({
		...f,
		json: f.file.size <= MAX_MANIFEST_BYTES ? await readJson(f.file) : TOO_BIG,
	}));
	const exports = new Set([
		...manifests.filter((m) => isProtonShaped(m.json)).map((m) => folderOf(m.path)),
		...[...sidecars].filter(([, json]) => isProtonShaped(json)).map(([path]) => folderOf(path)),
	]);

	const labelsByFolder = new Map<string, ReadonlyMap<string, ProtonLabel>>();
	for (const m of manifests.filter((m) => exports.has(folderOf(m.path)))) {
		const parsed = ProtonLabelsSchema.safeParse(m.json);
		// Without it, the person's own folders and labels would be dropped from everything in the export.
		if (!parsed.success) throw new Error(`Couldn't read ${m.path}, the folders and labels in Proton's export`);
		labelsByFolder.set(folderOf(m.path), new Map(parsed.data.Payload.map((l) => [l.ID, l])));
	}
	// Proton always writes one, as it writes every message's details. Without it every folder and label of the person's own would be dropped, and importing
	// the full export again couldn't add them: the messages would already be here.
	for (const folder of exports) if (!labelsByFolder.has(folder)) throw new Error(`${folder} has no labels.json, which lists the folders and labels in Proton's export`);

	const plan: ImportPlan = { items: [], bytes: 0, proton: exports.size > 0, gmail: false, mbox: false, drafts: 0, deleted: 0, unexported: 0, tooBig: [], unreadable: [] };
	const paired = new Set(emls.map((f) => sidecarOf(f.path)));
	plan.unexported = files.filter((f) => f.path.endsWith(METADATA) && !paired.has(f.path) && exports.has(folderOf(f.path))).length;

	for (const { path, file } of emls) {
		const sidecar = sidecars.get(path);
		const item = { path, name: file.name, file, size: file.size };
		if (file.size > MAX_IMPORT_BYTES) plan.tooBig.push(path);
		else if (!exports.has(folderOf(path))) plan.items.push({ ...item, placement: { labels: [], read: true }, at: 0 });
		else {
			const parsed = ProtonMetadataSchema.safeParse(sidecar);
			// Proton names both files by the message's id, so details naming another message aren't this one's.
			if (!parsed.success || parsed.data.Payload.ID !== file.name.replace(/\.eml$/i, "")) {
				plan.unreadable.push(path);
				continue;
			}
			const placement = protonPlacement(parsed.data.Payload, labelsByFolder.get(folderOf(path)) ?? new Map());
			if (placement) plan.items.push({ ...item, placement, at: parsed.data.Payload.Time * 1000 });
			else plan.drafts++;
		}
	}

	const candidates = files.filter((f) => !/\.(eml|json|msf)$/i.test(f.file.name) && f.file.size > 0);
	const mboxes = (await pool(candidates, READERS, async (f) => ((await isMbox(f.file)) ? f : null))).filter((f) => f !== null);
	plan.mbox = mboxes.length > 0;
	const total = mboxes.reduce((n, f) => n + f.file.size, 0);
	let read = 0;
	const byMessageId = new Map<string, ImportItem>();
	/** Gmail keeps a draft in All Mail too, so its copy there, before or after it in the scan, isn't mail either. */
	const draftIds = new Set<string>();
	for (const { path, file } of mboxes) {
		const folder = mboxFolder(path);
		let n = 0;
		for await (const message of splitMbox(file, (bytes) => onProgress?.((read += bytes) / total), signal)) {
			const key = `${path} #${++n}`;
			const size = message.end - message.start;
			if (size > MAX_IMPORT_BYTES) {
				plan.tooBig.push(key);
				continue;
			}
			const headers = parseHeaders(message.headers);
			const placement = mboxPlacement(headers, folder);
			const id = own(headers.get("message-id"));
			if (placement === "draft") {
				// Counted once however many copies there are.
				if (!id || !draftIds.has(id)) plan.drafts++;
				if (id) draftIds.add(id);
			} else if (placement === "deleted") plan.deleted++;
			else {
				if (headers.has("x-gmail-labels")) plan.gmail = true;
				const same = id ? byMessageId.get(id) : undefined;
				if (same) {
					same.placement = mergePlacements(same.placement, placement);
					continue;
				}
				const subject = own(decodeWords(headers.get("subject") ?? "").trim().slice(0, 200));
				const at = Date.parse(headers.get("date") ?? "");
				const item: ImportItem = { path: key, name: subject || `${file.name} #${n}`, file, mbox: { start: message.start, end: message.end, escaped: message.escaped }, size, placement, at: Number.isNaN(at) ? 0 : at };
				if (id) byMessageId.set(id, item);
				plan.items.push(item);
			}
		}
	}
	// Mail that was sent isn't a draft, even if a draft of it is left over somewhere.
	const drafts = new Set([...draftIds].map((id) => byMessageId.get(id)).filter((item) => item && !item.placement.sent));
	if (drafts.size) plan.items = plan.items.filter((item) => !drafts.has(item));
	// Newest first, so recent mail is there to read first. Sorting is stable, so files with no date keep their order.
	plan.items.sort((a, b) => b.at - a.at);
	plan.bytes = plan.items.reduce((n, i) => n + i.size, 0);
	return plan;
}

/**
 * A copy of a string cut from a message's headers. A cut can keep the whole string it came from (V8 does), and a
 * Takeout's hundreds of thousands of them would keep every message's headers.
 */
function own<T extends string | undefined>(s: T): T {
	return (s === undefined ? s : utf8.decode(new TextEncoder().encode(s))) as T;
}
const utf8 = new TextDecoder();

/** What to send for an item: the file, or an mbox message's bytes as they were before they went into it. */
export function importBody(item: ImportItem): Promise<Blob> {
	return item.mbox ? mboxBody(item.file, item.mbox) : Promise.resolve(item.file);
}

/**
 * An mbox file's folder and its parents, outermost first. Thunderbird keeps subfolders in `<name>.sbd/` beside the
 * folder's file (`Work.sbd/Clients` → Work/Clients); Apple Mail exports `<name>.mbox/mbox`.
 */
export function mboxFolder(path: string): string[] {
	const parts = path.split("/");
	let name = parts.pop() ?? "";
	if (name === "mbox" && /\.mbox$/i.test(parts.at(-1) ?? "")) name = parts.pop() ?? "";
	const folder = [name.replace(/\.(mbox|mbx)$/i, "")];
	for (let parent = parts.pop(); parent && /\.(sbd|mbox)$/i.test(parent); parent = parts.pop()) folder.unshift(parent.replace(/\.(sbd|mbox)$/i, ""));
	return folder;
}

/** Sidecar states besides its JSON: no file beside the message, or one too big to be Proton's. In an export, both are unreadable. */
const NONE = Symbol("none");
const TOO_BIG = Symbol("too big");

/** Proton wraps both of its files as `{ "Version": n, "Payload": … }`; another program's JSON is unlikely to be. */
const ProtonShape = z.object({ Version: z.number(), Payload: z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]) });
const isProtonShaped = (json: unknown) => ProtonShape.safeParse(json).success;

const sidecarOf = (path: string) => path.replace(/\.eml$/i, METADATA);

function folderOf(path: string): string {
	return path.slice(0, path.lastIndexOf("/") + 1);
}

/** Unparsable JSON comes back as null, for the schema to refuse. */
async function readJson(file: File): Promise<unknown> {
	try {
		return JSON.parse(await file.text());
	} catch {
		return null;
	}
}

export interface ImportProgress {
	/** Accepted by the server. */
	done: number;
	failed: { item: ImportItem; error: string }[];
	bytesDone: number;
}

export interface ImportOutcome extends ImportProgress {
	/** Stopped before everything was tried: asked to, or `fatal`. */
	stopped: boolean;
	/** Why nothing more could be sent: signed out, or the mailbox is gone. */
	fatal: string | null;
}

export interface RunOptions {
	upload: (item: ImportItem, signal: AbortSignal) => Promise<unknown>;
	signal: AbortSignal;
	onProgress: (progress: ImportProgress) => void;
	/** Waits before a retry; resolves early when the signal aborts. */
	sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	concurrency?: number;
}

/** Waits between tries of one message: the network or the server failing, or too many at once. */
export const RETRY_DELAYS = [1000, 4000, 15_000];
/** Messages sent at once. More doesn't go faster: the browser allows about six requests to a host. */
const CONCURRENCY = 4;

/**
 * Sends every message, a few at a time. A message the server refuses (not mail, too big) is listed as failed and the
 * rest go on; one that fails on the way is tried again. Being signed out or losing the mailbox stops it all, since
 * nothing else would get through either.
 */
export async function runImport(items: ImportItem[], options: RunOptions): Promise<ImportOutcome> {
	const progress: ImportProgress = { done: 0, failed: [], bytesDone: 0 };
	// The Worker reads each body whole, and requests to it can share an isolate's 128 MB: big messages go alone.
	const budget = byteBudget(MAX_IMPORT_BYTES);
	const halt = new AbortController();
	const signal = AbortSignal.any([options.signal, halt.signal]);
	let fatal: string | null = null;
	let next = 0;

	const send = async (item: ImportItem): Promise<void> => {
		await budget.take(item.size);
		try {
			await sendOnce(item);
		} finally {
			budget.give(item.size);
		}
	};

	const sendOnce = async (item: ImportItem): Promise<void> => {
		for (let attempt = 0; ; attempt++) {
			try {
				await options.upload(item, signal);
				progress.done++;
				progress.bytesDone += item.size;
				return;
			} catch (error) {
				if (signal.aborted) return;
				const status = error instanceof ApiError ? error.status : null;
				if (status === 401 || status === 403 || status === 404) {
					fatal = status === 401 ? "You were signed out. Sign in and import the same export again to finish." : "You can't import into this mailbox anymore.";
					halt.abort();
					return;
				}
				const transient = status === null || status === 408 || status === 429 || status >= 500;
				const delay = RETRY_DELAYS[attempt];
				if (!transient || delay === undefined) {
					progress.failed.push({ item, error: error instanceof Error ? error.message : String(error) });
					return;
				}
				await options.sleep(delay, signal);
				if (signal.aborted) return;
			}
		}
	};

	const worker = async () => {
		while (!signal.aborted && next < items.length) {
			const item = items[next++];
			if (!item) return;
			await send(item);
			if (!signal.aborted) options.onProgress({ ...progress, failed: [...progress.failed] });
		}
	};
	await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, items.length) }, worker));
	return { ...progress, stopped: signal.aborted, fatal };
}

/** Runs `task` over `items`, `size` at a time, keeping their order in the results. */
async function pool<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
	return results;
}

/** For RunOptions.sleep. */
export function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		// Whichever comes first undoes the other, so a long import's retries don't leave listeners on the stop signal.
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

/** Files from a folder input, by their path inside the folder. */
export function pickedFiles(list: FileList): PickedFile[] {
	return Array.from(list, (file) => ({ path: file.webkitRelativePath || file.name, file }));
}

/**
 * Every file under what was dropped, folders included. Read the entries from the drop event as it fires
 * (DataTransferItem.webkitGetAsEntry): the browser empties the list once the handler returns.
 */
export async function droppedFiles(entries: FileSystemEntry[]): Promise<PickedFile[]> {
	return (await Promise.all(entries.map(walk))).flat();
}

async function walk(entry: FileSystemEntry): Promise<PickedFile[]> {
	if (isFile(entry)) return [{ path: entry.fullPath.replace(/^\//, ""), file: await new Promise<File>((resolve, reject) => entry.file(resolve, reject)) }];
	if (!isDirectory(entry)) return [];
	const reader = entry.createReader();
	const children: FileSystemEntry[] = [];
	// Each read returns a batch (100 in Chrome) until an empty one.
	for (;;) {
		const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
		if (batch.length === 0) break;
		children.push(...batch);
	}
	return (await Promise.all(children.map(walk))).flat();
}

const isFile = (entry: FileSystemEntry): entry is FileSystemFileEntry => entry.isFile;
const isDirectory = (entry: FileSystemEntry): entry is FileSystemDirectoryEntry => entry.isDirectory;
