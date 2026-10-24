import type { MailboxMembership, Rule } from "#shared";
import { useMutation, useQueryClient, useSuspenseQueries, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EllipsisIcon, GripVerticalIcon, ListFilterIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FieldError, FieldLegend, FieldSet } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { RuleDialog, ruleSummary } from "../components/RuleDialog";
import { SettingsPage } from "../components/SettingsPage";
import { useAccount } from "../hooks";
import { useLabels } from "../labels";
import { rulesQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/settings/rules")({ component: Rules });

type Editing = { mailboxId: string; rule: Rule } | null;

/** Each mailbox's rules, in the order they run on new mail: drag one above or below another to move it there. */
function Rules() {
	const { mailboxes } = useAccount();
	// Waits for them all, so the page doesn't say there are none while they load.
	useSuspenseQueries({ queries: mailboxes.map((m) => rulesQuery(m.id)) });
	const [editing, setEditing] = useState<Editing>(null);
	const [dialog, setDialog] = useState(false);
	const open = (edit: Editing) => {
		setEditing(edit);
		setDialog(true);
	};
	return (
		<SettingsPage
			title="Rules"
			action={
				<Button onClick={() => open(null)}>
					<PlusIcon data-icon="inline-start" />
					New rule
				</Button>
			}
		>
			<div className="flex flex-col gap-8">
				{mailboxes.map((m) => (
					<MailboxRules key={m.id} mailbox={m} named={mailboxes.length > 1} onEdit={(rule) => open({ mailboxId: m.id, rule })} />
				))}
			</div>
			<RuleDialog open={dialog} onOpenChange={setDialog} edit={editing} />
		</SettingsPage>
	);
}

/** Where a drop would put the dragged rule: a line above the row or below it. */
const DROP = { before: "shadow-[inset_0_2px_0_var(--color-primary)]", after: "shadow-[inset_0_-2px_0_var(--color-primary)]" };

function MailboxRules({ mailbox, named, onEdit }: { mailbox: MailboxMembership; named: boolean; onEdit: (rule: Rule) => void }) {
	const query = rulesQuery(mailbox.id);
	const rules = useSuspenseQuery(query).data;
	const { byKey } = useLabels();
	const qc = useQueryClient();
	const [dragging, setDragging] = useState<string | null>(null);
	const [over, setOver] = useState<{ id: string; drop: keyof typeof DROP } | null>(null);
	const [deleting, setDeleting] = useState<Rule | null>(null);

	// Both show at once, and the server's refusal (the rules changed meanwhile) puts them back as they are.
	const optimistic = async (next: (rules: Rule[]) => Rule[]) => {
		await qc.cancelQueries({ queryKey: query.queryKey });
		qc.setQueryData(query.queryKey, (r) => r && { rules: next(r.rules) });
	};
	const settled = () => qc.invalidateQueries({ queryKey: query.queryKey });
	const reorder = useMutation({
		mutationFn: (ids: string[]) => api.reorderRules(mailbox.id, ids),
		onMutate: (ids) => optimistic((rules) => ids.flatMap((id) => rules.filter((r) => r.id === id))),
		onError: (error) => toast.add({ title: `Couldn't move the rule: ${errorMessage(error)}`, type: "error" }),
		onSettled: settled,
	});
	const toggle = useMutation({
		mutationFn: ({ rule, enabled }: { rule: Rule; enabled: boolean }) => api.updateRule(mailbox.id, rule.id, { ...rule, enabled }),
		onMutate: ({ rule, enabled }) => optimistic((rules) => rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r))),
		onError: (error, { enabled }) => toast.add({ title: `Couldn't turn the rule ${enabled ? "on" : "off"}: ${errorMessage(error)}`, type: "error" }),
		onSettled: settled,
	});
	const move = (id: string, target: string, drop: keyof typeof DROP) => {
		if (id === target) return;
		const ids = rules.map((r) => r.id).filter((r) => r !== id);
		ids.splice(ids.indexOf(target) + (drop === "after" ? 1 : 0), 0, id);
		if (ids.some((r, i) => r !== rules[i]?.id)) reorder.mutate(ids);
	};
	const end = () => {
		setDragging(null);
		setOver(null);
	};

	return (
		// A fieldset is as wide as its widest line, rules' cut-off summaries included, unless told otherwise.
		<FieldSet className="min-w-0">
			{named ? (
				<FieldLegend>
					{mailbox.name} <span className="font-normal text-muted-foreground">{mailbox.addresses.map((a) => a.address).join(", ")}</span>
				</FieldLegend>
			) : null}
			{rules.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<ListFilterIcon />
						</EmptyMedia>
						<EmptyTitle>No rules yet</EmptyTitle>
						<EmptyDescription>Rules file new mail as it arrives: label it, star it, keep it out of the inbox, and more, in the order they're listed.</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<ul
					aria-label={named ? `Rules for ${mailbox.name}` : "Rules"}
					className="border-t"
					onDragLeave={(e) => {
						if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
					}}
				>
					{rules.map((rule, i) => (
						<li
							key={rule.id}
							draggable
							onDragStart={(e) => {
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData("text/plain", rule.name);
								setDragging(rule.id);
							}}
							onDragOver={(e) => {
								if (!dragging || !rules.some((r) => r.id === dragging)) return;
								e.preventDefault();
								const box = e.currentTarget.getBoundingClientRect();
								const drop = e.clientY - box.top < box.height / 2 ? "before" : "after";
								if (over?.id !== rule.id || over.drop !== drop) setOver({ id: rule.id, drop });
							}}
							onDrop={(e) => {
								e.preventDefault();
								if (dragging && over) move(dragging, over.id, over.drop);
								end();
							}}
							onDragEnd={end}
							className={cn("flex min-h-14 items-center gap-2 border-b py-2 pr-1 pl-1", dragging === rule.id && "opacity-50", over?.id === rule.id && DROP[over.drop])}
						>
							<GripVerticalIcon aria-hidden className="size-4 shrink-0 cursor-grab text-muted-foreground" />
							<button type="button" onClick={() => onEdit(rule)} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
								<span className="flex items-center gap-2">
									<span className={cn("truncate font-medium", !rule.enabled && "text-muted-foreground")}>{rule.name}</span>
									{rule.createdBy === "agent" ? <Badge variant="secondary">Agent</Badge> : null}
								</span>
								<span className="block truncate text-xs text-muted-foreground">{ruleSummary(rule, byKey)}</span>
							</button>
							<Switch
								checked={rule.enabled}
								aria-label={`Run “${rule.name}”`}
								disabled={toggle.isPending && toggle.variables.rule.id === rule.id}
								onCheckedChange={(enabled) => toggle.mutate({ rule, enabled })}
							/>
							<DropdownMenu>
								<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />} aria-label={`More for “${rule.name}”`}>
									<EllipsisIcon />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="w-auto min-w-40">
									<DropdownMenuItem onClick={() => onEdit(rule)}>Edit…</DropdownMenuItem>
									{/* Dragging, from the keyboard. */}
									<DropdownMenuItem disabled={i === 0} onClick={() => move(rule.id, rules[i - 1]?.id ?? rule.id, "before")}>
										Move up
									</DropdownMenuItem>
									<DropdownMenuItem disabled={i === rules.length - 1} onClick={() => move(rule.id, rules[i + 1]?.id ?? rule.id, "after")}>
										Move down
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem variant="destructive" onClick={() => setDeleting(rule)}>
										Delete…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						</li>
					))}
				</ul>
			)}
			<DeleteRule mailboxId={mailbox.id} rule={deleting} onClose={() => setDeleting(null)} />
		</FieldSet>
	);
}

/** Asks first. Mail it already filed stays where it is. */
function DeleteRule({ mailboxId, rule, onClose }: { mailboxId: string; rule: Rule | null; onClose: () => void }) {
	const qc = useQueryClient();
	const deletion = useMutation({
		mutationFn: (rule: Rule) => api.deleteRule(mailboxId, rule.id),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey });
			onClose();
		},
	});
	// Kept while it closes, so its title doesn't empty mid-animation.
	const [shown, setShown] = useState(rule);
	if (rule && rule !== shown) setShown(rule);
	return (
		<AlertDialog
			open={rule !== null}
			onOpenChange={(next, details) => {
				if (deletion.isPending) return details.cancel();
				deletion.reset();
				if (!next) onClose();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle className="break-words">Delete “{shown?.name}”?</AlertDialogTitle>
					<AlertDialogDescription>New mail stops being filed by it. Mail it already filed stays where it is.</AlertDialogDescription>
				</AlertDialogHeader>
				{deletion.error ? <FieldError>{errorMessage(deletion.error)}</FieldError> : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={deletion.isPending}>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="destructive" disabled={deletion.isPending} onClick={() => shown && deletion.mutate(shown)}>
						{deletion.isPending ? <Spinner data-icon="inline-start" /> : null}
						Delete
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
