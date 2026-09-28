import { useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useAccount, useScope } from "../hooks";
import { listQuery } from "../queries";

const route = getRouteApi("/_app/_mail/$view");

export function ThreadList() {
	const { view } = route.useParams();
	const q = route.useSearch({ select: (s) => s.q ?? "" });
	const scope = useScope();
	const account = useAccount();
	const { data } = useSuspenseQuery(listQuery(scope, view, q));
	// Per-row address dots, unless every row would show the same one.
	const colors = account.addresses.length > 1 && scope.length !== 1 ? account.colors : null;

	return (
		<section className="w-96 shrink-0 overflow-y-auto border-r">
			{data.threads.length === 0 ? <p className="p-4 text-muted-foreground">{view === "search" ? "No matches." : "Nothing here."}</p> : null}
			<ul>
				{data.threads.map((t) => {
					const unread = t.unreadCount > 0;
					const people = t.participants.map((p) => p.name || p.address.split("@")[0]).slice(0, 3).join(", ");
					return (
						<li key={`${t.mailboxId}/${t.id}`}>
							<Link
								to="/$view/$mailboxId/$threadId"
								params={{ view, mailboxId: t.mailboxId, threadId: t.id }}
								search={true}
								activeProps={{ className: "bg-accent" }}
								inactiveProps={{ className: "hover:bg-muted/50" }}
								className="block w-full border-b px-4 py-3 text-left outline-none focus-visible:bg-accent"
							>
								<div className="flex items-baseline gap-2">
									<span className={`truncate ${unread ? "font-semibold" : "text-foreground/80"}`}>{people}</span>
									{t.messageCount > 1 ? <span className="text-xs text-muted-foreground">{t.messageCount}</span> : null}
									<span className="ml-auto flex shrink-0 items-center gap-2">
										{colors ? t.addresses.map((a) => <span key={a} title={a} className={`size-2 rounded-full ${colors.get(a) ?? "bg-muted-foreground"}`} />) : null}
										<time className="text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
									</span>
								</div>
								<div className={`truncate ${unread ? "font-semibold" : ""}`}>{t.subject}</div>
								<div className="truncate text-muted-foreground">{t.snippet}</div>
							</Link>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

function formatDate(ms: number): string {
	const d = new Date(ms);
	const now = new Date();
	if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
	return d.toLocaleDateString();
}
