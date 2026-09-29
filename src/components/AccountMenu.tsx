import { LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccount } from "../hooks";
import { useSignOut } from "./SignOutButton";

/** Your initial in the header: who you're signed in as, and signing out. */
export function AccountMenu() {
	const { user } = useAccount();
	const signOut = useSignOut();
	const initial = Array.from(user.name.trim() || user.email)[0]?.toUpperCase();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="Account" className="rounded-full" />}>
				<span className="flex size-7 items-center justify-center rounded-full bg-muted font-medium text-foreground">{initial}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-56">
				<div className="flex flex-col px-1.5 py-1">
					<span className="truncate font-medium">{user.name}</span>
					<span className="truncate text-xs text-muted-foreground">{user.email}</span>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={() => signOut.mutate()} disabled={signOut.isPending}>
					<LogOutIcon />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
