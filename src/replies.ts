/**
 * Lays a thread out as a tree that only branches where replies fork. A run of messages that each answer the one
 * before stays one straight branch, so a conversation without forks reads top to bottom like a plain list; when
 * two or more reply to the same message, each starts its own branch under it.
 */

/** How many forks deep branches indent. Replies below that continue in their branch, marked with who they answer. */
export const MAX_DEPTH = 3;

/** Messages that each answer the one before, then the branches forking off the last one (none, or two or more). */
export interface Branch<M> {
	messages: M[];
	forks: Branch<M>[];
}

/** `messages` oldest first, as threads come. Messages answering nothing here each start a branch at the top. */
export function replyTree<M extends { id: string; parentId: string | null }>(messages: M[]): Branch<M>[] {
	const ids = new Set(messages.map((m) => m.id));
	const children = new Map<string, M[]>();
	const roots: M[] = [];
	for (const m of messages) {
		if (m.parentId && ids.has(m.parentId)) children.set(m.parentId, [...(children.get(m.parentId) ?? []), m]);
		else roots.push(m);
	}
	const below = (m: M): M[] => children.get(m.id) ?? [];
	const subtree = (m: M): M[] => [m, ...below(m).flatMap(subtree)];

	const grow = (first: M, depth: number): Branch<M> => {
		const branch: Branch<M> = { messages: [first], forks: [] };
		for (let last = first; ; ) {
			const next = below(last);
			if (next.length === 0) return branch;
			if (next.length === 1) {
				last = next[0]!;
				branch.messages.push(last);
			} else if (depth < MAX_DEPTH) {
				branch.forks = next.map((m) => grow(m, depth + 1));
				return branch;
			} else {
				branch.messages.push(...next.flatMap(subtree));
				return branch;
			}
		}
	};
	return roots.map((m) => grow(m, 0));
}
