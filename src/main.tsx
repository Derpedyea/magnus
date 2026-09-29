import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ApiError } from "./api";
import { routeTree } from "./routeTree.gen";
import "./index.css";
import "./theme";

// A 401 means the session ended mid-use (expired, or signed out elsewhere). Dropping the account and
// re-running the routes sends you through /_app's guard to sign in, and back here afterwards.
// The guard handles the account query's own 401.
const onUnauthenticated = (error: Error, queryKey?: readonly unknown[]) => {
	if (!(error instanceof ApiError && error.status === 401) || queryKey?.[0] === "me") return;
	queryClient.removeQueries({ queryKey: ["me"] });
	void router.invalidate();
};

const queryClient = new QueryClient({
	queryCache: new QueryCache({ onError: (error, query) => onUnauthenticated(error, query.queryKey) }),
	mutationCache: new MutationCache({ onError: (error) => onUnauthenticated(error) }),
	defaultOptions: {
		// Client errors (401, 403, 404) won't change on retry.
		queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 3 },
	},
});

const router = createRouter({
	routeTree,
	context: { queryClient },
	// Hovering a link runs its loaders, so a thread is usually loaded before the click lands.
	// Freshness is Query's call; the router keeps no cache of its own.
	defaultPreload: "intent",
	defaultPreloadStaleTime: 0,
	// Every param is a plain string: no JSON quoting, and addresses stay readable in the URL bar.
	parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
	stringifySearch: (search) => {
		const params = new URLSearchParams(Object.entries(search).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		const query = params.toString().replaceAll("%40", "@").replaceAll("%2C", ",");
		return query ? `?${query}` : "";
	},
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<Toaster>
					<RouterProvider router={router} />
				</Toaster>
			</TooltipProvider>
		</QueryClientProvider>
	</StrictMode>,
);
