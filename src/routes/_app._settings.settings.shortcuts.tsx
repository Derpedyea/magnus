import { createFileRoute } from "@tanstack/react-router";
import { type AppHotkeyId, type AppHotkeyListItem, formatForDisplay, useCustomHotkeys, useHotkeyRecorder } from "@tanstack/react-hotkeys";
import { RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useShortcutGroups } from "../components/KeyboardShortcuts";
import { SettingsPage } from "../components/SettingsPage";
import { Shortcut } from "../components/Shortcut";
import { usesAddressKey } from "../hotkeys";

export const Route = createFileRoute("/_app/_settings/settings/shortcuts")({ component: Shortcuts });

/**
 * Every shortcut, each changed by clicking it and pressing the new keys, as in Linear and VS Code. Saved to your
 * account (components/KeyboardShortcuts.tsx), so they're the same on every device.
 */
function Shortcuts() {
	const groups = useShortcutGroups();
	const { customHotkeys, resetCustomHotkeys } = useCustomHotkeys();
	return (
		<SettingsPage
			title="Keyboard shortcuts"
			action={
				Object.keys(customHotkeys).length > 0 ? (
					<Button variant="outline" size="sm" onClick={resetCustomHotkeys}>
						Reset all
					</Button>
				) : null
			}
		>
			<div className="flex max-w-xl flex-col gap-6">
				<p className="text-muted-foreground">
					Click a shortcut and press new keys. Press keys one after another for a sequence, like <Kbd>G</Kbd> <Kbd>I</Kbd>. Backspace removes one.
				</p>
				{groups.map(([group, items]) => (
					<section key={group} className="flex flex-col">
						<h2 className="mb-1 font-medium">{group}</h2>
						{items.map((item) => (
							<ShortcutRow key={item.appHotkey.id} item={item} />
						))}
					</section>
				))}
			</div>
		</SettingsPage>
	);
}

function ShortcutRow({ item }: { item: AppHotkeyListItem }) {
	const { appHotkey, isCustom } = item;
	const id = appHotkey.id as AppHotkeyId;
	const name = appHotkey.meta?.name ?? id;
	const errorId = useId();
	const [error, setError] = useState<string | null>(null);
	const { findConflicts, setCustomHotkey, resetCustomHotkey } = useCustomHotkeys();
	const recorder = useHotkeyRecorder({
		// Up to three keys in a row; Enter, or a second's pause, ends it.
		maxSteps: 3,
		idleTimeoutMs: 1000,
		// What the key types, as the defaults are written, so a shortcut follows your keyboard layout and conflicts match.
		recordBy: "key",
		// Keys anything on screen uses right now…
		detectConflicts: true,
		// …and the rest of these, mounted or not.
		validate: (hotkey, context) => {
			if (usesAddressKey(context.kind === "chord" ? [context.event] : context.events)) return "Number keys switch between addresses";
			const [conflict] = findConflicts(id, hotkey);
			return conflict ? `${formatForDisplay(hotkey)} is already ${conflict.meta?.name ?? conflict.id}` : true;
		},
		onReject: (rejection) => setError(rejection.message),
		onRecord: (hotkey) => {
			setError(null);
			setCustomHotkey(id, hotkey);
		},
		onClear: () => {
			setError(null);
			setCustomHotkey(id, null);
		},
		onCancel: () => setError(null),
	});
	const preview = recorder.steps.length > 0 ? formatForDisplay(recorder.steps) : null;

	return (
		<div className="flex min-h-10 flex-wrap items-center gap-x-3 border-b py-1.5 last:border-b-0">
			<span className="flex-1">{name}</span>
			{isCustom && !recorder.isRecording ? (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="ghost" size="icon-xs" aria-label={`Reset ${name}`} className="text-muted-foreground" onClick={() => resetCustomHotkey(id)}>
								<RotateCcwIcon />
							</Button>
						}
					/>
					<TooltipContent>Reset to {appHotkey.defaultHotkey ? formatForDisplay(appHotkey.defaultHotkey) : "none"}</TooltipContent>
				</Tooltip>
			) : null}
			<Button
				variant="outline"
				size="sm"
				aria-label={`${name}: ${appHotkey.hotkey ? formatForDisplay(appHotkey.hotkey) : "none"}. Change`}
				aria-describedby={error ? errorId : undefined}
				onClick={() => (recorder.isRecording ? recorder.cancelRecording() : recorder.startRecording())}
				// Clicking away, or another shortcut, cancels.
				onBlur={() => recorder.isRecording && recorder.cancelRecording()}
				className={cn("min-w-24 justify-center", recorder.isRecording && "border-ring ring-3 ring-ring/50")}
			>
				{recorder.isRecording ? (
					(preview ?? <span className="text-muted-foreground">Press keys…</span>)
				) : appHotkey.hotkey ? (
					<Shortcut hotkey={appHotkey} className="bg-transparent text-foreground" />
				) : (
					<span className="text-muted-foreground">None</span>
				)}
			</Button>
			{error ? (
				<p id={errorId} role="alert" className="w-full pb-1 text-right text-xs text-destructive">
					{error}
				</p>
			) : null}
		</div>
	);
}
