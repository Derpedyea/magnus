import { useSelector } from "@tanstack/react-store";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { closeDraft, compose, openDraft, withSignature } from "./compose";
import { AccountMenu } from "./components/AccountMenu";
import { Centered } from "./components/Centered";
import { Sidebar } from "./components/Sidebar";
import { useAccount, useLive, useScope } from "./hooks";

const Devtools = import.meta.env.DEV ? lazy(() => import("./devtools")) : () => null;

// The composer brings the editor, the app's largest dependency, so it loads after the mail rather than before.
const loadComposer = () => import("./components/Composer");
const Composer = lazy(() => loadComposer().then((m) => ({ default: m.Composer })));

/** The signed-in layout: sidebar and header around the current view, plus the composer floating above it. */
export function App() {
	const { user, mailboxes, addresses, colors, identities } = useAccount();
	const scope = useScope();
	const navigate = useNavigate();
	const q = useSearch({ strict: false, select: (s) => s.q });
	const [search, setSearch] = useState(q ?? "");
	const draft = useSelector(compose, (s) => s);
	const live = useLive(mailboxes.map((m) => m.id));
	const status = live ? "Live updates connected" : "Reconnecting…";
	// Fetched now, so it opens at once.
	useEffect(() => void loadComposer(), []);

	const [firstMailbox] = mailboxes;
	if (!firstMailbox) return <Centered>No mailboxes are assigned to {user.email} yet.</Centered>;

	const newDraft = () => {
		const selected = new Set(scope);
		const from = identities.find((i) => selected.has(i.address)) ?? identities[0];
		openDraft({
			mailboxId: from?.mailboxId ?? firstMailbox.id,
			from: from?.address ?? "",
			to: [],
			cc: [],
			bcc: [],
			subject: "",
			text: withSignature("", null, from?.signature ?? null),
			attachments: [],
		});
	};

	return (
		// The sidebar saves its open state in this cookie; read it back so a collapsed rail stays collapsed.
		<SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")} className="h-full text-sm">
			<Sidebar mailboxes={mailboxes} addresses={addresses} colors={colors} isAdmin={user.isAdmin} onCompose={newDraft} />
			<SidebarInset className="min-w-0">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
					<SidebarTrigger />
					<form
						className="max-w-xl flex-1"
						onSubmit={(e) => {
							e.preventDefault();
							const query = search.trim();
							void navigate({ to: "/$view", params: { view: query ? "search" : "inbox" }, search: { q: query || undefined } });
						}}
					>
						<InputGroup>
							<InputGroupAddon>
								<SearchIcon />
							</InputGroupAddon>
							<InputGroupInput type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search mail" />
						</InputGroup>
					</form>
					<div className="ml-auto flex items-center gap-3 text-muted-foreground">
						<Tooltip>
							<TooltipTrigger render={<span role="img" aria-label={status} className={`size-2 rounded-full ${live ? "bg-emerald-500" : "bg-amber-400"}`} />} />
							<TooltipContent>{status}</TooltipContent>
						</Tooltip>
						<AccountMenu />
					</div>
				</header>
				<div className="flex min-h-0 flex-1">
					<Outlet />
				</div>
			</SidebarInset>

			<Suspense>{draft ? <Composer identities={identities} initial={draft} onClose={closeDraft} /> : null}</Suspense>

			<Suspense>
				<Devtools />
			</Suspense>
		</SidebarProvider>
	);
}
