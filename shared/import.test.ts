import { describe, expect, it } from "vitest";
import { gmailPlacement, ImportQuerySchema, importLabel, importLabelChain, mboxPlacement, mergePlacements, parseHeaders, type ProtonLabel, protonPlacement } from "./import";

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
		["a nested folder and a label, by path", ["fld==", "lbl==", "5"], ["work-clients", "important"], ["Work/Clients", "📌 Important"]],
		["a folder named like one of ours, apart from it", ["spm=="], ["spam-imported"], ["Spam"]],
		["contact groups and labels it doesn't list", ["grp==", "gone==", "20", "16"], []],
	])("files %s", (_, ids, labels, paths?: string[]) => {
		expect(protonPlacement(message(ids), LABELS)).toEqual({ labels, paths, read: true, sent: false });
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

	it("leaves out the paths that would take its URL past Workers' 16 KB", () => {
		const long = new Map<string, ProtonLabel>(Array.from({ length: 20 }, (_, i) => [`l${i}==`, { ID: `l${i}==`, Name: `${i}/${"界".repeat(400)}`, Type: 3 }]));
		const placement = protonPlacement(message([...long.keys()]), long)!;
		const query = new URLSearchParams([["labels", placement.labels.join(",")], ...(placement.paths ?? []).map((p) => ["paths", p])]);
		expect([placement.labels.length, placement.paths?.length, query.toString().length < 16 * 1024]).toEqual([20, 1, true]);
	});

	it("skips drafts, which aren't mail yet", () => {
		expect(protonPlacement(message(["1", "8", "5"], 0), LABELS)).toBeNull();
	});
});

describe("gmailPlacement", () => {
	it.each([
		["Inbox,Opened,Category Updates,Important", { labels: ["inbox"], read: true }],
		["Archived,Unread,Work/Clients", { labels: ["work-clients"], paths: ["Work/Clients"], read: false }],
		["Sent,Opened,Inbox", { labels: ["sent", "inbox"], read: true, sent: true }],
		["Spam,Trash,Starred,Unread", { labels: ["spam", "trash", "starred"], read: false }],
		// Takeout encodes the whole header, commas and all, when a label isn't ASCII.
		["=?UTF-8?Q?Inbox,Opened,=C3=85rsrapport?=", { labels: ["inbox", "årsrapport"], paths: ["Årsrapport"], read: true }],
	])("files %s", (header, placement) => {
		expect(gmailPlacement(header)).toEqual(placement);
	});

	it("keeps a quoted label with a comma in it whole", () => {
		expect(gmailPlacement('Inbox,"Work, Client",Unread')).toEqual({ labels: ["inbox", "work-client"], paths: ["Work, Client"], read: false });
	});

	it("skips drafts", () => {
		expect(gmailPlacement("Drafts,Opened")).toBeNull();
	});
});

describe("mboxPlacement", () => {
	const place = (headers: Record<string, string>, folder: string[]) => mboxPlacement(new Map(Object.entries(headers)), folder);

	it.each([
		["Thunderbird's Inbox, read", { "x-mozilla-status": "0001" }, ["Inbox"], { labels: ["inbox"], read: true }],
		["a starred message in Sent", { "x-mozilla-status": "0005" }, ["Sent"], { labels: ["sent", "starred"], read: true, sent: true }],
		["an unread one in a subfolder", { "x-mozilla-status": "0000" }, ["Work", "Clients"], { labels: ["work-clients"], paths: ["Work/Clients"], read: false }],
		["a subfolder of Sent, as sent", { "x-mozilla-status": "0001" }, ["Sent", "2024"], { labels: ["sent", "sent-2024"], paths: ["Sent/2024"], read: true, sent: true }],
		["Archives by year, as archived", { "x-mozilla-status": "0001" }, ["Archives", "2024"], { labels: [], read: true }],
		["Gmail's folders over IMAP", { "x-mozilla-status": "0001" }, ["[Gmail]", "Starred"], { labels: ["starred"], read: true }],
		["tags, without junk keywords", { "x-mozilla-status": "0001", "x-mozilla-keys": "$label2 receipts NonJunk $Forwarded" }, ["Junk"], { labels: ["spam", "work", "receipts"], read: true }],
		["Status and X-Status from other programs", { status: "O", "x-status": "F" }, ["INBOX"], { labels: ["inbox", "starred"], read: false }],
		["a file with nothing to say, as read", {}, ["mail"], { labels: ["mail"], paths: ["mail"], read: true }],
		["Takeout's labels over a Thunderbird flag left in the message", { "x-gmail-labels": "Inbox,Opened", "x-mozilla-status": "0009" }, ["All mail"], { labels: ["inbox"], read: true }],
		["Takeout's labels over the file's name", { "x-gmail-labels": "Inbox,Unread" }, ["All mail Including Spam and Trash"], { labels: ["inbox"], read: false }],
	])("files %s", (_, headers, folder, placement) => {
		expect(place(headers, folder)).toEqual(placement);
	});

	it("leaves out drafts, templates, and what Thunderbird deleted but hasn't compacted away", () => {
		expect(place({}, ["Drafts"])).toBe("draft");
		expect(place({}, ["Templates"])).toBe("draft");
		expect(place({ "x-mozilla-status": "0009" }, ["Inbox"])).toBe("deleted");
	});
});

describe("parseHeaders", () => {
	it("unfolds headers, keeps the first of each, and joins split X-Gmail-Labels", () => {
		const headers = parseHeaders("Subject: one\r\n two\r\nX-Gmail-Labels: Inbox\r\nSubject: later\r\nX-Gmail-Labels: Work\r\nbroken line");
		expect([...headers]).toEqual([["subject", "one two"], ["x-gmail-labels", "Inbox,Work"]]);
	});
});

describe("mergePlacements", () => {
	it("files a message found twice in both places, read only if both say so", () => {
		expect(mergePlacements({ labels: ["work"], read: true }, { labels: ["inbox", "work"], read: false })).toEqual({ labels: ["inbox", "work"], read: false });
		expect(mergePlacements({ labels: [], read: true }, { labels: ["sent"], read: true, sent: true })).toEqual({ labels: ["sent"], read: true, sent: true });
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

describe("importLabelChain", () => {
	it.each([
		["Work/Clients", [["work", "Work", null], ["work-clients", "Clients", "work"]]],
		["A / B/C/D", [["a", "A", null], ["a-b", "B", "a"], ["a-b-c-d", "C - D", "a-b"]]],
		["🙂/Spam", [["spam-imported", "Spam", null]]],
	])("%s", (path, chain) => {
		expect(importLabelChain(path)).toEqual(chain.map(([key, name, parent]) => ({ key, name, parent, color: null })));
	});
});

describe("ImportQuerySchema", () => {
	it("reads labels, read state, and sent when given", () => {
		expect(ImportQuerySchema.parse({ labels: "inbox,work", paths: "Work, Inc", read: "0", sent: "1" })).toEqual({ labels: ["inbox", "work"], paths: ["Work, Inc"], read: false, sent: true });
		expect(ImportQuerySchema.parse({ read: "1" })).toEqual({ labels: [], paths: [], read: true, sent: undefined });
	});

	it.each([["outbox"], ["drafts"], ["Inbox"], ["two words"], [Array.from({ length: 21 }, (_, i) => `l${i}`).join(",")]])("refuses %s", (labels) => {
		expect(ImportQuerySchema.safeParse({ labels, read: "1" }).success).toBe(false);
	});
});
