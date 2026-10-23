import type { Label, LabelChange, LabelColor } from "#shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { labelsQuery } from "./queries";

/**
 * How each label color looks: a chip on mail, and a swatch beside its name in the sidebar and pickers. A swatch is a
 * rounded square, since a dot already means an address. Written out whole so Tailwind keeps them.
 */
const STYLES: Record<LabelColor | "none", { chip: string; swatch: string }> = {
	none: { chip: "bg-muted text-muted-foreground", swatch: "bg-muted-foreground/50" },
	gray: { chip: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300", swatch: "bg-zinc-500" },
	red: { chip: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300", swatch: "bg-red-500" },
	orange: { chip: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-300", swatch: "bg-orange-500" },
	amber: { chip: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300", swatch: "bg-amber-500" },
	green: { chip: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300", swatch: "bg-green-500" },
	teal: { chip: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300", swatch: "bg-teal-500" },
	blue: { chip: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300", swatch: "bg-blue-500" },
	violet: { chip: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300", swatch: "bg-violet-500" },
	pink: { chip: "bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-300", swatch: "bg-pink-500" },
};

export const labelStyle = (color: LabelColor | null) => STYLES[color ?? "none"];

export interface LabelNode {
	label: Label;
	/** 0 at the top. */
	depth: number;
	children: LabelNode[];
}

const byPlace = (a: Label, b: Label) => a.position - b.position || a.name.localeCompare(b.name);

/** Labels inside the labels they sit in, each level in order. One whose parent is missing goes at the top. */
export function labelTree(labels: readonly Label[]): LabelNode[] {
	const keys = new Set(labels.map((l) => l.key));
	const inside = new Map<string | null, Label[]>();
	for (const label of labels) {
		const parent = label.parent !== null && keys.has(label.parent) ? label.parent : null;
		inside.set(parent, [...(inside.get(parent) ?? []), label]);
	}
	const level = (parent: string | null, depth: number, seen: Set<string>): LabelNode[] =>
		(inside.get(parent) ?? [])
			.filter((l) => !seen.has(l.key))
			.sort(byPlace)
			.map((label) => ({ label, depth, children: level(label.key, depth + 1, new Set([...seen, label.key])) }));
	return level(null, 0, new Set());
}

/** A label's name after the names of the labels it's in: "Work / Clients". The key, for a label that's gone. */
export function labelPath(byKey: ReadonlyMap<string, Label>, key: string): string {
	const names: string[] = [];
	for (let label = byKey.get(key); label && names.length <= 3; label = label.parent === null ? undefined : byKey.get(label.parent)) names.unshift(label.name);
	return names.length > 0 ? names.join(" / ") : key;
}

const NONE: Label[] = [];

/** The user's own labels: as a list, by key, and as a tree. */
export function useLabels() {
	const labels = useQuery(labelsQuery).data ?? NONE;
	return useMemo(() => ({ labels, byKey: new Map(labels.map((l) => [l.key, l])), tree: labelTree(labels) }), [labels]);
}

/** A conversation as labeling sees it: where it lives, and the keys of the labels its mail has. */
export interface Labeled {
	mailboxId: string;
	id: string;
	labels: readonly string[];
}

/** Whether all of these conversations have the label, none do, or only some. */
export function labelState(threads: readonly Labeled[], key: string): "checked" | "unchecked" | "mixed" {
	const have = threads.filter((t) => t.labels.includes(key)).length;
	return have === 0 ? "unchecked" : have === threads.length ? "checked" : "mixed";
}

/** The most conversations one api.modify can name (ModifyThreadsSchema). */
const MODIFY_MAX = 500;

/**
 * The conversations a label goes on (`on`) or comes off that don't have it yet, or do: one api.modify's worth each,
 * since a call goes to one mailbox and names at most MODIFY_MAX.
 */
export function labelBatches(threads: readonly Labeled[], key: string, on: boolean): { mailboxId: string; threadIds: string[] }[] {
	const byMailbox = new Map<string, string[]>();
	for (const t of threads) {
		if (t.labels.includes(key) === on) continue;
		const ids = byMailbox.get(t.mailboxId) ?? [];
		ids.push(t.id);
		byMailbox.set(t.mailboxId, ids);
	}
	return [...byMailbox].flatMap(([mailboxId, ids]) =>
		Array.from({ length: Math.ceil(ids.length / MODIFY_MAX) }, (_, i) => ({ mailboxId, threadIds: ids.slice(i * MODIFY_MAX, (i + 1) * MODIFY_MAX) })),
	);
}

/** Where a label dropped on another goes: just before or after it, or last inside it. */
export type Drop = "before" | "after" | "inside";

/**
 * What moves label `key` to `drop` of label `target`: between the target and its neighbour (or a step past the target at
 * the end), so no other label changes. Null when that's where it already is.
 */
export function labelMove(labels: readonly Label[], key: string, target: string, drop: Drop): LabelChange | null {
	const label = labels.find((l) => l.key === key);
	const to = labels.find((l) => l.key === target);
	if (!label || !to || label === to) return null;
	// A label whose parent is missing sits at the top (labelTree()).
	const keys = new Set(labels.map((l) => l.key));
	const parentOf = (l: Label) => (l.parent !== null && keys.has(l.parent) ? l.parent : null);
	const parent = drop === "inside" ? to.key : parentOf(to);
	const beside = labels.filter((l) => parentOf(l) === parent).sort(byPlace);
	const at = beside.indexOf(to);
	if (parentOf(label) === parent && (drop === "inside" || beside[drop === "before" ? at - 1 : at + 1] === label)) return null;
	const others = beside.filter((l) => l !== label);
	let position: number;
	if (drop === "inside") position = (others.at(-1)?.position ?? 0) + 1;
	else {
		const next = others[others.indexOf(to) + (drop === "before" ? -1 : 1)];
		position = next ? (to.position + next.position) / 2 : to.position + (drop === "before" ? -1 : 1);
	}
	return parentOf(label) === parent ? { position } : { parent, position };
}

/** A tree's labels in order, each just before the labels inside it, with the labels beside it. */
export const labelRows = (nodes: LabelNode[]): { node: LabelNode; beside: LabelNode[] }[] => nodes.flatMap((node) => [{ node, beside: nodes }, ...labelRows(node.children)]);
