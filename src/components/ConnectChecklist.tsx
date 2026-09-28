import { STEP_IDS, STEP_LABELS, type StepId } from "#shared";
import { CheckIcon, CircleIcon, ClockIcon, XIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { StepState } from "../connect";

/** The steps that turn a domain on, and how far each got (useDomainConnect). */
export function ConnectChecklist(props: { steps: Partial<Record<StepId, StepState>> }) {
	return (
		<ol className="flex flex-col gap-2.5">
			{STEP_IDS.map((id) => (
				<StepRow key={id} label={STEP_LABELS[id]} status={props.steps[id]} />
			))}
		</ol>
	);
}

function StepRow(props: { label: string; status: StepState | undefined }) {
	const state = props.status?.state;
	const detail = props.status && "detail" in props.status ? props.status.detail : undefined;
	return (
		<li className="flex gap-2.5">
			<span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
				{state === "running" ? (
					<Spinner className="size-3.5 text-muted-foreground" />
				) : state === "done" ? (
					<CheckIcon className="size-4 text-emerald-600" aria-label="Done" />
				) : state === "pending" ? (
					<ClockIcon className="size-3.5 text-amber-600" aria-label="Waiting" />
				) : state === "failed" ? (
					<XIcon className="size-4 text-destructive" aria-label="Failed" />
				) : (
					<CircleIcon className="size-3 text-muted-foreground/50" aria-label="Not started" />
				)}
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className={state === undefined ? "text-muted-foreground" : undefined}>{props.label}</span>
				{detail ? <span className={state === "failed" ? "text-destructive" : "text-muted-foreground"}>{detail}</span> : null}
			</div>
		</li>
	);
}
