import { parseScope } from "#shared";
import { createFileRoute, Outlet, useMatch } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { errorMessage } from "../api";
import { ThreadList } from "../components/ThreadList";
import { listQuery } from "../queries";
import { DraftList } from "../components/DraftList";
import { Centered } from "../components/Centered";

/** A label (/inbox, /receipts, …) or /search?q=…: the thread list, with the open thread beside it. */
export const Route = createFileRoute("/_app/_mail/$view")({
	validateSearch: (search: Record<string, unknown>): { q?: string } => ({ q: typeof search.q === "string" ? search.q : undefined }),
	loaderDeps: ({ search }) => ({ scope: parseScope(search.in), q: search.q ?? "" }),
	loader: ({ context, params, deps }) => params.view === "drafts" ? undefined : context.queryClient.ensureInfiniteQueryData(listQuery(deps.scope, params.view, deps.q)),
	component: MailView,
	pendingComponent: () => (
		<div className="w-full p-4 text-muted-foreground lg:w-96 lg:shrink-0 lg:border-r">
			<Spinner />
		</div>
	),
	errorComponent: ({ error }) => <p className="w-full p-4 text-destructive lg:w-96 lg:shrink-0 lg:border-r">{errorMessage(error)}</p>,
});

/**
 * Below lg there's room for one pane, so the list and the open thread take turns, like a phone's stack of screens:
 * the thread covers the header and list, which stay laid out underneath (invisible, see App and ThreadList), so going
 * back finds the list scrolled where it was.
 */
function MailView() {
	const threadOpen = Boolean(useMatch({ from: "/_app/_mail/$view/$mailboxId/$threadId", shouldThrow: false }));
	const { view } = Route.useParams();
	const { scope } = Route.useLoaderDeps();
	if (view === "drafts") return <><DraftList scope={scope} /><main className="hidden min-w-0 flex-1 md:block"><Centered>Select a draft to continue</Centered></main></>;
	return (
		<>
			<ThreadList threadOpen={threadOpen} />
			<main
				className={cn(
					"min-w-0 flex-1 overflow-y-auto",
					threadOpen ? "max-lg:absolute max-lg:inset-0 max-lg:z-20 max-lg:bg-background motion-safe:max-lg:animate-in motion-safe:max-lg:fade-in motion-safe:max-lg:slide-in-from-right-8" : "max-lg:hidden",
				)}
			>
				<Outlet />
			</main>
		</>
	);
}
