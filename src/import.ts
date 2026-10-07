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
 * An .eml with neither is filed as archived and read, since nothing says otherwise.
 */
export async function planImport(files: PickedFile[]): Promise<ImportPlan> {
	const byPath = new Map(files.map((f) => [f.path, f.file]));
	// A labels.json is Proton's only beside its messages' details: any other folder can hold one of its own.
	const exports = new Set(files.filter((f) => f.path.endsWith(METADATA)).map((f) => folderOf(f.path)));
	const labelFiles = await Promise.all(
		files
			.filter((f) => f.file.name === "labels.json" && exports.has(folderOf(f.path)))
			.map(async (f) => {
				const parsed = ProtonLabelsSchema.safeParse(await readJson(f.file));
				// Without it, the person's own folders and labels would be dropped from everything in the export.
				if (!parsed.success) throw new Error(`Couldn't read ${f.path}, the folders and labels in Proton's export`);
				return [folderOf(f.path), new Map(parsed.data.Payload.map((l) => [l.ID, l]))] as const;
			}),
	);
	const labelsByFolder = new Map<string, ReadonlyMap<string, ProtonLabel>>(labelFiles);

	const plan: ImportPlan = { items: [], bytes: 0, proton: labelsByFolder.size > 0, drafts: 0, unexported: 0, tooBig: [], unreadable: [] };
	const emls = files.filter((f) => /\.eml$/i.test(f.file.name));
	const exported = new Set(emls.map((f) => f.path.replace(/\.eml$/i, METADATA)));
	plan.unexported = files.filter((f) => f.path.endsWith(METADATA) && !exported.has(f.path)).length;

	const found = await pool(emls, READERS, async ({ path, file }): Promise<Found> => {
		if (file.size > MAX_IMPORT_BYTES) return { kind: "tooBig", path };
		const metadata = byPath.get(path.replace(/\.eml$/i, METADATA));
		if (!metadata) return { kind: "item", item: { path, file, placement: { labels: [], read: true }, at: 0 } };
		plan.proton = true;
		const parsed = metadata.size <= MAX_METADATA_BYTES ? ProtonMetadataSchema.safeParse(await readJson(metadata)) : null;
		if (!parsed?.success) return { kind: "unreadable", path };
		const placement = protonPlacement(parsed.data.Payload, labelsByFolder.get(folderOf(path)) ?? new Map());
		return placement ? { kind: "item", item: { path, file, placement, at: parsed.data.Payload.Time * 1000 } } : { kind: "draft", path };
	});
	for (const r of found) {
		if (r.kind === "item") plan.items.push(r.item);
		else if (r.kind === "tooBig") plan.tooBig.push(r.path);
		else if (r.kind === "unreadable") plan.unreadable.push(r.path);
		else plan.drafts++;
	}
	// Newest first, so recent mail is there to read first. Sorting is stable, so files with no date keep their order.
	plan.items.sort((a, b) => b.at - a.at);
	plan.bytes = plan.items.reduce((n, i) => n + i.file.size, 0);
	return plan;
}

type Found = { kind: "item"; item: ImportItem } | { kind: "tooBig" | "unreadable" | "draft"; path: string };

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
