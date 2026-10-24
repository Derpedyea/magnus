import { type Label, type Rule, type RuleAction, type RuleCondition, RULE_ACTIONS, RULE_FLAGS, type RuleFlag, type RuleInput, type RulePreview, type RuleTextOp } from "#shared";
import { RuleInputSchema } from "#shared/schemas";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { useAccount } from "../hooks";
import { labelPath, labelRows, useLabels } from "../labels";
import { rulesQuery } from "../queries";
import { Swatch } from "./LabelMenu";

type ConditionField = RuleCondition["field"];

const FIELDS: { value: ConditionField; label: string }[] = [
	{ value: "from", label: "From" },
	{ value: "to", label: "To" },
	{ value: "cc", label: "Cc" },
	{ value: "recipient", label: "Recipient" },
	{ value: "subject", label: "Subject" },
	{ value: "body", label: "Body" },
	{ value: "list-id", label: "List-Id" },
	{ value: "header", label: "Header" },
	{ value: "has-attachment", label: "Has an attachment" },
	{ value: "verified-sender", label: "Sender is verified" },
	{ value: "mailing-list", label: "From a mailing list" },
];
const FIELD_NAMES = Object.fromEntries(FIELDS.map((f) => [f.value, f.label])) as Record<ConditionField, string>;

// Not is part of the comparison, as Fastmail's and Gmail's filters put it: "doesn't contain" reads better than a box.
const OPS: { op: RuleTextOp | "exists"; is: string; isNot: string }[] = [
	{ op: "contains", is: "contains", isNot: "doesn't contain" },
	{ op: "is", is: "is", isNot: "isn't" },
	{ op: "starts-with", is: "starts with", isNot: "doesn't start with" },
	{ op: "ends-with", is: "ends with", isNot: "doesn't end with" },
	{ op: "exists", is: "exists", isNot: "doesn't exist" },
];
const opItems = (field: ConditionField) => OPS.filter((o) => o.op !== "exists" || field === "header").flatMap((o) => [{ value: o.op, label: o.is }, { value: `not ${o.op}`, label: o.isNot }]);
const YES_NO = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];

const ACTION_NAMES: Record<RuleAction["do"], { label: string; short: string }> = {
	label: { label: "Label as", short: "Label" },
	"skip-inbox": { label: "Skip the inbox", short: "Skip inbox" },
	star: { label: "Star it", short: "Star" },
	"mark-read": { label: "Mark it read", short: "Mark read" },
	spam: { label: "Send to Spam", short: "Spam" },
	trash: { label: "Move to Trash", short: "Trash" },
};
const ACTIONS = RULE_ACTIONS.map((a) => ({ value: a, label: ACTION_NAMES[a].label }));

const isFlag = (field: ConditionField): field is RuleFlag => (RULE_FLAGS as readonly string[]).includes(field);

/**
 * One line for a rule's list row, like Fastmail's: "From contains linkedin.com · AI: is a job offer → Jobs, Skip inbox".
 * Labels by name, or their key once they're gone.
 */
export function ruleSummary(rule: RuleInput, byKey: ReadonlyMap<string, Label>): string {
	const condition = (c: RuleCondition): string => {
		if (!("op" in c)) {
			if (c.field === "has-attachment") return c.not ? "No attachment" : "Has an attachment";
			if (c.field === "verified-sender") return c.not ? "Sender isn't verified" : "Sender is verified";
			return c.not ? "Not from a mailing list" : "From a mailing list";
		}
		const op = OPS.find((o) => o.op === c.op);
		const compared = `${c.not ? op?.isNot : op?.is}${c.op === "exists" ? "" : ` ${c.value}`}`;
		return c.field === "header" ? `Header ${c.name} ${compared}` : `${FIELD_NAMES[c.field]} ${compared}`;
	};
	const conditions = [...rule.conditions.map(condition), ...(rule.ai === null ? [] : [`AI: ${rule.ai}`])].join(rule.match === "any" ? " or " : " · ");
	const actions = rule.actions.map((a) => (a.do === "label" ? labelPath(byKey, a.label) : ACTION_NAMES[a.do].short));
	return `${conditions} → ${actions.join(", ")}${rule.stop ? ", then stop" : ""}`;
}

/** A condition as the form holds it: what every input says, so changing its field and back keeps what was typed. */
interface ConditionDraft {
	field: ConditionField;
	op: RuleTextOp | "exists";
	not: boolean;
	value: string;
	name: string;
}

interface Draft extends Omit<RuleInput, "conditions" | "ai"> {
	conditions: ConditionDraft[];
	ai: string;
}

const NEW_CONDITION: ConditionDraft = { field: "from", op: "contains", not: false, value: "", name: "" };

function draftOf(rule: Rule | null, labels: Label[]): Draft {
	if (!rule) {
		const label = labels[0];
		return { name: "", enabled: true, match: "all", conditions: [NEW_CONDITION], ai: "", actions: [label ? { do: "label", label: label.key } : { do: "skip-inbox" }], stop: false };
	}
	return {
		...rule,
		conditions: rule.conditions.map((c) => ({ ...NEW_CONDITION, ...c, not: c.not === true })),
		ai: rule.ai ?? "",
	};
}

/** The rule a draft says, as the server takes it; the schema says what's missing, by where it is (`conditions.0.value`). */
function parseDraft(d: Draft) {
	const conditions = d.conditions.map((c) => {
		const not = c.not ? { not: true } : {};
		if (isFlag(c.field)) return { field: c.field, ...not };
		if (c.field === "header") return { field: c.field, name: c.name, op: c.op, value: c.op === "exists" ? undefined : c.value, ...not };
		return { field: c.field, op: c.op === "exists" ? "contains" : c.op, value: c.value, ...not };
	});
	return RuleInputSchema.safeParse({ ...d, conditions, ai: d.ai.trim() === "" ? null : d.ai });
}

type Invalid = { path: string; message: string };

function invalidOf(issues: { path: PropertyKey[]; message: string }[]): Invalid | null {
	const issue = issues[0];
	if (!issue) return null;
	const path = issue.path.join(".");
	// A label action with none picked fails as a key, which says nothing to the person picking.
	return { path, message: /^actions\.\d+\.label$/.test(path) ? "Pick a label" : issue.message };
}

/** A new rule, for one of your mailboxes, or a change to one. `edit`: the rule and the mailbox it's in. */
export function RuleDialog({ open, onOpenChange, edit }: { open: boolean; onOpenChange: (open: boolean) => void; edit: { mailboxId: string; rule: Rule } | null }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* The form mounts as it opens, so each opening starts afresh. Tall rules scroll inside it. */}
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
				<RuleForm edit={edit} onDone={() => onOpenChange(false)} />
			</DialogContent>
		</Dialog>
	);
}

/**
 * Conditions, an optional AI condition, and what to do, like Fastmail's rule editor, with Gmail's "see what it
 * matches" before saving. A rule without an AI condition can then file the mail already here too.
 */
function RuleForm({ edit, onDone }: { edit: { mailboxId: string; rule: Rule } | null; onDone: () => void }) {
	const id = useId();
	const qc = useQueryClient();
	const { mailboxes } = useAccount();
	const { labels, tree, byKey } = useLabels();
	const [mailboxId, setMailboxId] = useState(edit?.mailboxId ?? mailboxes[0]?.id ?? "");
	const [draft, setDraft] = useState(() => draftOf(edit?.rule ?? null, labels));
	// Said after a submit or preview, so it doesn't nag mid-typing. The server says it too, but only as "Bad Request".
	const [invalid, setInvalid] = useState<Invalid | null>(null);
	// Once a rule that can file mail already here is saved, and some matches: whether to.
	const [saved, setSaved] = useState<{ rule: Rule; found: RulePreview } | null>(null);
	const preview = useMutation({ mutationFn: (input: RuleInput) => api.previewRule(mailboxId, input) });
	const save = useMutation({
		mutationFn: (input: RuleInput) => (edit ? api.updateRule(mailboxId, edit.rule.id, input) : api.createRule(mailboxId, input)),
		onSuccess: async (rule, input) => {
			await qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey });
			// A rule asking the AI only ever reads new mail.
			const found = rule.ai === null && rule.enabled ? await api.previewRule(mailboxId, input).catch(() => null) : null;
			if (found && found.matched > 0) setSaved({ rule, found });
			else onDone();
		},
	});
	const apply = useMutation({
		mutationFn: (rule: Rule) => api.applyRule(mailboxId, rule.id),
		onSuccess: ({ applied }) => {
			toast.add({ title: `Filed ${applied} ${applied === 1 ? "message" : "messages"}`, type: "success" });
			onDone();
		},
	});

	// Any change makes a preview out of date, and the error it was about.
	const change = (next: (d: Draft) => Draft) => {
		setDraft(next);
		setInvalid(null);
		preview.reset();
	};
	const setCondition = (i: number, c: Partial<ConditionDraft>) => change((d) => ({ ...d, conditions: d.conditions.map((old, j) => (j === i ? { ...old, ...c } : old)) }));
	const setAction = (i: number, a: RuleAction) => change((d) => ({ ...d, actions: d.actions.map((old, j) => (j === i ? a : old)) }));
	const parsed = () => {
		const result = parseDraft(draft);
		setInvalid(result.success ? null : invalidOf(result.error.issues));
		return result.success ? result.data : null;
	};
	const bad = (path: string) => (invalid?.path === path ? true : undefined);

	if (saved) {
		const { matched, scanned } = saved.found;
		return (
			<div className="flex flex-col gap-4">
				<DialogHeader>
					<DialogTitle className="break-words">Saved “{saved.rule.name}”</DialogTitle>
					<DialogDescription>
						It files new mail from now on. It also matches {matched} of the last {scanned} {scanned === 1 ? "message" : "messages"} here.
					</DialogDescription>
				</DialogHeader>
				{apply.error ? <FieldError>{errorMessage(apply.error)}</FieldError> : null}
				<DialogFooter>
					<Button variant="outline" disabled={apply.isPending} onClick={onDone}>
						Not now
					</Button>
					<Button disabled={apply.isPending} onClick={() => apply.mutate(saved.rule)}>
						{apply.isPending ? <Spinner data-icon="inline-start" /> : null}
						Also apply to {matched} existing {matched === 1 ? "message" : "messages"}
					</Button>
				</DialogFooter>
			</div>
		);
	}

	const labelItems = labelRows(tree).map((r) => ({ value: r.node.label.key, label: labelPath(byKey, r.node.label.key) }));
	const result = preview.data;
	return (
		<form
			// Not wider than the dialog: truncated preview rows would otherwise widen it to their whole text.
			className="flex min-w-0 flex-col gap-5"
			onSubmit={(e) => {
				e.preventDefault();
				const input = parsed();
				if (input) save.mutate(input);
			}}
		>
			<DialogHeader>
				<DialogTitle className="break-words">{edit ? `Edit “${edit.rule.name}”` : "New rule"}</DialogTitle>
			</DialogHeader>
			<div className="flex flex-wrap gap-4">
				<Field className="min-w-48 flex-1" data-invalid={bad("name")}>
					<FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
					<Input id={`${id}-name`} autoFocus maxLength={100} value={draft.name} onChange={(e) => change((d) => ({ ...d, name: e.target.value }))} aria-invalid={bad("name")} />
				</Field>
				{!edit && mailboxes.length > 1 ? (
					<Field className="min-w-48 flex-1">
						<FieldLabel htmlFor={`${id}-mailbox`}>Mailbox</FieldLabel>
						<Select
							items={mailboxes.map((m) => ({ value: m.id, label: m.name }))}
							value={mailboxId}
							onValueChange={(value) => {
								if (value === null) return;
								setMailboxId(value);
								preview.reset();
							}}
						>
							<SelectTrigger id={`${id}-mailbox`} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{mailboxes.map((m) => (
									<SelectItem key={m.id} value={m.id}>
										{m.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
				) : null}
			</div>

			<FieldSet className="gap-2">
				<FieldLegend variant="label" className="mb-1 flex flex-wrap items-center gap-2">
					When mail matches
					<Select items={[{ value: "all", label: "all" }, { value: "any", label: "any" }]} value={draft.match} onValueChange={(match) => match && change((d) => ({ ...d, match }))}>
						<SelectTrigger size="sm" aria-label="Match">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">all</SelectItem>
							<SelectItem value="any">any</SelectItem>
						</SelectContent>
					</Select>
					of these
				</FieldLegend>
				{draft.conditions.map((c, i) => {
					const ops = isFlag(c.field) ? YES_NO : opItems(c.field);
					const opValue = isFlag(c.field) ? (c.not ? "no" : "yes") : `${c.not ? "not " : ""}${c.op}`;
					return (
						// Rows have no ids to key by; one removed from the middle remounts the ones after it, which is fine.
						<div key={i} className="flex items-start gap-2">
							{/* On phones the field and comparison share a line, and what to look for takes the next. */}
							<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
								<Select
									items={FIELDS}
									value={c.field}
									onValueChange={(field) => field && setCondition(i, { field, op: field !== "header" && c.op === "exists" ? "contains" : c.op })}
								>
									<SelectTrigger aria-label={`Condition ${i + 1}`} className="w-44 max-sm:min-w-0 max-sm:flex-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{FIELDS.map((f) => (
											<SelectItem key={f.value} value={f.value}>
												{f.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{c.field === "header" ? (
									<Input
										aria-label="Header name"
										placeholder="X-Priority"
										maxLength={100}
										value={c.name}
										onChange={(e) => setCondition(i, { name: e.target.value })}
										aria-invalid={bad(`conditions.${i}.name`)}
										className="w-32 max-sm:basis-full"
									/>
								) : null}
								<Select
									items={ops}
									value={opValue}
									onValueChange={(value) => {
										if (value === null) return;
										if (isFlag(c.field)) return setCondition(i, { not: value === "no" });
										const not = value.startsWith("not ");
										setCondition(i, { not, op: (not ? value.slice(4) : value) as ConditionDraft["op"] });
									}}
								>
									<SelectTrigger aria-label={`Condition ${i + 1} comparison`} className="w-40 max-sm:min-w-0 max-sm:flex-1">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ops.map((o) => (
											<SelectItem key={o.value} value={o.value}>
												{o.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{isFlag(c.field) || c.op === "exists" ? null : (
									<Input
										aria-label={`Condition ${i + 1} text`}
										maxLength={200}
										value={c.value}
										onChange={(e) => setCondition(i, { value: e.target.value })}
										aria-invalid={bad(`conditions.${i}.value`)}
										className="min-w-32 flex-1 max-sm:basis-full"
									/>
								)}
							</div>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="mt-0.5"
								aria-label={`Remove condition ${i + 1}`}
								onClick={() => change((d) => ({ ...d, conditions: d.conditions.filter((_, j) => j !== i) }))}
							>
								<XIcon />
							</Button>
						</div>
					);
				})}
				<div>
					<Button type="button" variant="ghost" size="sm" disabled={draft.conditions.length >= 20} onClick={() => change((d) => ({ ...d, conditions: [...d.conditions, NEW_CONDITION] }))}>
						<PlusIcon data-icon="inline-start" />
						Add condition
					</Button>
				</div>
			</FieldSet>

			<Field data-invalid={bad("ai")}>
				<FieldLabel htmlFor={`${id}-ai`}>
					AI condition <span className="font-normal text-muted-foreground">(optional)</span>
				</FieldLabel>
				<Textarea
					id={`${id}-ai`}
					maxLength={500}
					placeholder="It's a job offer or a recruiter reaching out"
					value={draft.ai}
					onChange={(e) => change((d) => ({ ...d, ai: e.target.value }))}
					aria-invalid={bad("ai")}
				/>
				<FieldDescription>Checked by AI on new mail whose other conditions match. Not used for mail going to Spam.</FieldDescription>
			</Field>

			<FieldSet className="gap-2">
				<FieldLegend variant="label" className="mb-1">
					Then
				</FieldLegend>
				{draft.actions.map((a, i) => (
					// Keyed by place, as conditions are.
					<div key={i} className="flex items-start gap-2">
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
							<Select
								items={ACTIONS}
								value={a.do}
								onValueChange={(kind) => kind && setAction(i, kind === "label" ? { do: "label", label: a.do === "label" ? a.label : (labels[0]?.key ?? "") } : { do: kind })}
							>
								<SelectTrigger aria-label={`Action ${i + 1}`} className="w-44 max-sm:min-w-0 max-sm:flex-1">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ACTIONS.map((o) => (
										<SelectItem key={o.value} value={o.value}>
											{o.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{a.do === "label" ? (
								// The mailbox's own labels, by value: picking one here changes no mail, unlike LabelPicker.
								<Select items={labelItems} value={a.label || null} onValueChange={(label) => label && setAction(i, { do: "label", label })}>
									<SelectTrigger aria-label={`Action ${i + 1} label`} aria-invalid={bad(`actions.${i}.label`)} className="min-w-40 flex-1 max-sm:min-w-0">
										<SelectValue placeholder={labels.length === 0 ? "No labels yet" : "Pick a label"} />
									</SelectTrigger>
									<SelectContent>
										{labelItems.map((l) => (
											<SelectItem key={l.value} value={l.value}>
												<Swatch color={byKey.get(l.value)?.color ?? null} />
												{l.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : null}
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="mt-0.5"
							aria-label={`Remove action ${i + 1}`}
							disabled={draft.actions.length === 1}
							onClick={() => change((d) => ({ ...d, actions: d.actions.filter((_, j) => j !== i) }))}
						>
							<XIcon />
						</Button>
					</div>
				))}
				<div>
					<Button type="button" variant="ghost" size="sm" disabled={draft.actions.length >= 10} onClick={() => change((d) => ({ ...d, actions: [...d.actions, { do: "star" }] }))}>
						<PlusIcon data-icon="inline-start" />
						Add action
					</Button>
				</div>
				<Field orientation="horizontal">
					<Checkbox id={`${id}-stop`} checked={draft.stop} onCheckedChange={(stop) => change((d) => ({ ...d, stop }))} />
					<FieldLabel htmlFor={`${id}-stop`} className="font-normal">
						Stop processing later rules
					</FieldLabel>
				</Field>
			</FieldSet>

			<section aria-label="Preview" className="flex flex-col gap-2 border-t pt-4">
				<div className="flex items-center gap-2">
					<p className="min-w-0 flex-1 text-muted-foreground">
						{result
							? `${result.matched} of the last ${result.scanned} ${result.scanned === 1 ? "message" : "messages"} ${result.matched === 1 ? "matches" : "match"}`
							: preview.error
								? errorMessage(preview.error)
								: "See which of your recent mail it matches."}
					</p>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={preview.isPending}
						onClick={() => {
							const input = parsed();
							if (input) preview.mutate(input);
						}}
					>
						{preview.isPending ? <Spinner data-icon="inline-start" /> : null}
						Preview
					</Button>
				</div>
				{result && result.threads.length > 0 ? (
					<ul className="border-t">
						{result.threads.slice(0, 5).map((t) => (
							<li key={t.id} className="flex h-9 items-center gap-3 border-b">
								<span className="w-36 shrink-0 truncate font-medium">{t.participants[0]?.name || t.participants[0]?.address}</span>
								<span className="min-w-0 flex-1 truncate">{t.subject || "(No subject)"}</span>
							</li>
						))}
					</ul>
				) : null}
				{result?.aiNotChecked ? <p className="text-xs text-muted-foreground">Only its other conditions were checked: the AI condition is checked on new mail as it arrives.</p> : null}
			</section>

			{invalid ? <FieldError>{invalid.message}</FieldError> : save.error ? <FieldError>{errorMessage(save.error)}</FieldError> : null}
			<DialogFooter>
				<Button type="submit" disabled={save.isPending}>
					{save.isPending ? <Spinner data-icon="inline-start" /> : null}
					{edit ? "Save" : "Create"}
				</Button>
			</DialogFooter>
		</form>
	);
}
