import type { Label, LabelColor } from "#shared";
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
