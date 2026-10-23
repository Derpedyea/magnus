import type { MailboxThread } from "#shared";
import { type AppHotkey, formatForDisplay, HotkeysProvider, useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { type InfiniteData, type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArchiveIcon, InboxIcon, type LucideIcon, MailIcon, MailOpenIcon, OctagonAlertIcon, TagIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd } from "@/components/ui/kbd";
import { toast } from "@/components/ui/toast-manager";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "../api";
import { batches } from "../labels";
import { currentSession } from "../session";
import { LabelPicker } from "./LabelPicker";
import { Shortcut } from "./Shortcut";

/**
 * The list's header while conversations are selected: ThreadView's toolbar, for all of them at once. Its shortcuts
 * outrank the open conversation's, since a scope wins a key it shares with the global one, so E archives these rather
 * than that one, as in Gmail. `keys` is false while the open one covers the list: then they're its again.
 */
export function SelectionBar(props: {
	threads: readonly MailboxThread[];
	view: string;
	/** Whether every loaded conversation is selected. */
	all: boolean;
	keys: boolean;
	onSelectAll: () => void;
	onClear: () => void;
	/** After the actions ThreadView closes the conversation after: all but Move to inbox, Mark read, and Label. */
	onDone: (threads: readonly MailboxThread[]) => void;
}) {
	return (
		<HotkeysProvider scope="selection" enabled={props.keys}>
			<Bar {...props} />
		</HotkeysProvider>
	);
}

function Bar({ threads, view, all, onSelectAll, onClear, onDone }: Parameters<typeof SelectionBar>[0]) {
	const hotkeys = useAppHotkeys();
	const change = useChangeThreads();
	const [labeling, setLabeling] = useState(false);
	// What ThreadView offers each of them: Archive for mail in the inbox, or else Move to inbox; Trash outside Trash.
	const inInbox = threads.some((t) => t.labels.includes("inbox"));
	const unread = threads.some((t) => t.unreadCount > 0);
	const moveOut = (verb: string, add: string[], remove: string[]) => (change.mutate({ threads, verb, add, remove }), onDone(threads));
	const archive = () => moveOut("archive", [], ["inbox"]);
	const moveToInbox = () => change.mutate({ threads, verb: "move to inbox", add: ["inbox"], remove: ["trash", "spam", "screener"] });
	const trash = () => moveOut("move to trash", ["trash"], []);
	const spam = () => moveOut("mark as spam", ["spam"], []);
	const markRead = () => change.mutate({ threads, verb: "mark read", read: true });
	const markUnread = () => (change.mutate({ threads, verb: "mark unread", read: false }), onDone(threads));
	useHotkey(hotkeys["thread.archive"], () => inInbox && archive());
	useHotkey(hotkeys["thread.trash"], () => view !== "trash" && trash());
	useHotkey(hotkeys["thread.spam"], spam);
	useHotkey(hotkeys["thread.unread"], markUnread);
	useHotkey(hotkeys["thread.label"], () => setLabeling(true));
	useHotkey("Escape", onClear);

	// Icons alone, as on a phone's thread toolbar, since the list is narrow; the label is in the tooltip.
	const action = (Icon: LucideIcon, label: string, onClick: (() => void) | undefined, hint?: ReactNode, wrap = (button: ReactElement) => button) => (
		<Tooltip>
			{wrap(
				<TooltipTrigger
					render={
						<Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick} className="text-muted-foreground max-md:size-10">
							<Icon className="size-4 max-md:size-5" />
						</Button>
					}
				/>,
			)}
			<TooltipContent>
				{label} {hint}
			</TooltipContent>
		</Tooltip>
	);
	const key = (hotkey: AppHotkey) => <Shortcut hotkey={hotkey} />;

	return (
		<div className="sticky top-0 z-10 flex items-center gap-0.5 border-b bg-background py-1.5 pr-2 pl-3 max-md:py-0.5">
			<Checkbox
				checked={all}
				indeterminate={!all}
				onCheckedChange={() => (all ? onClear() : onSelectAll())}
				aria-label={all ? "Select none" : "Select all"}
			/>
			<span className="mr-auto ml-3 text-sm whitespace-nowrap">{threads.length} selected</span>
			{inInbox ? action(ArchiveIcon, "Archive", archive, key(hotkeys["thread.archive"])) : action(InboxIcon, "Move to inbox", moveToInbox)}
			{view === "trash" ? null : action(Trash2Icon, "Trash", trash, key(hotkeys["thread.trash"]))}
			{action(OctagonAlertIcon, "Spam", spam, key(hotkeys["thread.spam"]))}
			{unread ? action(MailOpenIcon, "Mark read", markRead) : action(MailIcon, "Mark unread", markUnread, key(hotkeys["thread.unread"]))}
			{action(TagIcon, "Label", undefined, key(hotkeys["thread.label"]), (button) => (
				<LabelPicker threads={threads} open={labeling} onOpenChange={setLabeling} trigger={button} />
			))}
			{action(XIcon, "Clear selection", onClear, <Kbd>{formatForDisplay("Escape")}</Kbd>)}
		</div>
	);
}

interface Change {
	threads: readonly MailboxThread[];
	/** What failing says it couldn't do. */
	verb: string;
	add?: string[];
	remove?: string[];
	/** Marks them read or unread instead. */
	read?: boolean;
}

const isList = (key: QueryKey) => key[0] === "mail" && (key[1] === "threads" || key[1] === "search");

const CHANGING = ["changing"];

/**
 * Archives, trashes, or marks conversations, in as many calls as their mailboxes and number take. Loaded lists show it
 * at once, without the ones it takes out of them; once the last change is in, the mail is refetched, which undoes any
 * that failed.
 */
function useChangeThreads() {
	const qc = useQueryClient();
	return useMutation({
		// One at a time, in order, so Mark read then Mark unread ends up unread.
		mutationKey: CHANGING,
		scope: { id: "changing" },
		mutationFn: async ({ threads, add = [], remove = [], read }: Change) => {
			// All of them finish, even when one fails, so the refetch shows each where it ended up.
			const sent = await Promise.allSettled(
				batches(threads).map((b) => (read === undefined ? api.modify(b.mailboxId, b.threadIds, add, remove) : api.markRead(b.mailboxId, b.threadIds, read))),
			);
			const failed = sent.find((r) => r.status === "rejected");
			if (failed) throw failed.reason;
		},
		onMutate: async ({ threads, add = [], remove = [], read }) => {
			const session = currentSession();
			// Trash and spam take mail out of the inbox and the Screener too (Mailbox.modifyThreads).
			const binned = add.some((l) => l === "trash" || l === "spam");
			const removed = binned ? [...remove, "inbox", "screener"] : remove;
			// As the server lists them (Mailbox.listThreads): a label's list loses what the label came off, All mail what's
			// in Trash or Spam. Search results stay.
			const leaves = (key: QueryKey) => key[1] === "threads" && typeof key[3] === "string" && (removed.includes(key[3]) || (key[3] === "all" && binned));
			const changed = (t: MailboxThread): MailboxThread =>
				read === undefined ? { ...t, labels: [...new Set([...t.labels.filter((l) => !removed.includes(l)), ...add])] } : { ...t, unreadCount: read ? 0 : t.messageCount };
			const ids = new Set(threads.map((t) => `${t.mailboxId}/${t.id}`));
			// A refetch already under way would bring back the mail from before. One still loading has nothing to change.
			await qc.cancelQueries({ predicate: (q) => q.state.data !== undefined && isList(q.queryKey) });
			for (const [key, data] of qc.getQueriesData<InfiniteData<{ threads: MailboxThread[] }>>({ predicate: (q) => isList(q.queryKey) })) {
				if (!data) continue;
				const out = leaves(key);
				const pages = data.pages.map((p) => ({
					...p,
					threads: p.threads.flatMap((t) => (!ids.has(`${t.mailboxId}/${t.id}`) ? [t] : out ? [] : [changed(t)])),
				}));
				qc.setQueryData(key, { ...data, pages });
			}
			return session;
		},
		onError: (error, { verb }, session) => {
			if (session === currentSession()) toast.add({ title: `Couldn't ${verb}: ${errorMessage(error)}`, type: "error" });
		},
		// Not between changes: what came back would undo the ones still waiting.
		onSettled: () => {
			if (qc.isMutating({ mutationKey: CHANGING }) === 1) void qc.invalidateQueries({ queryKey: ["mail"] });
		},
	});
}
