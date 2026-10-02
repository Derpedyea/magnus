import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { SettingsIcon, ShieldIcon, SquarePenIcon, TagIcon, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuBadge,
	SidebarMenuButton,
	SidebarMenuItem,
	Sidebar as SidebarRoot,
	SidebarSeparator,
	useSidebar,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatScope, type Me, parseScope } from "#shared";
import { useScope } from "../hooks";
import { countsQuery } from "../queries";
import { SYSTEM, SYSTEM_VIEWS } from "../views";
import { useDraftList } from "./DraftList";

export function Sidebar(props: {
	mailboxes: Me["mailboxes"];
	/** Every address, in sidebar order: index + 1 is its digit shortcut. */
	addresses: string[];
	/** Dot colour class per address, shared with the thread list. */
	colors: ReadonlyMap<string, string>;
	/** Shows the way to the admin pages. */
	isAdmin: boolean;
	onCompose: () => void;
}) {
	const { addresses } = props;
	const scope = useScope();
	const navigate = useNavigate();
	// On phones the sidebar is a sheet over the page: close it once you've picked somewhere to go.
	const { setOpenMobile, isMobile, state } = useSidebar();
	// Desktop only: the phone sheet always shows names.
	const iconsOnly = state === "collapsed" && !isMobile;
	// Stays lit while a thread from this view is open.
	const view = useParams({ strict: false, select: (p) => p.view });
	const counts = useQuery(countsQuery(scope));
	const draftList = useDraftList(scope);
	const byLabel = new Map(counts.data?.labels.map((c) => [c.label, c]));
	const unreadByAddress = new Map(counts.data?.addresses.map((a) => [a.address, a.unread]));
	const userLabels = counts.data?.labels.filter((c) => !SYSTEM.has(c.label)).map((c) => c.label) ?? [];

	/** null = all addresses. `combine` adds or removes one address instead of switching to it. */
	const pick = (address: string | null, combine: boolean) => {
		const next = (current: string[]) => {
			if (address === null) return [];
			if (!combine) return [address];
			const toggled = new Set(current);
			if (toggled.has(address)) toggled.delete(address);
			else toggled.add(address);
			// Keep sidebar order, and treat "every address" as All.
			return toggled.size === addresses.length ? [] : addresses.filter((a) => toggled.has(a));
		};
		setOpenMobile(false);
		// Closes the open thread, which may not belong to the new scope. A search keeps its query.
		// `prev` is the latest URL, so quick presses stack even while the previous scope is still loading.
		void navigate({
			to: "/$view",
			params: (prev) => ({ view: prev.view ?? "inbox" }),
			search: (prev) => ({ ...prev, in: formatScope(next(parseScope(prev.in))) }),
		});
	};

	// 0 = all addresses, 1–9 = that address, Shift+digit = add/remove it.
	const onKey = useEffectEvent((e: KeyboardEvent) => {
		if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
		const digit = /^Digit(\d)$/.exec(e.code)?.[1];
		if (digit === undefined || addresses.length < 2) return;
		const address = digit === "0" ? null : addresses[Number(digit) - 1];
		if (address === undefined) return;
		e.preventDefault();
		pick(address, e.shiftKey);
	});
	useEffect(() => {
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	/** Collapsed to a dot, an address row's tooltip leads with the address it hides. */
	const scopeTip = (name: string, hint: string) => (
		<TooltipContent side="right" className={iconsOnly ? "flex-col items-start gap-0.5" : undefined}>
			{iconsOnly ? <span className="font-medium">{name}</span> : null}
			{hint}
		</TooltipContent>
	);

	const scopeRow = (address: string) => {
		const index = addresses.indexOf(address);
		const unread = unreadByAddress.get(address) ?? 0;
		return (
			<SidebarMenuItem key={address}>
				<Tooltip>
					<TooltipTrigger
						delay={iconsOnly ? 0 : 600}
						render={
							<SidebarMenuButton isActive={scope.includes(address)} onClick={(e) => pick(address, e.shiftKey || e.metaKey || e.ctrlKey)} className="select-none">
								<RowIcon unread={unread}>
									<span className={`size-2 rounded-full ${props.colors.get(address)}`} />
								</RowIcon>
								<span>{address}</span>
							</SidebarMenuButton>
						}
					/>
					{scopeTip(address, `${index < 9 ? `Press ${index + 1} · ` : ""}Shift-click to combine`)}
				</Tooltip>
				{unread > 0 ? <SidebarMenuBadge>{unread}</SidebarMenuBadge> : null}
			</SidebarMenuItem>
		);
	};

	const viewRow = (label: string, name: string, Icon: LucideIcon) => {
		const unread = label === "inbox" || !SYSTEM.has(label) ? (byLabel.get(label)?.unread ?? 0) : 0;
		const count = label === "drafts" ? draftList.drafts.length : unread;
		return (
			<SidebarMenuItem key={label}>
				<SidebarMenuButton
					isActive={view === label}
					tooltip={name}
					onClick={() => setOpenMobile(false)}
					render={<Link to="/$view" params={{ view: label }} activeOptions={{ includeSearch: false }} />}
				>
					<RowIcon unread={unread}>
						<Icon />
					</RowIcon>
					<span>{name}</span>
				</SidebarMenuButton>
				{count > 0 ? <SidebarMenuBadge>{count}</SidebarMenuBadge> : null}
			</SidebarMenuItem>
		);
	};

	return (
		// Collapses to an icon rail: the header's toggle or Ctrl/⌘+B.
		<SidebarRoot collapsible="icon">
			<SidebarHeader>
				{/* The logo sits on the icon column below, so it stays centred in the rail. */}
				<div className="flex h-8 items-center gap-1.5 px-1.5 font-semibold">
					<img src="/favicon.svg" alt="" className="size-5 shrink-0" />
					<span className="truncate group-data-[collapsible=icon]:hidden">Magnus Mail</span>
				</div>
				{/* Phones compose from the button floating over the list (App). */}
				{isMobile ? null : (
					<Tooltip disabled={!iconsOnly}>
						<TooltipTrigger
							render={
								<Button aria-label="Compose" className="group-data-[collapsible=icon]:px-0!" onClick={props.onCompose}>
									<SquarePenIcon data-icon="inline-start" />
									<span className="group-data-[collapsible=icon]:hidden">Compose</span>
								</Button>
							}
						/>
						<TooltipContent side="right">Compose</TooltipContent>
					</Tooltip>
				)}
			</SidebarHeader>
			{/* The rail scrolls too, or a short window would cut off the last rows. */}
			<SidebarContent className="group-data-[collapsible=icon]:overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto">
				<nav aria-label="Mail">
					{addresses.length > 1 ? (
						<>
							<SidebarGroup>
								<SidebarMenu>
									<SidebarMenuItem>
										<Tooltip>
											<TooltipTrigger
												delay={iconsOnly ? 0 : 600}
												render={
													<SidebarMenuButton isActive={scope.length === 0} onClick={() => pick(null, false)} className="select-none">
														<span className="mx-1 size-2 shrink-0 rounded-full border border-muted-foreground" />
														<span>All addresses</span>
													</SidebarMenuButton>
												}
											/>
											{scopeTip("All addresses", "Press 0")}
										</Tooltip>
									</SidebarMenuItem>
									{props.mailboxes.length > 1 ? null : addresses.map(scopeRow)}
								</SidebarMenu>
							</SidebarGroup>
							{props.mailboxes.length > 1
								? props.mailboxes.map((m) => (
										<SidebarGroup key={m.id}>
											<SidebarGroupLabel>{m.name}</SidebarGroupLabel>
											<SidebarMenu>{m.addresses.map((a) => scopeRow(a.address))}</SidebarMenu>
										</SidebarGroup>
									))
								: null}
							<SidebarSeparator />
						</>
					) : null}
					<SidebarGroup>
						<SidebarMenu>{SYSTEM_VIEWS.map((v) => viewRow(v.label, v.name, v.icon))}</SidebarMenu>
					</SidebarGroup>
					{userLabels.length > 0 ? (
						<SidebarGroup>
							<SidebarGroupLabel>Labels</SidebarGroupLabel>
							<SidebarMenu>{userLabels.map((l) => viewRow(l, l, TagIcon))}</SidebarMenu>
						</SidebarGroup>
					) : null}
				</nav>
			</SidebarContent>
			{/* Icon bar, after T3 Code's: Settings for everyone, Admin for admins, both in the settings sidebar. Stacks in the rail. */}
			<SidebarFooter className="flex-row gap-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
				<Tooltip>
					<TooltipTrigger
						render={
							<Link to="/settings" aria-label="Settings" className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}>
								<SettingsIcon />
							</Link>
						}
					/>
					<TooltipContent side={iconsOnly ? "right" : "top"}>Settings</TooltipContent>
				</Tooltip>
				{props.isAdmin ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Link to="/admin" aria-label="Admin" className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground")}>
									<ShieldIcon />
								</Link>
							}
						/>
						<TooltipContent side={iconsOnly ? "right" : "top"}>Admin</TooltipContent>
					</Tooltip>
				) : null}
			</SidebarFooter>
		</SidebarRoot>
	);
}

/** A row's icon. Collapsed, the unread count is hidden, so a dot on the icon stands in for it. */
function RowIcon(props: { unread: number; children: ReactNode }) {
	return (
		<span className="relative flex size-4 shrink-0 items-center justify-center">
			{props.children}
			{props.unread > 0 ? <span className="absolute -top-0.5 -right-0.5 hidden size-1.5 rounded-full bg-sidebar-primary group-data-[collapsible=icon]:block" /> : null}
		</span>
	);
}

const isTyping = (target: EventTarget | null) =>
	target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
