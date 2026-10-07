import { z } from "zod";
import { type ImportPlacement, MAX_IMPORT_BYTES, type ProtonLabel, ProtonLabelsSchema, ProtonMetadataSchema, protonPlacement } from "#shared/import";
import { ApiError } from "./api";

/** A file from the folder or files chosen, with its path inside what was chosen. */
export interface PickedFile {
	path: string;
	file: File;
}

export interface ImportItem {
	path: string;
	file: File;
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
	drafts: number;
	/** Messages Proton listed but couldn't export as mail (it saves their parts in a folder instead). */
	unexported: number;
	tooBig: string[];
	/** Messages whose Proton details couldn't be read, so where they go isn't known. */
	unreadable: string[];
}

const METADATA = ".metadata.json";
/** Proton's details for one message run to a few KB. */
const MAX_METADATA_BYTES = 1024 * 1024;
/** Files read at once while planning. */
const READERS = 16;

/**
 * Pairs each .eml with what Proton's Export Tool wrote beside it: `<id>.metadata.json`, and the folder's `labels.json`.
 * An .eml outside a Proton export is filed as archived and read, since nothing says otherwise.
 *
 * A folder is Proton's export when one of those files in it is shaped like Proton's (`{ Version, Payload }`). There,
 * one that can't be read stops the import or lists its message as unreadable, rather than misfiling mail. Anywhere
 * else they're another program's, and left alone.
 */
export async function planImport(files: PickedFile[]): Promise<ImportPlan> {
	const byPath = new Map(files.map((f) => [f.path, f.file]));
	const emls = files.filter((f) => /\.eml$/i.test(f.file.name));
	const sidecars = new Map(
		await pool(emls, READERS, async ({ path }) => {
			const metadata = byPath.get(sidecarOf(path));
			return [path, metadata && metadata.size <= MAX_METADATA_BYTES ? await readJson(metadata) : metadata ? TOO_BIG : NONE] as const;
		}),
	);
	const manifests = await Promise.all(files.filter((f) => f.file.name === "labels.json").map(async (f) => ({ ...f, json: await readJson(f.file) })));
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

	const plan: ImportPlan = { items: [], bytes: 0, proton: exports.size > 0, drafts: 0, unexported: 0, tooBig: [], unreadable: [] };
	const paired = new Set(emls.map((f) => sidecarOf(f.path)));
	plan.unexported = files.filter((f) => f.path.endsWith(METADATA) && !paired.has(f.path) && exports.has(folderOf(f.path))).length;

	for (const { path, file } of emls) {
		const sidecar = sidecars.get(path);
		if (file.size > MAX_IMPORT_BYTES) plan.tooBig.push(path);
		else if (!exports.has(folderOf(path))) plan.items.push({ path, file, placement: { labels: [], read: true }, at: 0 });
		else {
			const parsed = ProtonMetadataSchema.safeParse(sidecar);
			if (!parsed.success) {
				plan.unreadable.push(path);
				continue;
			}
			const placement = protonPlacement(parsed.data.Payload, labelsByFolder.get(folderOf(path)) ?? new Map());
			if (placement) plan.items.push({ path, file, placement, at: parsed.data.Payload.Time * 1000 });
			else plan.drafts++;
		}
	}
	// Newest first, so recent mail is there to read first. Sorting is stable, so files with no date keep their order.
	plan.items.sort((a, b) => b.at - a.at);
	plan.bytes = plan.items.reduce((n, i) => n + i.file.size, 0);
	return plan;
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
	const halt = new AbortController();
	const signal = AbortSignal.any([options.signal, halt.signal]);
	let fatal: string | null = null;
	let next = 0;

	const send = async (item: ImportItem): Promise<void> => {
		for (let attempt = 0; ; attempt++) {
			try {
				await options.upload(item, signal);
				progress.done++;
				progress.bytesDone += item.file.size;
				return;
			} catch (error) {
				if (signal.aborted) return;
				const status = error instanceof ApiError ? error.status : null;
				if (status === 401 || status === 403 || status === 404) {
					fatal = status === 401 ? "You were signed out. Sign in and import the folder again to finish." : "You can't import into this mailbox anymore.";
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
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
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
