import { parseScope } from "#shared";
import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api";
import { ThreadList } from "../components/ThreadList";
import { listQuery } from "../queries";

/** A label (/inbox, /receipts, …) or /search?q=…: the thread list, with the open thread beside it. */
export const Route = createFileRoute("/_app/_mail/$view")({
	validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: typeof search.q === "string" ? search.q : undefined }),
	loaderDeps: ({ search }) => ({ scope: parseScope(search.in), q: search.q ?? "" }),
	loader: ({ context, params, deps }) => context.queryClient.ensureInfiniteQueryData(listQuery(deps.scope, params.view, deps.q)),
	component: MailView,
	pendingComponent: () => (
		<div className="w-96 shrink-0 border-r p-4 text-muted-foreground">
			<Spinner />
		</div>
	),
	errorComponent: ({ error }) => <p className="w-96 shrink-0 border-r p-4 text-destructive">{errorMessage(error)}</p>,
});

/** On narrow screens the list and conversation take turns, keeping Trash actions reachable. */
function MailView() {
	const threadOpen = Boolean(useMatch({ from: "/_app/_mail/$view/$mailboxId/$threadId", shouldThrow: false }));
	return (
		<>
			<ThreadList threadOpen={threadOpen} />
			<main className={cn("min-w-0 flex-1 overflow-y-auto lg:block", !threadOpen && "hidden")}>
				<Outlet />
			</main>
		</>
	);
}
