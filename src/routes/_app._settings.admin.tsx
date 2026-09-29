import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { directoryQuery, meQuery } from "../queries";

/** Domains, people, addresses, and blocked senders. Admins only; everyone else is sent back to their mail. */
export const Route = createFileRoute("/_app/_settings/admin")({
	beforeLoad: async ({ context }) => {
		if (!(await context.queryClient.ensureQueryData(meQuery)).user.isAdmin) throw redirect({ to: "/" });
	},
	loader: ({ context }) => context.queryClient.ensureQueryData(directoryQuery),
	component: Outlet,
});
