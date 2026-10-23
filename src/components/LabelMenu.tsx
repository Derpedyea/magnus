import { type Label, LABEL_COLORS, type LabelChange, type LabelColor, MAX_LABEL_DEPTH } from "#shared";
import { LabelNameSchema } from "#shared/schemas";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { CheckIcon, EllipsisIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { type LabelNode, labelPath, labelRows, labelStyle, useLabels } from "../labels";
import { labelsQuery } from "../queries";

/** The color picker's stand-in for null: no color. */
const NONE = "none";
const COLORS = [NONE, ...LABEL_COLORS] as const;
const colorName = (color: (typeof COLORS)[number]) => (color === NONE ? "No color" : color.charAt(0).toUpperCase() + color.slice(1));

export function Swatch(props: { color: LabelColor | null; className?: string }) {
	return <span aria-hidden className={cn("size-3 shrink-0 rounded-[3px]", labelStyle(props.color).swatch, props.className)} />;
}

/**
 * Changes labels at once, from a menu or a drag: one label, or the several a move renumbers (labelMove()). The server's
 * refusal (too deep, a name taken) undoes them all and says why.
 */
export function useUpdateLabels() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (changes: { key: string; change: LabelChange }[]) => Promise.all(changes.map((c) => api.updateLabel(c.key, c.change))),
		onMutate: async (changes) => {
			await qc.cancelQueries({ queryKey: labelsQuery.queryKey });
			const before = qc.getQueryData(labelsQuery.queryKey);
			const changed = new Map(changes.map((c) => [c.key, c.change]));
			qc.setQueryData(labelsQuery.queryKey, (r) => r && { labels: r.labels.map((l) => ({ ...l, ...changed.get(l.key) })) });
			return before;
		},
		// Put back at once, in case the refetch fails too.
		onError: (error, _, before) => {
			qc.setQueryData(labelsQuery.queryKey, before);
			toast.add({ title: errorMessage(error), type: "error" });
		},
		onSettled: () => qc.invalidateQueries({ queryKey: labelsQuery.queryKey }),
	});
}

/**
 * A label's ⋯ menu, beside it in the sidebar and in Settings › Labels. `scope`: where a label made inside it goes.
 * `children` add to it, before Delete.
 */
export function LabelMenu(props: { node: LabelNode; scope: string[]; trigger: ReactElement; children?: ReactNode }) {
	const { label, depth } = props.node;
	const [dialog, setDialog] = useState<"rename" | "inside" | "delete" | null>(null);
	const { byKey } = useLabels();
	const update = useUpdateLabels();
	const change = (change: LabelChange) => update.mutate([{ key: label.key, change }]);
	const opener = (name: NonNullable<typeof dialog>) => (open: boolean) => setDialog(open ? name : null);
	return (
		<>
			<DropdownMenu>
				{/* Named by its path, so a screen reader hears where it sits too. */}
				<DropdownMenuTrigger render={props.trigger} aria-label={`More for ${labelPath(byKey, label.key)}`}>
					<EllipsisIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-auto min-w-44">
					<DropdownMenuItem onClick={() => setDialog("rename")}>Rename…</DropdownMenuItem>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>Color</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuRadioGroup value={label.color ?? NONE} onValueChange={(value: (typeof COLORS)[number]) => change({ color: value === NONE ? null : value })}>
								{COLORS.map((color) => (
									<DropdownMenuRadioItem key={color} value={color}>
										<Swatch color={color === NONE ? null : color} />
										{colorName(color)}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					{depth < MAX_LABEL_DEPTH - 1 ? <DropdownMenuItem onClick={() => setDialog("inside")}>New label inside…</DropdownMenuItem> : null}
					<DropdownMenuItem onClick={() => change({ hidden: !label.hidden })}>{label.hidden ? "Show in sidebar" : "Hide from sidebar"}</DropdownMenuItem>
					{props.children}
					<DropdownMenuSeparator />
					<DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
						Delete…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<LabelDialog open={dialog === "rename"} onOpenChange={opener("rename")} rename={label} />
			<LabelDialog open={dialog === "inside"} onOpenChange={opener("inside")} scope={props.scope} parent={label.key} />
			<DeleteLabel open={dialog === "delete"} onOpenChange={opener("delete")} node={props.node} />
		</>
	);
}

type DialogProps = { open: boolean; onOpenChange: (open: boolean) => void };
type FormProps = { scope: string[]; parent?: string } | { rename: Label };

/** A new label, or a new name for one. */
export function LabelDialog({ open, onOpenChange, ...props }: DialogProps & FormProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* The form mounts as it opens, so each opening starts afresh. */}
			<DialogContent>
				<LabelForm {...props} onDone={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	);
}

/** Like Pipedrive's: a name and a row of colors, plus the label it goes inside. Renaming asks only the name. */
function LabelForm(props: FormProps & { onDone: () => void }) {
	const id = useId();
	const qc = useQueryClient();
	const { tree, byKey } = useLabels();
	const renaming = "rename" in props ? props.rename : null;
	const [name, setName] = useState(renaming?.name ?? "");
	const [parent, setParent] = useState("parent" in props ? (props.parent ?? null) : null);
	const [color, setColor] = useState<LabelColor | null>(null);
	// Said after a submit, so it doesn't nag mid-typing. The server says it too, but only as "Bad Request".
	const [invalid, setInvalid] = useState<string | null>(null);
	const save = useMutation({
		mutationFn: (name: string) => ("rename" in props ? api.updateLabel(props.rename.key, { name }) : api.createLabel(props.scope, { name, parent, color })),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: labelsQuery.queryKey });
			props.onDone();
		},
	});
	// A label can go inside one that isn't already as deep as labels go. Null for none: a label can be keyed "none".
	const places = [
		{ value: null, label: "None" },
		...labelRows(tree)
			.filter((r) => r.node.depth < MAX_LABEL_DEPTH - 1)
			.map((r) => ({ value: r.node.label.key, label: labelPath(byKey, r.node.label.key) })),
	];
	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(e) => {
				e.preventDefault();
				const parsed = LabelNameSchema.safeParse(name);
				setInvalid(parsed.error?.issues[0]?.message ?? null);
				if (parsed.success) save.mutate(parsed.data);
			}}
		>
			<DialogHeader>
				<DialogTitle>{renaming ? `Rename “${renaming.name}”` : "New label"}</DialogTitle>
			</DialogHeader>
			<Field data-invalid={invalid || save.error ? true : undefined}>
				<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
				<Input
					id={`${id}-name`}
					autoFocus
					maxLength={64}
					value={name}
					onChange={(e) => {
						setName(e.target.value);
						setInvalid(null);
					}}
					aria-invalid={invalid || save.error ? true : undefined}
				/>
				{invalid ? <FieldError>{invalid}</FieldError> : save.error ? <FieldError>{errorMessage(save.error)}</FieldError> : null}
			</Field>
			{renaming ? null : (
				<>
					<Field>
						<FieldLabel htmlFor={`${id}-inside`}>Inside</FieldLabel>
						<Select items={places} value={parent} onValueChange={setParent}>
							<SelectTrigger id={`${id}-inside`} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{places.map((place) => (
									<SelectItem key={place.value ?? ""} value={place.value}>
										{place.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Field>
						<FieldTitle id={`${id}-color`}>Color</FieldTitle>
						<RadioGroup
							aria-labelledby={`${id}-color`}
							value={color ?? NONE}
							onValueChange={(value: (typeof COLORS)[number]) => setColor(value === NONE ? null : value)}
							className="flex flex-wrap gap-2"
						>
							{COLORS.map((c) => (
								<Radio.Root
									key={c}
									value={c}
									aria-label={colorName(c)}
									className={cn(
										"flex size-6 items-center justify-center rounded-md ring-offset-2 ring-offset-popover outline-none focus-visible:ring-3 focus-visible:ring-ring/50 data-checked:ring-2 data-checked:ring-ring",
										labelStyle(c === NONE ? null : c).swatch,
									)}
								>
									<Radio.Indicator>
										<CheckIcon className="size-3.5 text-white" />
									</Radio.Indicator>
								</Radio.Root>
							))}
						</RadioGroup>
					</Field>
				</>
			)}
			<DialogFooter>
				<Button type="submit" disabled={save.isPending}>
					{save.isPending ? <Spinner data-icon="inline-start" /> : null}
					{renaming ? "Rename" : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}

/** Asks first, saying what deleting does: mail keeps its other labels, and the labels inside it move up. */
function DeleteLabel({ node, open, onOpenChange }: DialogProps & { node: LabelNode }) {
	const { label } = node;
	const qc = useQueryClient();
	const navigate = useNavigate();
	const view = useParams({ strict: false, select: (p) => p.view });
	const deletion = useMutation({
		mutationFn: () => api.deleteLabel(label.key),
		onSuccess: () => {
			onOpenChange(false);
			// Its view would list nothing now.
			if (view === label.key) void navigate({ to: "/$view", params: { view: "inbox" }, search: true });
		},
		// Its mail and counts change too. Refetched even on failure: a mailbox may have deleted it before another refused.
		onSettled: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next, details) => {
				if (deletion.isPending) return details.cancel();
				deletion.reset();
				onOpenChange(next);
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">Delete “{label.name}”?</AlertDialogTitle>
					<AlertDialogDescription>
						It comes off every conversation it's on, and the mail stays wherever else it is.
						{node.children.length > 0 ? " The labels inside it move up into its place." : null}
					</AlertDialogDescription>
				</AlertDialogHeader>
				{deletion.error ? <FieldError>{errorMessage(deletion.error)}</FieldError> : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deletion.isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" disabled={deletion.isPending} onClick={() => deletion.mutate()}>
						{deletion.isPending ? <Spinner data-icon="inline-start" /> : null}
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
