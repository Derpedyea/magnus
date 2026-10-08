import { describe, expect, it } from "vitest";
import { ImportQuerySchema, importLabel, type ProtonLabel, protonPlacement } from "./import";

// From labels.json: Proton lists some system labels too, typed as folders or labels.
const LABELS = new Map<string, ProtonLabel>(
	[
		{ ID: "0", Name: "Inbox", Type: 3 },
		{ ID: "fld==", Name: "Clients", Path: "Work/Clients", Type: 3 },
		{ ID: "lbl==", Name: "📌 Important", Path: "📌 Important", Type: 1 },
		{ ID: "grp==", Name: "Family", Type: 2 },
		{ ID: "spm==", Name: "Spam", Type: 3 },
	].map((l) => [l.ID, l]),
);
const message = (LabelIDs: string[], Flags = 1, Unread: 0 | 1 = 0) => ({ ID: "m", LabelIDs, Unread, Flags, Time: 0 });

describe("protonPlacement", () => {
	it.each([
		["the inbox", ["0", "5", "15"], ["inbox"]],
		["Archive and All mail, as archived", ["6", "5", "15"], []],
		["Trash, Spam, and Starred", ["3", "4", "10"], ["trash", "spam", "starred"]],
		["a nested folder and a label, by path", ["fld==", "lbl==", "5"], ["work-clients", "important"]],
		["a folder named like one of ours, apart from it", ["spm=="], ["spam-imported"]],
		["contact groups and labels it doesn't list", ["grp==", "gone==", "20", "16"], []],
	])("files %s", (_, ids, labels) => {
		expect(protonPlacement(message(ids), LABELS)).toEqual({ labels, read: true, sent: false });
	});

	it("keeps sent and unread mail so", () => {
		expect(protonPlacement(message(["2", "7", "5"], 2, 1), LABELS)).toEqual({ labels: ["sent"], read: false, sent: true });
		// Mail to yourself is both.
		expect(protonPlacement(message(["0", "2", "7"], 3), LABELS)).toMatchObject({ labels: ["inbox", "sent"], sent: true });
	});

	it("keeps where it was in Proton when it has more labels than fit", () => {
		const many = new Map<string, ProtonLabel>(Array.from({ length: 25 }, (_, i) => [`l${i}==`, { ID: `l${i}==`, Name: `Label ${i}`, Type: 1 }]));
		const placement = protonPlacement(message([...many.keys(), "3", "10"]), many);
		expect(placement?.labels).toHaveLength(20);
		expect(placement?.labels.slice(0, 2)).toEqual(["trash", "starred"]);
	});

	it("skips drafts, which aren't mail yet", () => {
		expect(protonPlacement(message(["1", "8", "5"], 0), LABELS)).toBeNull();
	});
});

describe("importLabel", () => {
	it.each([
		["Receipts", "receipts"],
		["Work / Clients", "work-clients"],
		["Работа", "работа"],
		["🙂", null],
		["All", "all-imported"],
		["x".repeat(80), "x".repeat(55)],
	])("%s → %s", (name, label) => {
		expect(importLabel(name)).toBe(label);
	});

	it("only writes labels an import is allowed", () => {
		for (const name of ["Inbox", "Drafts", "Outbox", "Failed", "Search", "Работа / 2024", "a.b_c-d", "x".repeat(80)]) {
			const label = importLabel(name);
			expect(ImportQuerySchema.safeParse({ labels: label, read: "1" }).success).toBe(true);
		}
	});
});

describe("ImportQuerySchema", () => {
	it("reads labels, read state, and sent when given", () => {
		expect(ImportQuerySchema.parse({ labels: "inbox,work", read: "0", sent: "1" })).toEqual({ labels: ["inbox", "work"], read: false, sent: true });
		expect(ImportQuerySchema.parse({ read: "1" })).toEqual({ labels: [], read: true, sent: undefined });
	});

	it.each([["outbox"], ["drafts"], ["Inbox"], ["two words"], [Array.from({ length: 21 }, (_, i) => `l${i}`).join(",")]])("refuses %s", (labels) => {
		expect(ImportQuerySchema.safeParse({ labels, read: "1" }).success).toBe(false);
	});
});
