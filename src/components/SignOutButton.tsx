import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "../api";
import { endSession } from "../session";

export function useSignOut() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	return useMutation({
		mutationFn: () => authClient.signOut(),
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
