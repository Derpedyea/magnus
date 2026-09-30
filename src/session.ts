import type { QueryClient } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast-manager";
import { closeDraft } from "./compose";
import { configQuery } from "./queries";

/**
 * Forgets everything the signed-in account left in this tab: its cached mail, the open draft, and sends still
 * waiting to go (their Undo reopens the draft). The next sign-in happens without a page load, so whoever it is
 * would otherwise see it.
 */
export function endSession(qc: QueryClient) {
	// All but the install's config, which isn't the account's. Refetching it would hold up the way to the sign-in
	// page, long enough for the app, its account gone, to flash an error.
	qc.removeQueries({ predicate: (q) => q.queryKey[0] !== configQuery.queryKey[0] });
	qc.getMutationCache().clear();
	closeDraft();
	toast.close();
}
