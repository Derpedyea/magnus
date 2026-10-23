import { type Label, labelChain, type MailboxThread } from "#shared";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { hashKey, type InfiniteData, type Query, type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactElement, type RefObject, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Combobox, ComboboxInput, ComboboxList } from "@/components/ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { useScope } from "../hooks";
import { type Labeled, labelBatches, type LabelNode, labelPath, labelState, labelStyle, useLabels } from "../labels";
import { labelsQuery, threadQuery } from "../queries";
import { currentSession } from "../session";

/**
 * "Label as": the user's labels, to put on these conversations or take off, with a box to find one or make a new one.
 * Each change applies at once and it stays open for the next. A label only some of them have shows as mixed, and goes
 * on all of them when chosen.
 */
export function LabelPicker(props: {
	threads: readonly Labeled[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The button that opens it. */
	trigger: ReactElement;
}) {
	const input = useRef<HTMLInputElement>(null);
	return (
		<Popover open={props.open} onOpenChange={props.onOpenChange}>
			<PopoverTrigger render={props.trigger} />
			<PopoverContent align="end" initialFocus={input} className="w-64 gap-0 p-1">
				<LabelList threads={props.threads} input={input} />
			</PopoverContent>
		</Popover>
	);
}

interface Row {
	label: Label;
	depth: number;
	/** "Work / Clients", what the filter matches. */
	path: string;
}
type Option = Row | { create: string };

function LabelList({ threads, input }: { threads: readonly Labeled[]; input: RefObject<HTMLInputElement | null> }) {
	const { byKey, tree } = useLabels();
	const scope = useScope();
	const qc = useQueryClient();
	const relabel = useLabelThreads();
	const create = useMutation({
		mutationFn: (v: { name: string; threads: readonly Labeled[] }) => api.createLabel(scope, { name: v.name }),
		onMutate: currentSession,
		onSuccess: (made, v, session) => {
			if (session !== currentSession()) return;
			// Listed before the labels are refetched, so it doesn't show as its key in the meantime. A live refetch may
			// have brought it already.
			qc.setQueryData(labelsQuery.queryKey, (d) =>
				d && !d.labels.some((l) => l.key === made.key) ? { labels: [...d.labels, { ...made, position: Number.MAX_SAFE_INTEGER, hidden: false }] } : d,
			);
			relabel.mutate({ threads: v.threads, key: made.key, on: true });
		},
		onError: (error, _, session) => {
			if (session === currentSession()) toast.add({ title: `Couldn't create the label: ${errorMessage(error)}`, type: "error" });
		},
	});

	const [query, setQuery] = useState("");
	const rows = useMemo(() => {
		const walk = (nodes: LabelNode[]): Row[] => nodes.flatMap((n) => [{ label: n.label, depth: n.depth, path: labelPath(byKey, n.label.key) }, ...walk(n.children)]);
		return walk(tree);
	}, [tree, byKey]);
	// Each word anywhere in the path, so "work cli" finds Work / Clients.
	const name = query.trim();
	const words = name.toLowerCase().split(/\s+/).filter(Boolean);
	const shown = rows.filter((r) => words.every((w) => r.path.toLowerCase().includes(w)));
	// A new label goes at the top, where it can't share a name, and a name can't have a / in it.
	const offer = name !== "" && !name.includes("/") && !rows.some((r) => r.path.toLowerCase() === name.toLowerCase());
	const options: Option[] = offer ? [...shown, { create: name }] : shown;
	const checked: Option[] = rows.filter((r) => labelState(threads, r.label.key) === "checked");

	const choose = (option: Option) => {
		if ("create" in option) {
			if (!create.isPending) create.mutate({ name: option.create, threads });
			setQuery("");
		} else {
			relabel.mutate({ threads, key: option.label.key, on: labelState(threads, option.label.key) !== "checked" });
		}
	};
	// Space types in the box, since filters have spaces, except once you've moved to a label or before you've typed:
	// then it toggles the label highlighted, if any (on opening, the first one they have).
	const highlighted = useRef<Option | undefined>(undefined);
	const browsing = useRef(false);
	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") browsing.current = true;
		else if (e.key === " " && (browsing.current || query === "")) {
			e.preventDefault();
			if (highlighted.current) choose(highlighted.current);
		}
	};

	return (
		<Combobox
			inline
			open
			multiple
			items={options}
			filter={null}
			value={checked}
			// One option at a time changes: the one that's in one list and not the other.
			onValueChange={(next) => {
				const changed = next.find((o) => !checked.includes(o)) ?? checked.find((o) => !next.includes(o));
				if (changed) choose(changed);
			}}
			inputValue={query}
			onInputValueChange={(value) => {
				browsing.current = false;
				setQuery(value);
			}}
			itemToStringLabel={(o) => ("create" in o ? o.create : o.path)}
			onItemHighlighted={(o) => (highlighted.current = o)}
			autoHighlight
		>
			<ComboboxInput ref={input} showTrigger={false} placeholder="Find or create a label" onKeyDown={onKeyDown} />
			<ComboboxList className="mt-1 px-0 pb-0 empty:hidden">
				{(o: Option) =>
					"create" in o ? (
						<ComboboxPrimitive.Item key="create" value={o} disabled={create.isPending} className={ROW}>
							<PlusIcon className="size-4 text-muted-foreground" />
							<span className="truncate">Create “{o.create}”</span>
						</ComboboxPrimitive.Item>
					) : (
						<ComboboxPrimitive.Item key={o.label.key} value={o} className={ROW}>
							<Check state={labelState(threads, o.label.key)} />
							{/* Indented by nesting, or, filtered, named with the labels it's inside. */}
							<span className="flex min-w-0 items-center gap-2" style={{ marginInlineStart: words.length ? 0 : `${o.depth}rem` }}>
								<span className={cn("size-2.5 shrink-0 rounded-[3px]", labelStyle(o.label.color).swatch)} />
								<span className="truncate">
									{words.length > 0 && o.depth > 0 ? <span className="text-muted-foreground">{o.path.slice(0, -o.label.name.length)}</span> : null}
									{o.label.name}
								</span>
							</span>
						</ComboboxPrimitive.Item>
					)
				}
			</ComboboxList>
		</Combobox>
	);
}

const ROW =
	"flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground";

/** A checkbox's look. The row is what's checked (aria-selected), so the box itself isn't a control. */
function Check({ state }: { state: ReturnType<typeof labelState> }) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input dark:bg-input/30",
				state !== "unchecked" && "border-primary bg-primary text-primary-foreground dark:bg-primary",
			)}
		>
			{state === "checked" ? <CheckIcon className="size-3.5" /> : state === "mixed" ? <MinusIcon className="size-3.5" /> : null}
		</span>
	);
}

/** A label on mail: its name, tinted its color. The key, for a label that's gone. `onRemove` adds an × that takes it off. */
export function LabelChip({ labelKey, label, onRemove }: { labelKey: string; label: Label | undefined; onRemove?: () => void }) {
	const name = label?.name ?? labelKey;
	return (
		<span className={cn("inline-flex h-5 max-w-32 min-w-0 items-center gap-0.5 rounded-sm px-1.5 text-xs font-medium", labelStyle(label?.color ?? null).chip, onRemove && "pr-0.5")}>
			<span className="truncate">{name}</span>
			{onRemove ? (
				<button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className="rounded-sm opacity-60 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring">
					<XIcon className="size-3" />
				</button>
			) : null}
		</span>
	);
}

const isList = (key: QueryKey) => key[0] === "mail" && (key[1] === "threads" || key[1] === "search");

const LABELING = ["labeling"];

/**
 * Puts a label on conversations, or takes it off. It shows at once in their lists and threads, and once the last
 * change is in, the mail is refetched, which undoes any that failed.
 */
export function useLabelThreads() {
	const qc = useQueryClient();
	return useMutation({
		// One at a time, in order, so a label checked and quickly unchecked ends up off.
		mutationKey: LABELING,
		scope: { id: "labeling" },
		mutationFn: async ({ threads, key, on }: { threads: readonly Labeled[]; key: string; on: boolean }) => {
			// A mailbox that doesn't have the label yet takes it on, with the labels it's inside.
			const labels = qc.getQueryData(labelsQuery.queryKey)?.labels ?? [];
			const define = on ? labelChain(labels, key).map(({ key, name, parent, color }) => ({ key, name, parent, color })) : [];
			// All of them finish, even when one fails, before the next change starts.
			const sent = await Promise.allSettled(labelBatches(threads, key, on).map((b) => api.modify(b.mailboxId, b.threadIds, on ? [key] : [], on ? [] : [key], define)));
			const failed = sent.find((r) => r.status === "rejected");
			if (failed) throw failed.reason;
		},
		onMutate: async ({ threads, key, on }) => {
			const session = currentSession();
			const relabel = <T extends { labels: string[] }>(t: T): T => ({ ...t, labels: on ? [...new Set([...t.labels, key])] : t.labels.filter((l) => l !== key) });
			const ids = new Set(threads.map((t) => `${t.mailboxId}/${t.id}`));
			const opened = new Set(threads.map((t) => hashKey(threadQuery(t.mailboxId, t.id).queryKey)));
			// A refetch already under way would bring back the labels from before. One still loading has nothing to change.
			await qc.cancelQueries({ predicate: (q: Query) => q.state.data !== undefined && (opened.has(q.queryHash) || isList(q.queryKey)) });
			qc.setQueriesData<InfiniteData<{ threads: MailboxThread[] }>>(
				{ predicate: (q) => isList(q.queryKey) },
				(d) => d && { ...d, pages: d.pages.map((p) => ({ ...p, threads: p.threads.map((t) => (ids.has(`${t.mailboxId}/${t.id}`) ? relabel(t) : t)) })) },
			);
			for (const t of threads) qc.setQueryData(threadQuery(t.mailboxId, t.id).queryKey, (d) => d && { ...d, thread: relabel(d.thread) });
			return session;
		},
		onError: (error, { on }, session) => {
			if (session === currentSession()) toast.add({ title: `Couldn't ${on ? "add" : "remove"} the label: ${errorMessage(error)}`, type: "error" });
		},
		// Not between changes: what came back would undo the ones still waiting.
		onSettled: () => {
			if (qc.isMutating({ mutationKey: LABELING }) === 1) void qc.invalidateQueries({ queryKey: ["mail"] });
		},
	});
}
