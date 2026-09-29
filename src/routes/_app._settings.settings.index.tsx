import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/_settings/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/appearance" });
	},
});
