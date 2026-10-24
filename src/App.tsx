import { useSelector } from "@tanstack/react-store";
import { Outlet, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { SearchIcon, SparklesIcon, SquarePenIcon } from "lucide-react";
import { useAppHotkeys, useHotkey, useHotkeys } from "@tanstack/react-hotkeys";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { agentOpen, toggleAgent } from "./agent";
import type { Identity } from "./api";
import { compose, openDraft, withSignature } from "./compose";
import { AccountMenu } from "./components/AccountMenu";
import { AgentPanel } from "./components/AgentPanel";
import { Centered } from "./components/Centered";
import { Shortcut } from "./components/Shortcut";
import { Sidebar } from "./components/Sidebar";
import { useAccount, useLive, useScope, useUnreadTitle } from "./hooks";

const Devtools = import.meta.env.DEV ? lazy(() => import("./devtools")) : () => null;

// The composer brings the editor, the app's largest dependency, so it loads after the mail rather than before.
const loadComposer = () => import("./components/Composer");
const Composer = lazy(() => loadComposer().then((m) => ({ default: m.Composer })));

/** G then a letter, after Gmail's. */
const GO_TO = [
	["go.inbox", "inbox"],
	["go.starred", "starred"],
	["go.drafts", "drafts"],
	["go.sent", "sent"],
	["go.all", "all"],
] as const;

/** The signed-in layout: sidebar and header around the current view, plus the composer floating above it. */
export function App() {
	const { user, mailboxes, addresses, colors, identities } = useAccount();
	const scope = useScope();
	const navigate = useNavigate();
	const q = useSearch({ strict: false, select: (s) => s.q });
	const [search, setSearch] = useState(q ?? "");
	// Below lg, an open thread covers the header and list (routes/_app._mail.$view.tsx).
	const threadOpen = useParams({ strict: false, select: (p) => p.threadId !== undefined });
	const live = useLive(mailboxes.map((m) => m.id));
	const status = live ? "Live updates connected" : "Reconnecting…";
	useUnreadTitle(scope);
	// Fetched now, so it opens at once.
	useEffect(() => void loadComposer(), []);

	const hotkeys = useAppHotkeys();
	const searchInput = useRef<HTMLInputElement>(null);
	useHotkey(hotkeys["search.focus"], () => searchInput.current?.select());
	useHotkeys(
		GO_TO.map(([id, view]) => ({ hotkey: hotkeys[id], callback: () => void navigate({ to: "/$view", params: { view }, search: (prev) => ({ in: prev.in }) }) })),
	);
	// Below the early return, so hooks stay in order; does nothing until there's a mailbox to write from.
	useHotkey(hotkeys["compose.new"], () => newDraft?.());
	useHotkey(hotkeys["agent.toggle"], () => toggleAgent());
	const agent = useSelector(agentOpen, (s) => s);

	const [firstMailbox] = mailboxes;
	const newDraft = firstMailbox && (() => {
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
	});
	if (!newDraft) return <Centered>No mailboxes are assigned to {user.email} yet.</Centered>;

	return (
		// The sidebar saves its open state in this cookie; read it back so a collapsed rail stays collapsed.
		<SidebarProvider defaultOpen={!document.cookie.includes("sidebar_state=false")} className="h-full text-sm">
			<Sidebar mailboxes={mailboxes} addresses={addresses} colors={colors} isAdmin={user.isAdmin} onCompose={newDraft} />
			<SidebarInset className="min-w-0">
				<header className={cn("flex h-12 shrink-0 items-center gap-2 border-b px-3", threadOpen && "max-lg:invisible")}>
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
							<InputGroupInput ref={searchInput} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search mail" />
							{search ? null : (
								<InputGroupAddon align="inline-end" className="max-md:hidden">
									<Shortcut hotkey={hotkeys["search.focus"]} />
								</InputGroupAddon>
							)}
						</InputGroup>
					</form>
					<div className="ml-auto flex items-center gap-3 text-muted-foreground">
						<Tooltip>
							<TooltipTrigger render={<span role="img" aria-label={status} className={`size-2 rounded-full ${live ? "bg-emerald-500" : "bg-amber-400"}`} />} />
							<TooltipContent>{status}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Assistant" aria-pressed={agent} onClick={() => toggleAgent()} className={cn(agent && "bg-muted text-foreground")} />}>
								<SparklesIcon />
							</TooltipTrigger>
							<TooltipContent>
								Assistant <Shortcut hotkey={hotkeys["agent.toggle"]} />
							</TooltipContent>
						</Tooltip>
						<AccountMenu />
					</div>
				</header>
				<div className="flex min-h-0 flex-1">
					<Outlet />
				</div>
			</SidebarInset>
			{/* Beside the inset rather than in a sidebar of its own: a second SidebarProvider would take Mod+B and its cookie too. */}
			<AgentPanel />

			{/* Phones keep the sidebar in a drawer, so Compose floats over the list instead, like Gmail's. */}
			{threadOpen ? null : (
				<Button onClick={newDraft} className="fixed right-4 bottom-4 z-10 h-14 gap-2 rounded-2xl px-5 text-base shadow-lg md:hidden">
					<SquarePenIcon className="size-5" />
					Compose
				</Button>
			)}

			<OpenDraft identities={identities} />

			<Suspense>
				<Devtools />
			</Suspense>
		</SidebarProvider>
	);
}

/**
 * The open draft. Only this follows the compose store, so opening or closing one leaves the layout be: a session that
 * ends mid-use closes the draft while the account is already gone, and App, re-rendered then, would suspend on it.
 */
function OpenDraft(props: { identities: Identity[] }) {
	const open = useSelector(compose, (s) => s);
	// Keyed by opening: the composer's form only reads its draft when it mounts.
	return (
		<Suspense>
			{open ? <Composer key={open.id} id={open.id} draftId={open.draftId} saved={open.saved} identities={props.identities} initial={open.draft} restored={open.restored} /> : null}
		</Suspense>
	);
}
