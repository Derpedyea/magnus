import { STEP_IDS, type StepId, type StepStatus } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { adminApi } from "./api";

export type StepState = StepStatus | { state: "running" };

/**
 * Turns a domain on in Cloudflare one step at a time, keeping each step's state for ConnectChecklist. Steps are
 * safe to repeat, so running again is also how you check again. A failure stops the run; waiting on DNS doesn't.
 */
export function useDomainConnect() {
	const qc = useQueryClient();
	const [steps, setSteps] = useState<Partial<Record<StepId, StepState>>>({});
	const run = useMutation({
		mutationFn: async (target: { token: string; domain: string; moveMail: boolean }) => {
			setSteps({});
			for (const step of STEP_IDS) {
				setSteps((prev) => ({ ...prev, [step]: { state: "running" } }));
				const result = await adminApi
					.runStep(target.token, target.domain, step, target.moveMail)
					.catch((error: unknown): StepStatus => ({ state: "failed", detail: error instanceof Error ? error.message : String(error) }));
				setSteps((prev) => ({ ...prev, [step]: result }));
				if (result.state === "failed") return;
			}
		},
		// Whether the domain can receive and send just changed, and with it which addresses can send.
		onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["admin"] }), qc.invalidateQueries({ queryKey: ["me"] })]),
	});
	return {
		steps,
		run: run.mutate,
		running: run.isPending,
		/** Every step ran and none is left to do. */
		done: STEP_IDS.every((id) => steps[id]?.state === "done"),
		started: Object.keys(steps).length > 0,
	};
}
