import { createFileRoute, Link, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { ArrowLeftIcon, AtSignIcon, GlobeIcon, UsersIcon } from "lucide-react";
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
} from "@/components/ui/sidebar";
import { AccountMenu } from "../components/AccountMenu";
import { directoryQuery, meQuery } from "../queries";

const PAGES = [
	{ to: "/admin/domains", label: "Domains", icon: GlobeIcon },
	{ to: "/admin/people", label: "People", icon: UsersIcon },
	{ to: "/admin/addresses", label: "Addresses", icon: AtSignIcon },
] as const;

/** Domains, people, and addresses. Admins only; everyone else is sent back to their mail. */
export const Route = createFileRoute("/_app/admin")({
	beforeLoad: async ({ context }) => {
		if (!(await context.queryClient.ensureQueryData(meQuery)).user.isAdmin) throw redirect({ to: "/" });
	},
	loader: ({ context }) => context.queryClient.ensureQueryData(directoryQuery),
	component: AdminLayout,
});

function AdminLayout() {
	const pathname = useLocation({ select: (l) => l.pathname });
	return (
		<SidebarProvider className="h-full text-sm">
			<Sidebar>
				<SidebarHeader>
					<div className="flex h-8 items-center gap-2 px-2 font-semibold">
						<img src="/favicon.svg" alt="" className="size-5" />
						Magnus Mail
					</div>
				</SidebarHeader>
				<SidebarContent>
					<SidebarGroup>
						<SidebarGroupLabel>Admin</SidebarGroupLabel>
						<SidebarMenu>
							{PAGES.map((page) => (
								<SidebarMenuItem key={page.to}>
									<SidebarMenuButton isActive={pathname.startsWith(page.to)} render={<Link to={page.to} />}>
										<page.icon />
										<span>{page.label}</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					</SidebarGroup>
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
