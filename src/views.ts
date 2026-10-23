import type { Label } from "#shared";
import { ClockIcon, FilePenIcon, InboxIcon, MailsIcon, MailWarningIcon, OctagonAlertIcon, SendIcon, StarIcon, Trash2Icon, UserRoundCheckIcon } from "lucide-react";
import { labelPath } from "./labels";

/** The views every mailbox has, in sidebar order. Any other view is a label. */
export const SYSTEM_VIEWS = [
	{ label: "inbox", name: "Inbox", icon: InboxIcon },
	// Listed only while it holds mail (Sidebar): first-time senders, when the mailbox screens them.
	{ label: "screener", name: "Screener", icon: UserRoundCheckIcon, transient: true },
	{ label: "starred", name: "Starred", icon: StarIcon },
	{ label: "drafts", name: "Drafts", icon: FilePenIcon },
	{ label: "sent", name: "Sent", icon: SendIcon },
	{ label: "outbox", name: "Outbox", icon: ClockIcon },
	{ label: "all", name: "All mail", icon: MailsIcon },
	{ label: "spam", name: "Spam", icon: OctagonAlertIcon },
	{ label: "trash", name: "Trash", icon: Trash2Icon },
	// An alert: listed only while it holds mail (Sidebar).
	{ label: "failed", name: "Failed", icon: MailWarningIcon, alert: true, transient: true },
];
export const SYSTEM = new Set(SYSTEM_VIEWS.map((v) => v.label));

/** What a view is called: a system view's name, or a label's name after those of the labels it's in. */
export const viewName = (view: string, labels: ReadonlyMap<string, Label>) =>
	view === "search" ? "Search" : (SYSTEM_VIEWS.find((v) => v.label === view)?.name ?? labelPath(labels, view));
