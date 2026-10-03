import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "../api";
import { endSession } from "../session";
import { useOptionalDraftSync } from "../drafts";
import { toast } from "@/components/ui/toast-manager";
import { errorMessage } from "../api";

export function useSignOut() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const drafts = useOptionalDraftSync();
	return useMutation({
		mutationFn: async () => { await drafts?.flushAll(); return authClient.signOut(); },
		onError: (error) => toast.add({ title: `Couldn't sign out: ${errorMessage(error)}`, type: "error", timeout: 0 }),
		onSuccess: () => {
			endSession(qc);
			void navigate({ to: "/login" });
		},
	});
}

export function SignOutButton() {
	const signOut = useSignOut();
	return (
		<Button variant="ghost" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending} className="text-muted-foreground">
			Sign out
		</Button>
	);
}
