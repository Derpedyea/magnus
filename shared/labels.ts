import { RESERVED_LABELS } from "./address";
import { type Label, SYSTEM_LABELS } from "./types";

const SYSTEM = new Set<string>(SYSTEM_LABELS);

/** Whether mail's label is one of the person's own rather than a system label. */
export const isOwnLabel = (key: string) => !SYSTEM.has(key);

/**
 * A key for a new label named `path` (the labels it sits inside, then its own name) that isn't `taken`: Work › Clients
 * is `work-clients`, which a +tag can name too (`me+work-clients@…`).
 */
export function labelKey(path: string[], taken: ReadonlySet<string>): string {
	const slug =
		Array.from(
			path
				.join("-")
				.toLowerCase()
				.replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
				.replaceAll(/^[-.]+|[-.]+$/g, ""),
		)
			.slice(0, 55)
			.join("") || "label";
	const base = RESERVED_LABELS.has(slug) ? `${slug}-label` : slug;
	let key = base;
	for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
	return key;
}

/**
 * The labels of several mailboxes as one list, a label's key standing for it in each. Where mailboxes disagree about
 * one (people sharing a mailbox renamed it), the first mailbox's says how it looks.
 */
export function mergeLabels(lists: Label[][]): Label[] {
	const merged = new Map<string, Label>();
	for (const list of lists) for (const label of list) if (!merged.has(label.key)) merged.set(label.key, label);
	return [...merged.values()];
}

/** The label with this key and the labels it sits inside, outermost first. Empty when there's no such label. */
export function labelChain(labels: readonly Label[], key: string): Label[] {
	const byKey = new Map(labels.map((l) => [l.key, l]));
	const chain: Label[] = [];
	for (let label = byKey.get(key); label && !chain.includes(label); label = label.parent === null ? undefined : byKey.get(label.parent)) chain.unshift(label);
	return chain;
}
