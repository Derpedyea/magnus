import { defineAppHotkeys } from "@tanstack/react-hotkeys";

/**
 * Every shortcut anyone can rebind, after Gmail's: letters for mail, G then a letter to go somewhere, Mod (⌘ on a Mac,
 * Ctrl elsewhere) where a letter alone would be typed. Each is registered where its action lives. Ids are what saved
 * custom shortcuts are keyed by (Me["hotkeys"]), so renaming one drops everyone's change to it. Groups list in this order.
 */
export const appHotkeys = defineAppHotkeys({
	"compose.new": { hotkey: "C", meta: { name: "Compose", group: "Mail" } },
	// Registered on each composer (Composer), ahead of the editor, where Mod+Enter would add a line break.
	"compose.send": { hotkey: "Mod+Enter", meta: { name: "Send", group: "Mail" }, options: { capture: true, stopPropagation: true, conflictBehavior: "allow" } },
	"search.focus": { hotkey: "/", meta: { name: "Search", group: "Mail" } },

	"thread.next": { hotkey: "J", meta: { name: "Next conversation", group: "Conversation" } },
	"thread.previous": { hotkey: "K", meta: { name: "Previous conversation", group: "Conversation" } },
	"thread.close": { hotkey: "U", meta: { name: "Back to list", group: "Conversation" } },
	"thread.reply": { hotkey: "R", meta: { name: "Reply", group: "Conversation" } },
	"thread.replyAll": { hotkey: "A", meta: { name: "Reply all", group: "Conversation" } },
	"thread.forward": { hotkey: "F", meta: { name: "Forward", group: "Conversation" } },
	"thread.archive": { hotkey: "E", meta: { name: "Archive", group: "Conversation" } },
	// Not Gmail's # and !: on most layouts they're Shift and a number, which the address keys take. Backspace is a Mac's delete.
	"thread.trash": { hotkey: "Backspace", meta: { name: "Trash", group: "Conversation" } },
	"thread.spam": { hotkey: "Shift+S", meta: { name: "Spam", group: "Conversation" } },
	"thread.star": { hotkey: "S", meta: { name: "Star", group: "Conversation" } },
	"thread.unread": { hotkey: "Shift+U", meta: { name: "Mark unread", group: "Conversation" } },

	"go.inbox": { hotkey: ["G", "I"], meta: { name: "Inbox", group: "Go to" } },
	"go.starred": { hotkey: ["G", "S"], meta: { name: "Starred", group: "Go to" } },
	"go.drafts": { hotkey: ["G", "D"], meta: { name: "Drafts", group: "Go to" } },
	"go.sent": { hotkey: ["G", "T"], meta: { name: "Sent", group: "Go to" } },
	"go.all": { hotkey: ["G", "A"], meta: { name: "All mail", group: "Go to" } },

	// Not while typing, where Mod+B is bold.
	"sidebar.toggle": { hotkey: "Mod+B", meta: { name: "Toggle sidebar", group: "App" }, options: { ignoreInputs: true } },
	"help.shortcuts": { hotkey: "?", meta: { name: "Keyboard shortcuts", group: "App" } },
});

declare module "@tanstack/react-hotkeys" {
	interface Register {
		appHotkeys: typeof appHotkeys;
	}
}

/**
 * The address shortcuts (Sidebar): 0 for all, 1–9 for one, Shift to combine. Physical keys, as they're picked by
 * position, which on some layouts (AZERTY) needs Shift for the digit itself. Fixed, so nothing else may take them.
 */
export const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** Whether a recorded shortcut uses a number key without Ctrl, Alt, or ⌘, which the address keys take, whatever it types. */
export function usesAddressKey(events: ReadonlyArray<KeyboardEvent>): boolean {
	return events.some((e) => /^Digit\d$/.test(e.code) && !e.ctrlKey && !e.altKey && !e.metaKey);
}
