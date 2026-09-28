import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { authClient } from "../api";

export function SignOutButton() {
	const qc = useQueryClient();
	const navigate = useNavigate();
	const signOut = useMutation({
		mutationFn: () => authClient.signOut(),
		onSuccess: () => {
			// Nothing of this account's mail should outlive the session.
			qc.clear();
			void navigate({ to: "/login" });
		},
	});
	return (
		<Button variant="ghost" size="sm" onClick={() => signOut.mutate()} disabled={signOut.isPending} className="text-muted-foreground">
			Sign out
		</Button>
	);
}
