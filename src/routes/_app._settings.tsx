import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon, AtSignIcon, BanIcon, BellIcon, GlobeIcon, KeyRoundIcon, OctagonAlertIcon, PaletteIcon, SignatureIcon, UsersIcon } from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { AccountMenu } from "../components/AccountMenu";
import { useAccount } from "../hooks";

const GROUPS = [
	{
		label: "Settings",
		admin: false,
		pages: [
			{ to: "/settings/appearance", label: "Appearance", icon: PaletteIcon },
			{ to: "/settings/notifications", label: "Notifications", icon: BellIcon },
			{ to: "/settings/signatures", label: "Signatures", icon: SignatureIcon },
			{ to: "/settings/sign-in", label: "Sign-in", icon: KeyRoundIcon },
			{ to: "/settings/spam", label: "Spam", icon: OctagonAlertIcon },
		],
	},
	{
		label: "Admin",
		admin: true,
		pages: [
			{ to: "/admin/domains", label: "Domains", icon: GlobeIcon },
			{ to: "/admin/people", label: "People", icon: UsersIcon },
			{ to: "/admin/addresses", label: "Addresses", icon: AtSignIcon },
			{ to: "/admin/blocked-senders", label: "Blocked senders", icon: BanIcon },
		],
	},
] as const;

/** Your settings and, for admins, the admin pages: one sidebar, like Linear's, so either is a click from the other. */
export const Route = createFileRoute("/_app/_settings")({ component: SettingsLayout });

function SettingsLayout() {
	return (
		<SidebarProvider className="h-full text-sm">
			<SettingsSidebar />
			<SidebarInset className="min-w-0">
				<header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
					<SidebarTrigger />
					<div className="ml-auto">
						<AccountMenu />
					</div>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto">
					<Outlet />
				</div>
			</SidebarInset>
		</SidebarProvider>
	);
}

function SettingsSidebar() {
	const { user } = useAccount();
	const pathname = useLocation({ select: (l) => l.pathname });
	// On phones the sidebar is a sheet over the page: close it once you've picked somewhere to go.
	const { setOpenMobile } = useSidebar();
	return (
		<Sidebar>
			<SidebarHeader>
				<div className="flex h-8 items-center gap-2 px-2 font-semibold">
					<img src="/favicon.svg" alt="" className="size-5" />
					Magnus Mail
				</div>
			</SidebarHeader>
			<SidebarContent>
				{GROUPS.filter((g) => user.isAdmin || !g.admin).map((group) => (
					<SidebarGroup key={group.label}>
						<SidebarGroupLabel>{group.label}</SidebarGroupLabel>
						<SidebarMenu>
							{group.pages.map((page) => (
								<SidebarMenuItem key={page.to}>
									<SidebarMenuButton isActive={pathname.startsWith(page.to)} onClick={() => setOpenMobile(false)} render={<Link to={page.to} />}>
										<page.icon />
										<span>{page.label}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
				))}
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton render={<Link to="/" />}>
							<ArrowLeftIcon />
							<span>Back to mail</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
