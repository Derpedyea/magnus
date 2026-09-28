import { createFileRoute, retainSearchParams } from "@tanstack/react-router";
import { App } from "../App";

/** The mail app: sidebar and header around the current view. */
export const Route = createFileRoute("/_app/_mail")({
	// ?in=a@x.com,b@y.com narrows every view to some of the user's addresses, and sticks as you move around.
	validateSearch: (search: Record<string, unknown>): { in?: string } => ({ in: typeof search.in === "string" ? search.in : undefined }),
	search: { middlewares: [retainSearchParams(["in"])] },
	component: App,
});
