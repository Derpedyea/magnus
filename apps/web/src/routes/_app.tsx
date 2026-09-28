import { createFileRoute, redirect, retainSearchParams } from "@tanstack/react-router";
import { ApiError, errorMessage } from "../api";
import { App } from "../App";
import { Spinner } from "@/components/ui/spinner";
import { Centered } from "../components/Centered";
import { SignOutButton } from "../components/SignOutButton";
import { meQuery } from "../queries";

/** Everything behind sign-in. Its guard runs before any child loads, so nothing fetches mail while signed out. */
export const Route = createFileRoute("/_app")({
	// ?in=a@x.com,b@y.com narrows every view to some of the user's addresses, and sticks as you move around.
	validateSearch: (search: Record<string, unknown>): { in?: string } => ({ in: typeof search.in === "string" ? search.in : undefined }),
	search: { middlewares: [retainSearchParams(["in"])] },
	beforeLoad: async ({ context, location }) => {
		try {
			await context.queryClient.ensureQueryData(meQuery);
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) throw redirect({ to: "/login", search: { redirect: location.href } });
			throw error;
		}
	},
	component: App,
	pendingComponent: () => (
		<Centered>
			<Spinner />
		</Centered>
	),
	// Signed in, but not as anyone in the directory: offer a way to switch accounts.
	errorComponent: ({ error }) => (
		<Centered>
			<div className="flex flex-col items-center gap-3">
				<p>Couldn't load your account: {errorMessage(error)}</p>
				<SignOutButton />
			</div>
		</Centered>
	),
});
