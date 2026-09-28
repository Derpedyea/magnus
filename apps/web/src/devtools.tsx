import { TanStackDevtools } from "@tanstack/react-devtools";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

/** Dev builds only (lazy-loaded from App). Hover the right edge to open. */
export default function Devtools() {
	return (
		<TanStackDevtools
			config={{ triggerMode: "fixed", position: "middle-right", hideUntilHover: true }}
			plugins={[
				{ name: "Query", render: <ReactQueryDevtoolsPanel /> },
				{ name: "Router", render: <TanStackRouterDevtoolsPanel /> },
			]}
		/>
	);
}
