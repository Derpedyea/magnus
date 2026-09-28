import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/_mail/")({
	beforeLoad: () => {
		throw redirect({ to: "/$view", params: { view: "inbox" } });
	},
});
