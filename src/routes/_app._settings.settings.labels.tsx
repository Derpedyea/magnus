import { labelChain, MAX_LABEL_DEPTH } from "#shared";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { GripVerticalIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { LabelDialog, LabelMenu, Swatch, useUpdateLabels } from "../components/LabelMenu";
import { SettingsPage } from "../components/SettingsPage";
import { type Drop, type LabelNode, labelMove, labelPath, labelRows, useLabels } from "../labels";
import { labelsQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/settings/labels")({ component: Labels });

/** Where a drop would put the dragged label: a line above or below the row, or the row outlined to go inside it. */
const DROP: Record<Drop, string> = {
	before: "shadow-[inset_0_2px_0_var(--color-primary)]",
	after: "shadow-[inset_0_-2px_0_var(--color-primary)]",
	inside: "bg-accent shadow-[inset_0_0_0_2px_var(--color-primary)]",
};

type Move = (key: string, target: string, drop: Drop) => void;

/**
 * Every label, hidden ones too, like Proton's folders and labels: drag one above or below another to move it there, or
 * onto one to put it inside. Its menu does the same from the keyboard.
 */
function Labels() {
	// Waits for the labels, so the page doesn't say there are none while they load.
	useSuspenseQuery(labelsQuery);
	const { labels, tree } = useLabels();
	const [creating, setCreating] = useState(false);
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<{ key: string; drop: Drop } | null>(null);
	const update = useUpdateLabels();
	const move: Move = (key, target, drop) => {
		const changes = labelMove(labels, key, target, drop);
		if (changes.length > 0) update.mutate(changes);
	};
	const end = () => {
		setDragging(null);
		setOver(null);
	};

	return (
		<SettingsPage
			title="Labels"
			action={
				<Button onClick={() => setCreating(true)}>
					<PlusIcon data-icon="inline-start" />
					New label
				</Button>
			}
		>
			{labels.length === 0 ? (
				<p className="text-muted-foreground">No labels yet.</p>
			) : (
				<ul
					aria-label="Labels"
					className="border-t"
					onDragLeave={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
					}}
				>
					{labelRows(tree).map(({ node, beside }) => {
						const { label, depth } = node;
						return (
							<li
								key={label.key}
								draggable
								onDragStart={(e) => {
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", label.name);
									setDragging(label.key);
								}}
								onDragOver={(e) => {
									// Not onto itself or a label inside it: the server would refuse.
									if (!dragging || labelChain(labels, label.key).some((l) => l.key === dragging)) return;
									e.preventDefault();
									const box = e.currentTarget.getBoundingClientRect();
									const y = (e.clientY - box.top) / box.height;
									const drop = y < 0.25 ? "before" : y > 0.75 ? "after" : "inside";
									if (over?.key !== label.key || over.drop !== drop) setOver({ key: label.key, drop });
								}}
								onDrop={(e) => {
									e.preventDefault();
									if (dragging && over) move(dragging, over.key, over.drop);
									end();
								}}
								onDragEnd={end}
								className={cn("flex h-11 items-center gap-2 border-b pr-1", dragging === label.key && "opacity-50", over?.key === label.key && DROP[over.drop])}
								style={{ paddingLeft: 4 + depth * 24 }}
							>
								<GripVerticalIcon aria-hidden className="size-4 shrink-0 cursor-grab text-muted-foreground" />
								<Swatch color={label.color} />
								<span className={cn("truncate", label.hidden && "text-muted-foreground")}>{label.name}</span>
								{label.hidden ? <span className="shrink-0 text-xs text-muted-foreground">Hidden</span> : null}
								<LabelMenu node={node} scope={[]} trigger={<Button variant="ghost" size="icon-sm" className="ml-auto" />}>
									<MoveItems node={node} beside={beside} move={move} />
								</LabelMenu>
							</li>
						);
					})}
				</ul>
			)}
			{/* From here no addresses are in view, so it goes into all your mailboxes. */}
			<LabelDialog open={creating} onOpenChange={setCreating} scope={[]} />
		</SettingsPage>
	);
}

/** Dragging from the keyboard: up or down past the label beside it, or into another. */
function MoveItems({ node, beside, move }: { node: LabelNode; beside: LabelNode[]; move: Move }) {
	const { tree, byKey } = useLabels();
	const { label } = node;
	const before = beside[beside.indexOf(node) - 1];
	const after = beside[beside.indexOf(node) + 1];
	const height = (n: LabelNode): number => 1 + Math.max(0, ...n.children.map(height));
	const own = new Set(labelRows([node]).map((r) => r.node.label.key));
	// Not into itself or a label inside it, nor so deep that its own sublabels would go past the limit.
	const into = labelRows(tree)
		.map((r) => r.node)
		.filter((n) => !own.has(n.label.key) && n.label.key !== label.parent && n.depth + 1 + height(node) <= MAX_LABEL_DEPTH);
	const top = tree.at(-1);
	return (
		<>
			<DropdownMenuSeparator />
			<DropdownMenuItem disabled={!before} onClick={() => before && move(label.key, before.label.key, "before")}>
				Move up
			</DropdownMenuItem>
			<DropdownMenuItem disabled={!after} onClick={() => after && move(label.key, after.label.key, "after")}>
				Move down
			</DropdownMenuItem>
			{into.length > 0 || node.depth > 0 ? (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>Move into</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						{node.depth > 0 && top ? <DropdownMenuItem onClick={() => move(label.key, top.label.key, "after")}>Top level</DropdownMenuItem> : null}
						{into.map((n) => (
							<DropdownMenuItem key={n.label.key} onClick={() => move(label.key, n.label.key, "inside")}>
								<Swatch color={n.label.color} />
								{labelPath(byKey, n.label.key)}
							</DropdownMenuItem>
						))}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			) : null}
		</>
	);
}
