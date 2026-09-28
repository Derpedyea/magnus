import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "../api";
import { ThreadList } from "../components/ThreadList";
import { parseScope } from "../hooks";
import { listQuery } from "../queries";

/** A label (/inbox, /receipts, …) or /search?q=…: the thread list, with the open thread beside it. */
export const Route = createFileRoute("/_app/$view")({
	validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: typeof search.q === "string" ? search.q : undefined }),
	loaderDeps: ({ search }) => ({ scope: parseScope(search.in), q: search.q ?? "" }),
	loader: ({ context, params, deps }) => context.queryClient.ensureQueryData(listQuery(deps.scope, params.view, deps.q)),
	component: () => (
		<>
			<ThreadList />
			<main className="min-w-0 flex-1 overflow-y-auto">
				<Outlet />
			</main>
		</>
	),
	pendingComponent: () => (
		<div className="w-96 shrink-0 border-r p-4 text-muted-foreground">
			<Spinner />
		</div>
	),
	errorComponent: ({ error }) => <p className="w-96 shrink-0 border-r p-4 text-destructive">{errorMessage(error)}</p>,
});
