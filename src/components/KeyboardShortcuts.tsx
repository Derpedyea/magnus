import type { Me } from "#shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type AppHotkeyListItem, type CustomHotkeys, HotkeysProvider, useAppHotkeyList, useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { type ReactNode, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { appHotkeys } from "../hotkeys";
import { meQuery } from "../queries";
import { currentSession } from "../session";
import { Shortcut } from "./Shortcut";

/**
 * Every shortcut, with the ones you've rebound. They're saved to your account, so each device you sign in on has them.
 * Read once (keyed by person, in routes/_app.tsx); a change made on another device shows up next time the app loads.
 */
export function HotkeysRoot({ hotkeys, children }: { hotkeys: Me["hotkeys"]; children: ReactNode }) {
	const qc = useQueryClient();
	// One save at a time, so a quick second change can't land before the first.
	const saving = useRef(Promise.resolve());
	const save = (custom: CustomHotkeys) => {
		const value = custom as Me["hotkeys"];
		qc.setQueryData(meQuery.queryKey, (me) => me && { ...me, hotkeys: value });
		// One still queued when the session ends would go out with whoever signs in next (session.ts).
		const session = currentSession();
		saving.current = saving.current
			.then(() => (session === currentSession() ? api.saveHotkeys(value) : undefined))
			.catch((error: unknown) => {
				if (session === currentSession()) toast.add({ title: `Couldn't save your shortcuts: ${errorMessage(error)}`, type: "error" });
			});
	};
	return (
		// Saved by an older version, an entry may name a shortcut that's gone; the provider skips it. None fire while you
		// type, even rebound to a Ctrl or ⌘ chord, except Send, and Toggle assistant as a chord (hotkeys.ts).
		<HotkeysProvider
			appHotkeys={appHotkeys}
			customHotkeys={hotkeys as CustomHotkeys}
			onCustomHotkeysChange={save}
			defaultOptions={{ hotkey: { ignoreInputs: true } }}
		>
			{children}
			<CheatSheet />
		</HotkeysProvider>
	);
}

/** App hotkeys in their groups, in the order hotkeys.ts declares them. */
export function useShortcutGroups(): [string, AppHotkeyListItem[]][] {
	const groups = new Map<string, AppHotkeyListItem[]>();
	for (const item of useAppHotkeyList()) {
		const group = item.appHotkey.meta?.group ?? "Other";
		groups.set(group, [...(groups.get(group) ?? []), item]);
	}
	return [...groups];
}

/** What ? opens anywhere: every shortcut, after Gmail's and Linear's. */
function CheatSheet() {
	const [open, setOpen] = useState(false);
	useHotkey(useAppHotkeys()["help.shortcuts"], () => setOpen(true));
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent className="sm:max-w-2xl">
				<CheatSheetBody onClose={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}

/** Inside the dialog's scope, so the key that opened it closes it too. */
function CheatSheetBody({ onClose }: { onClose: () => void }) {
	useHotkey(useAppHotkeys()["help.shortcuts"], onClose);
	const groups = useShortcutGroups();
	return (
		<>
			<DialogHeader>
				<DialogTitle>Keyboard shortcuts</DialogTitle>
				<DialogDescription>
					<Link to="/settings/shortcuts" onClick={onClose} className="underline underline-offset-2 hover:text-foreground">
						Change them in Settings
					</Link>
				</DialogDescription>
			</DialogHeader>
			<div className="grid max-h-[70vh] gap-x-8 gap-y-5 overflow-y-auto sm:grid-cols-2">
				{groups.map(([group, items]) => (
					<section key={group}>
						<h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{group}</h3>
						<ul>
							{items
								.filter((i) => i.appHotkey.hotkey)
								.map(({ appHotkey }) => (
									<li key={appHotkey.id} className="flex items-center justify-between gap-4 py-1">
										{appHotkey.meta?.name}
										<Shortcut hotkey={appHotkey} />
									</li>
								))}
							{group === "Go to" ? (
								<li className="flex items-center justify-between gap-4 py-1">
									Address
									<span className="flex items-center gap-1 text-xs text-muted-foreground">
										<Kbd>0</Kbd>–<Kbd>9</Kbd>, Shift to combine
									</span>
								</li>
							) : null}
						</ul>
					</section>
				))}
			</div>
		</>
	);
}
