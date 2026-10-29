import { FRESH_SIGN_IN_MINUTES, MIN_PASSWORD_LENGTH } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
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
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast-manager";
import { ApiError, authClient, errorMessage } from "../api";
import { SettingsPage } from "../components/SettingsPage";
import { useSignOut } from "../components/SignOutButton";
import { useAccount } from "../hooks";
import { type Passkey, passkeyFailure, passkeys, passkeysSupported, SignInAgain } from "../passkeys";
import { passkeysQuery, passwordQuery } from "../queries";

export const Route = createFileRoute("/_app/_settings/settings/sign-in")({ component: SignIn });

/**
 * Your passkeys, your password, and where codes go when you don't use either. After Google's and GitHub's passkey
 * settings: one row per passkey, named for the password manager that holds it, with when it was added.
 */
function SignIn() {
	const { user } = useAccount();
	const list = useSuspenseQuery(passkeysQuery).data;
	const password = useSuspenseQuery(passwordQuery).data;
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
			<Password changedAt={password ? new Date(password.updatedAt) : null} />
			<p className="text-muted-foreground">
				{list.length || password ? "You can also sign in with a code sent to " : "No passkeys yet. You sign in with a code sent to "}
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

/** Whether you have a password and when it last changed, after Google Account's Security page. */
function Password({ changedAt }: { changedAt: Date | null }) {
	const [editing, setEditing] = useState(false);
	return (
		<div className="flex items-center justify-between gap-4">
			<div>
				<p className="font-medium">Password</p>
				<p className="text-muted-foreground">{changedAt ? `Last changed ${changedAt.toLocaleDateString([], { dateStyle: "medium" })}` : "Not set"}</p>
			</div>
			<Button variant="outline" onClick={() => setEditing(true)}>
				{changedAt ? "Change password" : "Set password"}
			</Button>
			<PasswordDialog open={editing} onOpenChange={setEditing} replacing={changedAt !== null} />
		</div>
	);
}

/** Setting or replacing it needs a recent sign-in, like adding a passkey; a forgotten one is replaced the same way. */
function PasswordDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; replacing: boolean }) {
	const { user } = useAccount();
	const qc = useQueryClient();
	const [password, setPassword] = useState("");
	const save = useMutation({
		mutationFn: () => authClient.$fetch("/save-password", { method: "POST", body: { password } }),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: passwordQuery.queryKey });
			props.onOpenChange(false);
			setPassword("");
			toast.add({ title: "Password saved", type: "success" });
		},
	});
	const signInAgain = useSignOut("/settings/sign-in");
	const stale = save.error instanceof ApiError && save.error.code === "SESSION_NOT_FRESH";

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent>
				<form
					className="flex flex-col gap-6"
					onSubmit={(e) => {
						e.preventDefault();
						save.mutate();
					}}
				>
					<DialogHeader>
						<DialogTitle>{props.replacing ? "Change your password" : "Set a password"}</DialogTitle>
					</DialogHeader>
					<div className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2">
						<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
						<div className="min-w-0 flex-1">
							<p className="font-medium">A passkey is recommended</p>
							<p className="text-xs text-muted-foreground">
								Passwords are less secure: they can be guessed, leaked, or typed into a fake site. A passkey can't be.
							</p>
						</div>
					</div>
					{/* So password managers save it under your sign-in email. */}
					<input type="email" autoComplete="username" value={user.email} readOnly hidden />
					<Field data-invalid={save.error ? true : undefined}>
						<FieldLabel htmlFor="new-password">New password</FieldLabel>
						<Input
							id="new-password"
							type="password"
							required
							autoFocus
							autoComplete="new-password"
							minLength={MIN_PASSWORD_LENGTH}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							aria-invalid={save.error ? true : undefined}
						/>
						{stale ? (
							<p className="flex flex-wrap items-center gap-x-2">
								Setting a password needs a sign-in from the last {FRESH_SIGN_IN_MINUTES} minutes.
								<Button variant="link" className="h-auto p-0 underline" onClick={() => signInAgain.mutate()} disabled={signInAgain.isPending}>
									Sign in again
								</Button>
							</p>
						) : save.error ? (
							<FieldError>{errorMessage(save.error)}</FieldError>
						) : (
							<FieldDescription>At least {MIN_PASSWORD_LENGTH} characters. A few words you'll remember work well.</FieldDescription>
						)}
					</Field>
					<DialogFooter>
						<Button type="submit" disabled={save.isPending}>
							{save.isPending ? <Spinner data-icon="inline-start" /> : null}
							Save password
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
