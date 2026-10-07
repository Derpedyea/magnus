import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { type ImportItem, planImport, runImport, RETRY_DELAYS } from "./import";

const file = (name: string, content = "From: a@b.test\r\n\r\nHi") => new File([content], name);
const metadata = (ID: string, Time: number, LabelIDs: string[], Flags = 1) =>
	JSON.stringify({ Version: 1, Payload: { ID, LabelIDs, Unread: 1, Flags, Time, Subject: "Hi" } });
const LABELS = JSON.stringify({ Version: 1, Payload: [{ ID: "w==", Name: "Work", Path: "Work", Type: 3, Color: "#000", ParentID: "" }] });
const picked = (entries: [string, string][]) => entries.map(([path, content]) => ({ path, file: file(path.split("/").at(-1) ?? path, content) }));

describe("planImport", () => {
	it("reads a Proton export: placements beside each message, newest first, drafts and unexported mail left out", async () => {
		const plan = await planImport(picked([
			["mail_20260101_120000/labels.json", LABELS],
			["mail_20260101_120000/old.eml", "From: a@b.test\r\n\r\nOld"],
			["mail_20260101_120000/old.metadata.json", metadata("old", 100, ["0", "w=="])],
			["mail_20260101_120000/new.eml", "From: a@b.test\r\n\r\nNew"],
			["mail_20260101_120000/new.metadata.json", metadata("new", 200, ["6"])],
			["mail_20260101_120000/draft.eml", "From: a@b.test\r\n\r\nDraft"],
			["mail_20260101_120000/draft.metadata.json", metadata("draft", 300, ["8"], 0)],
			["mail_20260101_120000/broken.metadata.json", metadata("broken", 400, ["0"])],
			["mail_20260101_120000/broken/body.txt", "Hi"],
		]));
		expect(plan).toMatchObject({ proton: true, drafts: 1, unexported: 1, tooBig: [], unreadable: [] });
		expect(plan.items.map((i) => [i.file.name, i.placement, i.at])).toEqual([
			["new.eml", { labels: [], read: false, sent: false }, 200_000],
			["old.eml", { labels: ["inbox", "work"], read: false, sent: false }, 100_000],
		]);
		expect(plan.bytes).toBe(plan.items.reduce((n, i) => n + i.file.size, 0));
	});

	it("files plain .eml as archived and read, and lists what it can't send", async () => {
		const plan = await planImport([
			...picked([["Saved/a.eml", "From: a@b.test\r\n\r\nA"], ["Saved/b.eml", "From: a@b.test\r\n\r\nB"], ["Saved/notes.txt", "x"]]),
			{ path: "Saved/huge.eml", file: new File([new Uint8Array(25 * 1024 * 1024 + 1)], "huge.eml") },
			...picked([["Saved/odd.eml", "x"], ["Saved/odd.metadata.json", "{not json"]]),
		]);
		expect(plan).toMatchObject({ proton: true, tooBig: ["Saved/huge.eml"], unreadable: ["Saved/odd.eml"] });
		expect(plan.items.map((i) => [i.file.name, i.placement])).toEqual([
			["a.eml", { labels: [], read: true }],
			["b.eml", { labels: [], read: true }],
		]);
	});

	it("refuses an export whose folders and labels it can't read, rather than dropping them", async () => {
		await expect(planImport(picked([["mail_x/labels.json", "[]"], ["mail_x/a.eml", "x"]]))).rejects.toThrow("Couldn't read mail_x/labels.json");
	});
});

describe("runImport", () => {
	const items = (n: number): ImportItem[] => Array.from({ length: n }, (_, i) => ({ path: `${i}.eml`, file: file(`${i}.eml`), placement: { labels: [], read: true }, at: 0 }));

	function harness(answers: Record<string, (ApiError | Error | null)[]>) {
		const calls: string[] = [];
		const waits: number[] = [];
		const progress: number[] = [];
		const controller = new AbortController();
		const options = {
			signal: controller.signal,
			concurrency: 2,
			upload: async (item: ImportItem) => {
				calls.push(item.file.name);
				const error = answers[item.file.name]?.shift();
				if (error) throw error;
			},
			sleep: async (ms: number) => { waits.push(ms); },
			onProgress: (p: { done: number }) => { progress.push(p.done); },
		};
		return { calls, waits, progress, controller, options };
	}

	it("sends everything, retrying what fails on the way and listing what the server refuses", async () => {
		const h = harness({
			"0.eml": [new ApiError("Internal error", 500), new TypeError("Failed to fetch"), null],
			"1.eml": [new ApiError("This file isn't an email message", 422)],
			"2.eml": RETRY_DELAYS.map(() => new ApiError("Busy", 503)).concat(new ApiError("Busy", 503)),
		});
		const outcome = await runImport(items(4), h.options);
		expect(outcome).toMatchObject({ done: 2, stopped: false, fatal: null });
		expect(outcome.failed.map((f) => [f.item.file.name, f.error])).toEqual([["1.eml", "This file isn't an email message"], ["2.eml", "Busy"]]);
		expect(h.calls.filter((c) => c === "0.eml")).toHaveLength(3);
		expect(h.calls.filter((c) => c === "2.eml")).toHaveLength(RETRY_DELAYS.length + 1);
		expect(h.waits.toSorted((a, b) => a - b)).toEqual([...RETRY_DELAYS.slice(0, 2), ...RETRY_DELAYS].toSorted((a, b) => a - b));
		expect(h.progress).toHaveLength(4);
	});

	it.each([
		[401, "You were signed out. Sign in and import the folder again to finish."],
		[404, "You can't import into this mailbox anymore."],
	])("stops everything on %s, since nothing else would get through", async (status, message) => {
		const h = harness({ "0.eml": [new ApiError("No", status)] });
		const outcome = await runImport(items(10), { ...h.options, concurrency: 1 });
		expect(outcome).toMatchObject({ done: 0, failed: [], stopped: true, fatal: message });
		expect(h.calls).toEqual(["0.eml"]);
	});

	it("stops when asked, sending nothing more and not counting what was cut off", async () => {
		const h = harness({});
		const outcome = await runImport(items(10), {
			...h.options,
			concurrency: 1,
			upload: async (item, signal) => {
				h.calls.push(item.file.name);
				if (item.file.name === "2.eml") {
					h.controller.abort();
					signal.throwIfAborted();
				}
			},
		});
		expect(outcome).toMatchObject({ done: 2, failed: [], stopped: true, fatal: null });
		expect(h.calls).toEqual(["0.eml", "1.eml", "2.eml"]);
	});
});
