import { FRESH_SIGN_IN_MINUTES } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
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
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { useSignOut } from "../components/SignOutButton";
import { useAccount } from "../hooks";
import { type Passkey, passkeyFailure, passkeys, passkeysSupported, SignInAgain } from "../passkeys";
import { passkeysQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/settings/sign-in")({ component: SignIn });

/**
 * Your passkeys, and where codes go when you don't use one. After Google's and GitHub's passkey settings: one row
 * per passkey, named for the password manager that holds it, with when it was added.
 */
function SignIn() {
	const { user } = useAccount();
	const list = useSuspenseQuery(passkeysQuery).data;
	const qc = useQueryClient();
	const add = useMutation({ mutationFn: passkeys.add, onSuccess: () => qc.invalidateQueries({ queryKey: passkeysQuery.queryKey }) });
	// Signing back in comes straight back here, now recent enough to add one.
	const signInAgain = useSignOut("/settings/sign-in");

	return (
		<SettingsPage
			title="Sign-in"
			action={
				passkeysSupported ? (
					<Button onClick={() => add.mutate()} disabled={add.isPending}>
						{add.isPending ? <Spinner data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
						Add passkey
					</Button>
				) : null
			}
		>
			{add.error instanceof SignInAgain ? (
				<p className="flex flex-wrap items-center gap-x-2">
					Adding a passkey needs a sign-in from the last {FRESH_SIGN_IN_MINUTES} minutes.
					<Button variant="link" className="h-auto p-0 underline" onClick={() => signInAgain.mutate()} disabled={signInAgain.isPending}>
						Sign in again
					</Button>
				</p>
			) : passkeyFailure(add.error) ? (
				<FieldError>{passkeyFailure(add.error)}</FieldError>
			) : null}
			{list.length ? (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Passkey</TableHead>
							<TableHead>Added</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{list.map((p) => (
							<PasskeyRow key={p.id} passkey={p} />
						))}
					</TableBody>
				</Table>
			) : null}
			<p className="text-muted-foreground">
				{list.length ? "You can also sign in with a code sent to " : "No passkeys yet. You sign in with a code sent to "}
				<span className="font-medium text-foreground">{user.email}</span>.
			</p>
		</SettingsPage>
	);
}

function PasskeyRow({ passkey }: { passkey: Passkey }) {
	const qc = useQueryClient();
	const [removing, setRemoving] = useState(false);
	const remove = useMutation({
		mutationFn: () => passkeys.remove(passkey.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: passkeysQuery.queryKey }),
	});
	// Named for its password manager when added (see worker/auth.ts); Apple's don't say which.
	const label = passkey.name || "Passkey";

	return (
		<TableRow>
			<TableCell>
				<span className="flex items-center gap-2 font-medium">
					<KeyRoundIcon className="size-4 text-muted-foreground" />
					{label}
					{/* Kept in a password manager that syncs, so losing one device doesn't lose it. */}
					{passkey.backedUp ? <Badge variant="secondary">Synced</Badge> : null}
				</span>
			</TableCell>
			<TableCell className="text-muted-foreground">{new Date(passkey.createdAt).toLocaleDateString([], { dateStyle: "medium" })}</TableCell>
			<TableCell>
				<Button variant="ghost" size="sm" onClick={() => setRemoving(true)}>
					Remove
				</Button>
				<AlertDialog open={removing} onOpenChange={setRemoving}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{passkey.name ? `Remove ${passkey.name}?` : "Remove this passkey?"}</AlertDialogTitle>
							<AlertDialogDescription>
								It stops signing you in to Magnus Mail. Your password manager keeps offering it until you delete it there too.
							</AlertDialogDescription>
						</AlertDialogHeader>
						{remove.error ? <FieldError>{errorMessage(remove.error)}</FieldError> : null}
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
								Remove
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</TableCell>
		</TableRow>
	);
}
