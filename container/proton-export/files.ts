import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * What the tool has written so far. It exports into `<root>/<account address>/mail_<date>_<time>/`: per message
 * `<id>.metadata.json` and then `<id>.eml`, each written to `temp/` and renamed into place whole, so an `.eml` there
 * is a finished pair. A message it couldn't put together as mail gets an `<id>/` folder of its parts instead, and
 * `labels.json` lists the account's folders and labels (go-lib/internal/mail in proton-mail-export).
 */

const MAIL_DIR = /^mail_\d{8}_\d{6}$/;
/** Proton's ids, as file names. Anything else in the folder isn't a message. */
const ID = /^[A-Za-z0-9+_=-]{1,256}$/;
const EML = ".eml";
const METADATA = ".metadata.json";

export class ExportFolder {
	#mail: string | null = null;
	private readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	/** Null until the tool has made it. */
	async mailDir(): Promise<string | null> {
		if (this.#mail) return this.#mail;
		for (const account of await entries(this.root)) {
			if (!account.isDirectory()) continue;
			const found = (await entries(join(this.root, account.name))).find((e) => e.isDirectory() && MAIL_DIR.test(e.name));
			if (found) return (this.#mail = join(this.root, account.name, found.name));
		}
		return null;
	}

	/** Exported messages waiting to be filed, up to `limit`. */
	async ready(limit: number): Promise<string[]> {
		const dir = await this.mailDir();
		if (!dir) return [];
		const ids: string[] = [];
		for (const e of await entries(dir)) {
			if (ids.length >= limit) break;
			const id = e.isFile() && e.name.endsWith(EML) ? e.name.slice(0, -EML.length) : null;
			if (id && ID.test(id)) ids.push(id);
		}
		return ids;
	}

	/**
	 * How many are waiting, and how many Proton couldn't export as mail. While it runs, that's the folders of parts;
	 * once it's done (`final`), every message's details with no message beside them, which includes those.
	 */
	async counts(final: boolean): Promise<{ ready: number; unexported: number }> {
		const dir = await this.mailDir();
		if (!dir) return { ready: 0, unexported: 0 };
		const all = await entries(dir);
		const emls = new Set(all.filter((e) => e.isFile() && e.name.endsWith(EML)).map((e) => e.name.slice(0, -EML.length)));
		const unexported = final
			? all.filter((e) => e.isFile() && e.name.endsWith(METADATA) && !emls.has(e.name.slice(0, -METADATA.length))).length
			: all.filter((e) => e.isDirectory() && e.name !== "temp" && ID.test(e.name)).length;
		return { ready: emls.size, unexported };
	}

	/** A message's file, if it's there. */
	async file(id: string, kind: "eml" | "metadata"): Promise<{ path: string; size: number } | null> {
		const dir = await this.mailDir();
		if (!dir || !ID.test(id)) return null;
		return sized(join(dir, id + (kind === "eml" ? EML : METADATA)));
	}

	async labels(): Promise<{ path: string; size: number } | null> {
		const dir = await this.mailDir();
		return dir ? sized(join(dir, "labels.json")) : null;
	}

	/** Filed: frees the disk for what's still coming. */
	async remove(id: string): Promise<boolean> {
		const dir = await this.mailDir();
		if (!dir || !ID.test(id)) return false;
		await Promise.all([rm(join(dir, id + EML), { force: true }), rm(join(dir, id + METADATA), { force: true })]);
		return true;
	}
}

/** A folder's entries; none when it doesn't exist yet. */
async function entries(dir: string) {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
}

async function sized(path: string): Promise<{ path: string; size: number } | null> {
	try {
		const s = await stat(path);
		return s.isFile() ? { path, size: s.size } : null;
	} catch (error) {
		if (isMissing(error)) return null;
		throw error;
	}
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
