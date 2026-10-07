import type { QueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast-manager";
import { closeDraft } from "./compose";
import { forgetDevice } from "./push";
import { configQuery } from "./queries";

let session = 0;
const sessionEnd = new Set<() => void>();
export function onSessionEnd(stop: () => void) {
	sessionEnd.add(stop);
	return () => { sessionEnd.delete(stop); };
}
/**
 * Which session this tab is on. A send or Undo still in flight when one ends answers later, maybe once someone
 * else has signed in, so what it would show (its draft, its Undo) checks this first.
 */
export const currentSession = () => session;

/**
 * Forgets everything the signed-in account left in this tab: its cached mail, the open draft, sends still waiting to
 * go (their Undo reopens the draft), and its notifications. The next sign-in happens without a page load, so whoever
 * it is would otherwise see it.
 */
export function endSession(qc: QueryClient) {
	session++;
	for (const stop of sessionEnd) stop();
	// All but the install's config, which isn't the account's. Refetching it would hold up the way to the sign-in
	// page, long enough for the app, its account gone, to flash an error.
	qc.removeQueries({ predicate: (q) => q.queryKey[0] !== configQuery.queryKey[0] });
	qc.getMutationCache().clear();
	closeDraft();
	toast.close();
	// The server stopped this session's notifications with it (worker/push-api.ts); this stops any already on their way.
	forgetDevice().catch((error: unknown) => console.error("Couldn't drop this browser's push subscription", error));
}
