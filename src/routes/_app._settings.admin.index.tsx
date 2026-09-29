import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/_settings/admin/")({
	beforeLoad: () => {
		throw redirect({ to: "/admin/domains" });
	},
});
