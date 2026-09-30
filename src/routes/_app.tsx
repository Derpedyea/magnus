import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, errorMessage } from "../api";
import { Centered } from "../components/Centered";
import { SignOutButton } from "../components/SignOutButton";
import { configQuery, meQuery } from "../queries";
import { endSession } from "../session";

/** Everything behind sign-in. Its guard runs before any child loads, so nothing fetches mail while signed out. */
export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ context, location }) => {
		if ((await context.queryClient.ensureQueryData(configQuery)).setupRequired) throw redirect({ to: "/setup" });
		try {
			await context.queryClient.ensureQueryData(meQuery);
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				// A session that ends mid-use lands here too (see main.tsx), with its mail still in memory.
				endSession(context.queryClient);
				throw redirect({ to: "/login", search: { redirect: location.href } });
			}
			throw error;
		}
	},
	component: Outlet,
	pendingComponent: () => (
		<Centered>
			<Spinner />
		</Centered>
	),
	// Signed in, but the account couldn't load: offer a way to switch accounts.
	errorComponent: ({ error }) => (
		<Centered>
			<div className="flex flex-col items-center gap-3">
				<p>Couldn't load your account: {errorMessage(error)}</p>
				<SignOutButton />
			</div>
		</Centered>
	),
});
