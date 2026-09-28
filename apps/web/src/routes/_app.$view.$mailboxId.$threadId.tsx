import { createFileRoute } from "@tanstack/react-router";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "../api";
import { ThreadView } from "../components/ThreadView";
import { threadQuery } from "../queries";

export const Route = createFileRoute("/_app/$view/$mailboxId/$threadId")({
	loader: ({ context, params }) => context.queryClient.ensureQueryData(threadQuery(params.mailboxId, params.threadId)),
	// Another thread starts fresh: messages re-collapse and the remote-images prompt resets.
	remountDeps: ({ params }) => params,
	component: ThreadView,
	pendingComponent: () => (
		<div className="p-6 text-muted-foreground">
			<Spinner />
		</div>
	),
	errorComponent: ({ error }) => <p className="p-6 text-destructive">{errorMessage(error)}</p>,
});
