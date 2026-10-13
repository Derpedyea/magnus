import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExportFolder } from "./files.ts";

describe("Proton export folder", () => {
	let root: string;
	let mail: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "proton-export-"));
		mail = join(root, "me@proton.test", "mail_20261012_201614");
	});
	afterEach(() => rm(root, { recursive: true, force: true }));

	async function exported(id: string, eml = true) {
		await writeFile(join(mail, `${id}.metadata.json`), "{}");
		if (eml) await writeFile(join(mail, `${id}.eml`), "From: a@b.test\r\n\r\nHi");
	}

	it("has nothing until the tool makes its folder", async () => {
		const folder = new ExportFolder(root);
		expect(await folder.ready(10)).toEqual([]);
		expect(await folder.counts(true)).toEqual({ ready: 0, unexported: 0 });
		expect(await folder.labels()).toBeNull();
	});

	it("offers a message once its .eml is there, and frees both files when it's filed", async () => {
		await mkdir(join(mail, "temp"), { recursive: true });
		await writeFile(join(mail, "labels.json"), "{}");
		await exported("AbC-1_2==");
		// Details written, message not yet.
		await exported("Pending", false);
		const folder = new ExportFolder(root);
		expect(await folder.ready(10)).toEqual(["AbC-1_2=="]);
		expect(await folder.counts(false)).toEqual({ ready: 1, unexported: 0 });
		expect(await folder.file("AbC-1_2==", "eml")).toMatchObject({ size: 20 });
		expect(await folder.labels()).toMatchObject({ size: 2 });
		expect(await folder.remove("AbC-1_2==")).toBe(true);
		expect(await folder.ready(10)).toEqual([]);
		expect((await readdir(mail)).sort()).toEqual(["Pending.metadata.json", "labels.json", "temp"]);
	});

	it("counts what Proton couldn't export as mail", async () => {
		await mkdir(join(mail, "Broken"), { recursive: true });
		await exported("Broken", false);
		await exported("Orphan", false);
		await exported("Fine");
		const folder = new ExportFolder(root);
		// While it runs, details alone may be a message still being written; the folder of parts is certain.
		expect(await folder.counts(false)).toEqual({ ready: 1, unexported: 1 });
		expect(await folder.counts(true)).toEqual({ ready: 1, unexported: 2 });
	});

	it("serves nothing outside the export by its id", async () => {
		await mkdir(mail, { recursive: true });
		await writeFile(join(root, "secret.eml"), "x");
		const folder = new ExportFolder(root);
		expect(await folder.file("../../secret", "eml")).toBeNull();
		expect(await folder.remove("../../secret")).toBe(false);
		expect(await readdir(root)).toContain("secret.eml");
	});

	it("takes no more than asked", async () => {
		await mkdir(mail, { recursive: true });
		for (const id of ["a", "b", "c"]) await exported(id);
		expect(await new ExportFolder(root).ready(2)).toHaveLength(2);
	});
});
