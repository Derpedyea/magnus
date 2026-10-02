import { createFileRoute } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "../api";
import { BackToList, ThreadView } from "../components/ThreadView";
import { threadQuery } from "../queries";

export const Route = createFileRoute("/_app/_mail/$view/$mailboxId/$threadId")({
	loader: ({ context, params }) => context.queryClient.ensureQueryData(threadQuery(params.mailboxId, params.threadId)),
	// Another thread starts fresh: messages re-collapse and the remote-images prompt resets.
	remountDeps: ({ params }) => params,
	component: ThreadView,
	// Where the thread covers the list, these do too, so they keep the way back.
	pendingComponent: () => (
		<div className="p-2 text-muted-foreground lg:p-6">
			<BackToList />
			<Spinner className="m-4 lg:m-0" />
		</div>
	),
	errorComponent: ({ error }) => (
		<div className="p-2 lg:p-6">
			<BackToList />
			<p className="m-4 text-destructive lg:m-0">{errorMessage(error)}</p>
		</div>
	),
});
