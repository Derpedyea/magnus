import { STEP_IDS, type StepId, type StepStatus } from "#shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { adminApi } from "./api";

export type StepState = StepStatus | { state: "running" };

/** Steps for mail arriving here, which wait while the domain's mail still goes elsewhere. */
const RECEIVING = new Set<StepId>(["catch-all", "mta-sts"]);

/**
 * Turns a domain on in Cloudflare one step at a time, keeping each step's state for ConnectChecklist. Steps are
 * safe to repeat, so running again is also how you check again. A failure stops the run; waiting on DNS doesn't.
 * Nor does mail that still goes elsewhere: sending turns on, and receiving waits until the admin moves it.
 */
export function useDomainConnect() {
	const qc = useQueryClient();
	const [steps, setSteps] = useState<Partial<Record<StepId, StepState>>>({});
	const run = useMutation({
		mutationFn: async (target: { domain: string; moveMail: boolean }) => {
			setSteps({});
			let elsewhere = false;
			for (const step of STEP_IDS) {
				if (elsewhere && RECEIVING.has(step)) continue;
				setSteps((prev) => ({ ...prev, [step]: { state: "running" } }));
				const result = await adminApi
					.runStep(target.domain, step, target.moveMail)
					.catch((error: unknown): StepStatus => ({ state: "failed", detail: error instanceof Error ? error.message : String(error) }));
				setSteps((prev) => ({ ...prev, [step]: result }));
				if (result.state === "failed") return;
				if (result.needsMoveMail) elsewhere = true;
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
