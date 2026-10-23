import { type AppHotkey, formatForDisplay, HotkeysProvider, useHotkeyHint } from "@tanstack/react-hotkeys";
import { type ReactNode, useId } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/** A shortcut as this platform writes it (⌘ on a Mac, Ctrl elsewhere), or nothing while it's unbound. */
export function Shortcut({ hotkey, className }: { hotkey: AppHotkey; className?: string }) {
	return hotkey.hotkey ? <Kbd className={className}>{formatForDisplay(hotkey.hotkey)}</Kbd> : null;
}

/** A Mod shortcut's label, shown only while its modifier is held, as in Linear and Arc. */
export function ShortcutHint({ hotkey, className }: { hotkey: AppHotkey; className?: string }) {
	return useHotkeyHint(hotkey) ? <Shortcut hotkey={hotkey} className={cn("bg-background/20 text-current", className)} /> : null;
}

/**
 * Wraps a dialog, menu, or sheet: while it's open its own keys are the only ones that work, so E in a menu doesn't
 * archive the conversation behind it. Per instance, so one opened from another takes over until it closes.
 */
export function OverlayScope({ children }: { children: ReactNode }) {
	return (
		<HotkeysProvider scope={`overlay-${useId()}`} exclusive>
			{children}
		</HotkeysProvider>
	);
}
