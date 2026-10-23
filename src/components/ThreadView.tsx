import {
	type Address,
	type AttachmentMeta,
	type DeliveryStatus,
	formatBytes,
	type MessageDetail,
	type PreviewKind,
	preview,
	RETRYABLE,
	type ThreadMessage,
} from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useCanGoBack, useRouter } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { ArchiveIcon, ArrowLeftIcon, BanIcon, CheckIcon, CircleAlertIcon, ClockIcon, DownloadIcon, EllipsisIcon, ForwardIcon, ImageOffIcon, InboxIcon, Link2OffIcon, LinkIcon, MailIcon, MinusIcon, OctagonAlertIcon, PaperclipIcon, ReplyAllIcon, ReplyIcon, RotateCwIcon, ShieldCheckIcon, ShieldXIcon, StarIcon, StarOffIcon, Trash2Icon, TriangleAlertIcon, UserRoundCheckIcon, XIcon, type LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast-manager";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, formatList, messageUrl } from "../api";
import { type AnswerContext, answerFrom, isOutgoing, openDraft, quote, replyRecipients, withSignature } from "../compose";
import { useAccount, useScope } from "../hooks";
import { threadQuery } from "../queries";
import { findQuote, isForward, splitQuote } from "../quotes";
import { type Branch, replyTree } from "../replies";
import { currentSession } from "../session";
import { appearance } from "../theme";
import { BlockSender, useCanBlock } from "./BlockSender";
import { Composer, type Draft } from "./Composer";
import { FileViewer } from "./FileViewer";
import { PermanentDelete } from "./PermanentDelete";

const route = getRouteApi("/_app/_mail/$view/$mailboxId/$threadId");

export function ThreadView() {
	const { view, mailboxId, threadId } = route.useParams();
	// Replies must be sent from the thread's own mailbox.
	const account = useAccount();
	const identities = account.identities.filter((i) => i.mailboxId === mailboxId);
	// Disabled ones too: mail one of them sent is still the mailbox's own.
	const mailbox = account.mailboxes.find((m) => m.id === mailboxId);
	const ours = mailbox ? [...mailbox.addresses.map((a) => a.address), ...mailbox.disabled] : [];
	const qc = useQueryClient();
	const { data } = useSuspenseQuery(threadQuery(mailboxId, threadId));
	const close = useCloseThread();
	const invalidate = () => qc.invalidateQueries({ queryKey: ["mail"] });
	// Most actions close the thread without waiting, so a failure can only show up as a toast, and only in the session
	// that asked (session.ts).
	const failed = (verb: string, error: Error, session: number | undefined) => {
		if (session === currentSession()) toast.add({ title: `Couldn't ${verb}: ${errorMessage(error)}`, type: "error" });
	};

	const modify = useMutation({
		mutationFn: (v: { verb: string; add?: string[]; remove?: string[] }) => api.modify(mailboxId, [threadId], v.add ?? [], v.remove ?? []),
		onMutate: currentSession,
		onSuccess: invalidate,
		onError: (error, v, session) => failed(v.verb, error, session),
	});
	const markRead = useMutation({
		mutationFn: (read: boolean) => api.markRead(mailboxId, [threadId], read),
		onMutate: currentSession,
		onSuccess: invalidate,
		// Only when asked for: marking read happens by itself on opening, and the next opening tries again.
		onError: (error, read, session) => {
			if (!read) failed("mark unread", error, session);
		},
	});

	const unread = data.thread.unreadCount;
	const { mutate: setRead } = markRead;
	useEffect(() => {
		if (unread > 0) setRead(true);
	}, [unread, setRead]);

	const { thread: summary, messages } = data;
	// Mail between our own addresses is outgoing for the sender and incoming for the recipient,
	// so it's only "sent" here when the sender is one of the addresses in view.
	const scope = new Set(useScope());
	const inView = (address: string) => scope.size === 0 || scope.has(address.toLowerCase());
	const starred = summary.labels.includes("starred");
	const inInbox = summary.labels.includes("inbox");
	const trashed = messages.filter((m) => m.labels.includes("trash")).length;
	// An inbox conversation with an older trashed message still needs a way to trash its remaining replies.
	const deleteForever = trashed > 0 && (view === "trash" || trashed === messages.length);
	const answerContext = (m: MessageDetail): AnswerContext => ({
		mailboxId,
		identities,
		delivered: summary.addresses,
		outgoing: isOutgoing(m, ours, inView),
		inView,
	});
	const last = messages.at(-1);

	// After a send from the reply box, the thread follows its end for a few seconds, as a chat does: the new message
	// comes in, and its frame sizes itself, after the send returns.
	const ref = useRef<HTMLElement>(null);
	const followUntil = useRef(0);
	useEffect(() => {
		const article = ref.current;
		const scroller = article && scrollParent(article);
		if (!article || !scroller) return;
		const observer = new ResizeObserver(() => {
			if (Date.now() < followUntil.current) scroller.scrollTo({ top: scroller.scrollHeight });
		});
		observer.observe(article);
		return () => observer.disconnect();
	}, []);
	const onSent = () => {
		followUntil.current = Date.now() + 4000;
		const scroller = ref.current && scrollParent(ref.current);
		scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	};

	// Phones show icons alone, bigger, like Gmail's toolbar; the label stays for screen readers.
	const action = (Icon: LucideIcon, label: string, onClick: () => void) => (
		<Button variant="ghost" size="sm" onClick={onClick} className="text-muted-foreground max-md:size-10 max-md:px-0">
			<Icon className="size-3.5 max-md:size-5" />
			<span className="max-md:sr-only">{label}</span>
		</Button>
	);

	return (
		<article ref={ref} className="mx-auto max-w-4xl px-4 pb-6 lg:p-6">
			{/* Stacked over the list, the toolbar stays on screen and leads with the way back. */}
			<div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-1 border-b bg-background px-2 py-2 lg:static lg:mx-0 lg:flex-wrap lg:px-0 lg:pt-0 lg:pb-3">
				<BackToList className="mr-auto" />
				{inInbox
					? action(ArchiveIcon, "Archive", () => (modify.mutate({ verb: "archive", remove: ["inbox"] }), close()))
					: action(InboxIcon, "Move to inbox", () => modify.mutate({ verb: "move to inbox", add: ["inbox"], remove: ["trash", "spam", "screener"] }))}
				{deleteForever
					? <PermanentDelete key={`${mailboxId}/${threadId}`} thread={{ mailboxId, id: threadId, subject: summary.subject, count: trashed }} />
					: action(Trash2Icon, "Trash", () => (modify.mutate({ verb: "move to trash", add: ["trash"] }), close()))}
				{action(OctagonAlertIcon, "Spam", () => (modify.mutate({ verb: "mark as spam", add: ["spam"] }), close()))}
				{starred
					? action(StarOffIcon, "Unstar", () => modify.mutate({ verb: "unstar", remove: ["starred"] }))
					: action(StarIcon, "Star", () => modify.mutate({ verb: "star", add: ["starred"] }))}
				{action(MailIcon, "Mark unread", () => (markRead.mutate(false), close()))}
			</div>
			<h1 className="font-heading text-xl font-semibold break-words">{summary.subject}</h1>
			<p className="mt-1 mb-4 text-sm text-muted-foreground">
				{summary.participants.map((p) => p.name || p.address).join(", ")} · {messages.length} {messages.length === 1 ? "message" : "messages"}
			</p>
			<div className="flex flex-col gap-1">
				{replyTree(messages).map((branch) => (
					<BranchView
						key={branch.messages[0]?.id}
						branch={branch}
						render={(m, above) => {
							const ctx = answerContext(m);
							return (
								<Message
									mailboxId={mailboxId}
									message={m}
									outgoing={ctx.outgoing}
									// Branches that stopped indenting say which message a reply answers when it isn't the one above.
									replyingTo={above && m.parentId && m.parentId !== above.id ? messages.find((p) => p.id === m.parentId) : undefined}
									onReply={(all) => openDraft(replyDraft(m, all, ctx))}
									onForward={() => openDraft(forwardDraft(m, ctx))}
								/>
							);
						}}
					/>
				))}
			</div>
			{last ? <ReplyDock key={last.id} message={last} ctx={answerContext(last)} onSent={onSent} /> : null}
		</article>
	);
}

/**
 * The thread's reply box: answers its last message, chat-style, without leaving the thread. Each send or discard
 * starts a fresh one. Older messages answer from their own menus, in the composer window.
 */
function ReplyDock({ message: m, ctx, onSent }: { message: ThreadMessage; ctx: AnswerContext; onSent: () => void }) {
	const account = useAccount();
	// A new id for each box, so a sent reply's draft isn't reused by the next.
	const [draftId, setDraftId] = useState(() => crypto.randomUUID());
	// Mounted per message (ThreadView keys it), so the starting point stays put while it's typed in.
	const [{ initial, replyAll }] = useState(() => {
		const draft = replyDraft(m, false, ctx);
		const all = replyDraft(m, true, ctx);
		return {
			// The quote goes out with it (Composer's `inline`) rather than filling the box.
			initial: { ...draft, text: withSignature("", null, signatureOf(draft.from, ctx)) },
			replyAll: { to: all.to, cc: all.cc },
		};
	});
	return (
		<Composer
			key={draftId}
			id={0}
			draftId={draftId}
			identities={account.identities}
			initial={initial}
			restored={false}
			inline={{ quote: quote(m), onDone: () => setDraftId(crypto.randomUUID()), onSent, replyAll }}
		/>
	);
}

/** The nearest ancestor that scrolls: the thread's pane, whichever layout it's in (routes/_app._mail.$view.tsx). */
function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p; p = p.parentElement) if (/auto|scroll/.test(getComputedStyle(p).overflowY)) return p;
	return null;
}

/** Below lg, where the thread covers the list (routes/_app._mail.$view.tsx). Matches Tailwind's `max-lg:`. */
const stacked = () => matchMedia("(width < 64rem)").matches;

/**
 * Leaves the thread for its list. Stacked, the thread is a screen pushed over the list, so this goes back to it, as
 * the phone's own back gesture would, rather than pushing the list again for Back to return to the thread.
 */
function useCloseThread() {
	const view = route.useParams({ select: (p) => p.view });
	const navigate = route.useNavigate();
	const router = useRouter();
	const canGoBack = useCanGoBack();
	return () => {
		if (canGoBack && stacked()) router.history.back();
		else void navigate({ to: "/$view", params: { view }, search: true });
	};
}

/** The way back to the list, where the thread covers it. Also on the thread's loading and error screens. */
export function BackToList({ className }: { className?: string }) {
	const close = useCloseThread();
	return (
		<Button variant="ghost" size="icon" aria-label="Back" onClick={close} className={cn("text-muted-foreground max-md:size-10 lg:hidden", className)}>
			<ArrowLeftIcon className="size-4 max-md:size-5" />
		</Button>
	);
}

/** A branch's messages, then the branches forking off its last message, each indented behind a line. */
function BranchView(props: { branch: Branch<ThreadMessage>; render: (m: ThreadMessage, above: ThreadMessage | undefined) => React.ReactNode }) {
	const { messages, forks } = props.branch;
	const last = messages.at(-1);
	return (
		<>
			{messages.map((m, i) => (
				<div key={m.id}>{props.render(m, messages[i - 1])}</div>
			))}
			{forks.length > 0 && last ? (
				<div role="group" aria-label={`Replies to ${last.from.name || last.from.address}`} className="flex flex-col gap-1">
					{forks.map((fork) => (
						<div key={fork.messages[0]?.id} className="ml-[1.875rem] flex flex-col gap-1 border-l border-foreground/15 pl-3">
							<BranchView branch={fork} render={props.render} />
						</div>
					))}
				</div>
			) : null}
		</>
	);
}

/** Their initial, with whether their domain vouched for them. */
function Avatar({ message: m }: { message: MessageDetail }) {
	const initial = Array.from(m.from.name?.trim() || m.from.address)[0]?.toUpperCase();
	return (
		<span className="relative size-9">
			<span aria-hidden className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground ring-1 ring-foreground/10 ring-inset">
				{initial}
			</span>
			<SenderBadge message={m} />
		</span>
	);
}

/**
 * Whether the From's domain vouched for it: a check when it did, a cross when it failed, nothing when there was
 * nothing to go on. The cross comes with Forged's banner too; this is the at-a-glance half. Hover or tap says what
 * it means, with each check in plain words under Details.
 */
function SenderBadge({ message: m }: { message: MessageDetail }) {
	const [details, setDetails] = useState(false);
	const spoofed = m.verdict?.kind === "spoofed";
	if (!m.senderVerified && !spoofed) return null;
	const domain = domainOf(m.from.address);
	const title = spoofed ? `May not be from ${domain}` : `Really from ${domain}`;
	const BadgeIcon = spoofed ? XIcon : CheckIcon;
	const ShieldIcon = spoofed ? ShieldXIcon : ShieldCheckIcon;
	return (
		<Popover onOpenChange={(open) => open || setDetails(false)}>
			<PopoverTrigger
				openOnHover
				delay={150}
				aria-label={title}
				className={cn(
					"absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full text-white ring-2 ring-background outline-none focus-visible:ring-ring",
					spoofed ? "bg-destructive" : "bg-emerald-600",
				)}
			>
				<BadgeIcon className="size-2.5" strokeWidth={3.5} />
			</PopoverTrigger>
			<PopoverContent side="bottom" align="start" className="w-auto max-w-80 gap-0 p-3">
				<div className="flex items-start gap-2.5">
					<span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", spoofed ? "bg-destructive/15 text-destructive" : "bg-emerald-500/15 text-emerald-500")}>
						<ShieldIcon className="size-4" />
					</span>
					<div className="min-w-0">
						<PopoverTitle className="break-words">{title}</PopoverTitle>
						<PopoverDescription className="text-xs">
							{spoofed ? `${domain} didn't confirm it sent this.` : "The domain confirmed this message is theirs."}
						</PopoverDescription>
						{m.auth ? (
							<button type="button" className="mt-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setDetails(!details)}>
								{details ? "Hide details" : "Details"}
							</button>
						) : null}
					</div>
				</div>
				{details && m.auth ? (
					<ul className="mt-3 flex flex-col gap-2 border-t pt-3 text-xs">
						{AUTH_CHECKS.map((c) => {
							const result = m.auth?.[c.key] ?? null;
							const state = result === "pass" ? "pass" : result === null || result === "none" ? "none" : "fail";
							const Icon = state === "pass" ? CheckIcon : state === "fail" ? XIcon : MinusIcon;
							return (
								<li key={c.key} className="grid grid-cols-[0.875rem_1fr_auto] items-center gap-2">
									<Icon className={cn("size-3.5", state === "pass" ? "text-emerald-500" : state === "fail" ? "text-destructive" : "text-muted-foreground")} />
									<span className={cn(state === "none" && "text-muted-foreground")}>{c[state]}</span>
									<span className="font-mono text-[10px] text-muted-foreground">{c.key.toUpperCase()}</span>
								</li>
							);
						})}
					</ul>
				) : null}
			</PopoverContent>
		</Popover>
	);
}

/** Each of the sender checks Email Routing stamps, in words. Anything but pass or none, softfail included, is a fail. */
const AUTH_CHECKS = [
	{ key: "spf", pass: "Sent from an approved server", fail: "Sent from a server it didn't approve", none: "No list of approved servers" },
	{ key: "dkim", pass: "Signed by the sender", fail: "Its signature doesn't check out", none: "Not signed" },
	{ key: "dmarc", pass: "Matches the From address", fail: "Doesn't match the From address", none: "No policy for the From address" },
] as const;

const domainOf = (address: string) => address.split("@").at(-1) ?? address;

function Message(props: {
	mailboxId: string;
	message: ThreadMessage;
	/** Sent from an address in view; see ThreadView. */
	outgoing: boolean;
	/** The message it answers, when that isn't the one above it. */
	replyingTo?: MessageDetail;
	onReply: (all: boolean) => void;
	onForward: () => void;
}) {
	const m = props.message;
	const qc = useQueryClient();
	// A layout parent may be an older ancestor. Only fold when the direct parent is here; otherwise the quote
	// may be all there is of it. Forwards keep what they carry.
	const fold = m.hasDirectParent && !isForward(m.subject);
	const files = m.attachments.filter((a) => !a.inline);
	const fileUrl = (a: AttachmentMeta) => `${messageUrl(props.mailboxId, m.id)}/attachments/${a.id}/${encodeURIComponent(a.filename)}`;
	// Kept after closing, so the viewer can animate out.
	const [viewing, setViewing] = useState<{ file: AttachmentMeta; kind: PreviewKind; open: boolean } | null>(null);
	/** Previews what the browser can show; downloads the rest. */
	const openFile = (a: AttachmentMeta) => {
		const shown = preview(a);
		if (shown) setViewing({ file: a, kind: shown.kind, open: true });
		else window.location.assign(`${fileUrl(a)}?download=1`);
	};
	// The cards in our own sent mail link to the recipients' page. Here, open the file in place instead: some
	// browsers (embedded ones especially) would replace the app with that page, which has no way back.
	const openLinked = (href: string) => {
		const token = /^\/f\/[^/]+\/([\w-]{22})$/.exec(new URL(href).pathname)?.[1];
		const file = token ? files.find((a) => a.link?.token === token) : undefined;
		if (file) openFile(file);
		return file !== undefined;
	};
	const share = useMutation({
		mutationFn: (v: { attachmentId: string; shared: boolean }) => api.shareLink(props.mailboxId, m.id, v.attachmentId, v.shared),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});

	const canBlock = useCanBlock(m.from.address);
	const [blocking, setBlocking] = useState(false);
	const actions = (
		<div className="-my-1 flex shrink-0 items-center">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button variant="ghost" size="icon-sm" aria-label="Reply" className="text-muted-foreground" onClick={() => props.onReply(false)}>
							<ReplyIcon />
						</Button>
					}
				/>
				<TooltipContent>Reply</TooltipContent>
			</Tooltip>
			<DropdownMenu>
				<DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More" className="text-muted-foreground" />}>
					<EllipsisIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-44">
					<DropdownMenuItem onClick={() => props.onReply(true)}>
						<ReplyAllIcon />
						Reply all
					</DropdownMenuItem>
					<DropdownMenuItem onClick={props.onForward}>
						<ForwardIcon />
						Forward
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem render={<a href={`${messageUrl(props.mailboxId, m.id)}/raw`} />}>
						<DownloadIcon />
						Download .eml
					</DropdownMenuItem>
					{canBlock && m.direction === "in" ? (
						<DropdownMenuItem variant="destructive" onClick={() => setBlocking(true)}>
							<BanIcon />
							Block sender
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{canBlock && m.direction === "in" ? <BlockSender address={m.from.address} open={blocking} onOpenChange={setBlocking} /> : null}
		</div>
	);

	// Theirs read like a thread, full width beside their avatar; yours are bubbles on the right, so your side of the
	// conversation shows at a glance.
	return (
		<article
			className={
				props.outgoing
					? // HTML bodies are frames, which can't size to their text, so bubbles take a set share of the width.
						"ml-auto flex w-[88%] min-w-0 flex-col items-end gap-1.5 py-2.5 lg:w-[72%]"
					: "grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 rounded-xl py-3"
			}
		>
			{props.outgoing ? null : <Avatar message={m} />}
			<div className={cn("flex min-w-0 items-start gap-2", props.outgoing && "max-w-full self-stretch")}>
				<MessageHeader message={m} outgoing={props.outgoing} replyingTo={props.replyingTo} />
				{actions}
			</div>
			<div
				className={cn(
					props.outgoing ? "w-full rounded-2xl bg-blue-500/15 px-4 py-3" : "col-span-2 pt-1 md:col-span-1 md:col-start-2",
					// Plain text reads best at about 70 characters a line; HTML mail lays itself out.
					!m.hasHtml && !props.outgoing && "max-w-[70ch]",
				)}
			>
				{props.outgoing ? <Undelivered mailboxId={props.mailboxId} message={m} /> : null}
				<Triage mailboxId={props.mailboxId} message={m} />
				{m.hasHtml ? (
					<HtmlBody src={`${messageUrl(props.mailboxId, m.id)}/body`} fold={fold} onLink={openLinked} />
				) : (
					<TextBody text={m.text ?? ""} fold={fold} />
				)}
				{files.length ? (
					<ul className={cn("mt-3 flex flex-wrap gap-2", props.outgoing && "justify-end")}>
						{files.map((a) => {
							const Icon = a.link ? (a.link.shared ? LinkIcon : Link2OffIcon) : PaperclipIcon;
							const label = (
								<>
									<Icon />
									{a.filename} <span className="text-muted-foreground">{formatBytes(a.size)}</span>
								</>
							);
							return (
								<li key={a.id} className="flex items-center gap-0.5">
									{/* Opens in the viewer when the browser can show it; otherwise a plain download link. */}
									{preview(a) ? (
										<Button variant="outline" size="sm" onClick={() => openFile(a)}>
											{label}
										</Button>
									) : (
										<a href={`${fileUrl(a)}?download=1`} className={buttonVariants({ variant: "outline", size: "sm" })}>
											{label}
										</a>
									)}
									{a.link ? (
										<Tooltip>
											<TooltipTrigger
												render={
													<Button
														variant="ghost"
														size="sm"
														className="text-muted-foreground"
														disabled={share.isPending}
														onClick={() => share.mutate({ attachmentId: a.id, shared: !a.link?.shared })}
													>
														{a.link.shared ? "Stop sharing" : "Share again"}
													</Button>
												}
											/>
											<TooltipContent>
												{a.link.shared ? "The link stops working until you share it again" : "The same link works again"}
											</TooltipContent>
										</Tooltip>
									) : null}
								</li>
							);
						})}
					</ul>
				) : null}
				{viewing ? (
					<FileViewer
						file={viewing.file}
						kind={viewing.kind}
						url={fileUrl(viewing.file)}
						open={viewing.open}
						onOpenChange={(open) => setViewing({ ...viewing, open })}
					/>
				) : null}
			</div>
		</article>
	);
}

/** Who sent it, to whom, and when, like a letter's heading. */
function MessageHeader(props: { message: MessageDetail; outgoing: boolean; replyingTo?: MessageDetail }) {
	const m = props.message;
	const date = new Date(m.date);
	return (
		<div className={cn("flex min-w-0 flex-1 flex-col gap-0.5", props.outgoing && "items-end")}>
			<span className={cn("flex w-full min-w-0 items-baseline gap-2", props.outgoing && "justify-end")}>
				<span className="truncate text-[15px] font-semibold">{m.from.name || m.from.address}</span>
				{props.replyingTo ? (
					<span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
						<ReplyIcon className="size-3" />
						{props.replyingTo.from.name || props.replyingTo.from.address}
					</span>
				) : null}
				{props.outgoing ? <DeliveryBadge message={m} /> : null}
				<time dateTime={date.toISOString()} className={cn("shrink-0 text-xs text-muted-foreground", !props.outgoing && "ml-auto")}>
					{letterDate(date)}
				</time>
			</span>
			<span className="max-w-full truncate text-sm text-muted-foreground" title={recipientsLine(m)}>
				{toLine(m)}
			</span>
		</div>
	);
}

/** "Sat, Oct 18, 9:12 AM", with the year once it isn't this one: a letter's date, without the seconds. */
function letterDate(d: Date): string {
	const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
	return d.toLocaleString(undefined, { weekday: "short", year, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** "to Maya Chen, Bo": who it went to, by name. The full addresses are in recipientsLine(), on hover. */
function toLine(m: MessageDetail): string {
	const names = [...m.to, ...m.cc].map((a) => a.name || a.address);
	return names.length ? `to ${names.join(", ")}` : "";
}

/** Gmail's "•••": shows or hides the quoted history folded off the end of a reply. */
function QuoteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const label = open ? "Hide quoted text" : "Show quoted text";
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button variant="secondary" size="xs" className="mt-2 h-4 px-1.5" aria-label={label} aria-expanded={open} onClick={onToggle}>
						<EllipsisIcon />
					</Button>
				}
			/>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

function TextBody({ text, fold }: { text: string; fold: boolean }) {
	const [showQuote, setShowQuote] = useState(false);
	const { body, quote } = fold ? splitQuote(text) : { body: text, quote: "" };
	return (
		<>
			<pre className="font-sans text-[15px] leading-relaxed break-words whitespace-pre-wrap">{body}</pre>
			{/* Below the quote once shown, like HTML bodies, whose toggle sits under the frame. */}
			{quote && showQuote ? <pre className="mt-4 font-sans break-words whitespace-pre-wrap text-muted-foreground">{quote}</pre> : null}
			{quote ? <QuoteToggle open={showQuote} onToggle={() => setShowQuote(!showQuote)} /> : null}
		</>
	);
}

/** Why inbound mail is in Spam, Gmail-style, and the way out for this message, which also trusts its sender. */
function SpamReason(props: { mailboxId: string; message: MessageDetail }) {
	const qc = useQueryClient();
	const notSpam = useMutation({
		mutationFn: () => api.judge(props.mailboxId, props.message.id, "trusted"),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	const { danger, reason, settings } = spamReason(props.message);
	return (
		<div className={cn("mb-3 flex items-start gap-2 rounded-lg px-3 py-2", danger ? "bg-destructive/10" : "bg-muted")}>
			<OctagonAlertIcon className={cn("mt-0.5 size-4 shrink-0", danger ? "text-destructive" : "text-muted-foreground")} />
			<div className="min-w-0 flex-1">
				<p className={cn("font-medium", danger && "text-destructive")}>Why it's in Spam</p>
				<p className="text-xs break-words text-muted-foreground">
					{notSpam.error ? errorMessage(notSpam.error) : reason}
					{settings && !notSpam.error ? (
						<>
							{" "}
							<Link to="/settings/spam" className="underline underline-offset-2 hover:text-foreground">
								Change where it goes
							</Link>
						</>
					) : null}
				</p>
			</div>
			<Button variant="outline" size="xs" disabled={notSpam.isPending || notSpam.isSuccess} onClick={() => notSpam.mutate()}>
				{notSpam.isPending ? <Spinner className="size-3" /> : <InboxIcon />}
				Not spam
			</Button>
		</div>
	);
}

/** Inbound mail the filter held back says why, with the way out. Nothing otherwise. */
function Triage(props: { mailboxId: string; message: MessageDetail }) {
	if (props.message.direction !== "in") return null;
	if (props.message.verdict?.kind === "spoofed") return <Forged {...props} />;
	if (props.message.labels.includes("spam")) return <SpamReason {...props} />;
	if (props.message.labels.includes("screener")) return <Screening {...props} />;
	return null;
}

/**
 * A first-time sender waiting in the Screener: let them in, or send them to Spam. Either answers for this message's
 * sender only, and, when their address is verified, for all their mail.
 */
function Screening(props: { mailboxId: string; message: MessageDetail }) {
	const qc = useQueryClient();
	const decide = useMutation({
		mutationFn: (letIn: boolean) => api.judge(props.mailboxId, props.message.id, letIn ? "trusted" : "spam"),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	const { from, verdict, senderVerified } = props.message;
	const busy = decide.isPending || decide.isSuccess;
	return (
		// Phones put the choice on a row of its own, under who's asking.
		<div className="mb-3 flex flex-wrap items-start gap-2 rounded-lg bg-muted px-3 py-2">
			<UserRoundCheckIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
			<div className="min-w-0 flex-1">
				<p className="font-medium break-words">First mail from {from.address}</p>
				{decide.error ? (
					<p className="text-xs break-words text-muted-foreground">{errorMessage(decide.error)}</p>
				) : verdict?.kind === "unchecked" ? (
					<p className="text-xs text-muted-foreground">It couldn't be checked for spam.</p>
				) : null}
			</div>
			<div className="flex shrink-0 gap-1.5 max-md:basis-full max-md:pl-6">
				<Tooltip>
					<TooltipTrigger
						render={
							<Button variant="outline" size="xs" disabled={busy} onClick={() => decide.mutate(true)}>
								{decide.isPending && decide.variables ? <Spinner className="size-3" /> : <InboxIcon />}
								Let in
							</Button>
						}
					/>
					<TooltipContent>
						{senderVerified ? "Their mail goes to your inbox from now on" : "Moves this message. Their address can't be verified, so their next mail waits here too"}
					</TooltipContent>
				</Tooltip>
				<Button variant="ghost" size="xs" disabled={busy} onClick={() => decide.mutate(false)}>
					{decide.isPending && !decide.variables ? <Spinner className="size-3" /> : <OctagonAlertIcon />}
					Spam
				</Button>
			</div>
		</div>
	);
}

/**
 * Mail that failed its sender's checks, wherever it is: let out of Spam, its From may still be anyone. The way out
 * moves this message only, since a forged sender has no standing to judge.
 */
function Forged(props: { mailboxId: string; message: MessageDetail }) {
	const qc = useQueryClient();
	const inSpam = props.message.labels.includes("spam");
	const move = useMutation({
		mutationFn: () => api.judge(props.mailboxId, props.message.id, inSpam ? "trusted" : "spam"),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	const domain = domainOf(props.message.from.address);
	return (
		<div className="mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2">
			<TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
			<div className="min-w-0 flex-1">
				<p className="font-medium break-words text-destructive">This may not be from {domain}</p>
				<p className="text-xs break-words text-muted-foreground">
					{move.error ? errorMessage(move.error) : `${domain} didn't confirm it sent this. Don't click its links or reply with personal info.`}
				</p>
			</div>
			{/* It stays after either move, so the button flips rather than staying spent. */}
			<Button variant="outline" size="xs" disabled={move.isPending} onClick={() => move.mutate()}>
				{move.isPending ? <Spinner className="size-3" /> : inSpam ? <InboxIcon /> : <OctagonAlertIcon />}
				{inSpam ? "Not spam" : "Spam"}
			</Button>
		</div>
	);
}

/** Mail that may be out to get you reads as a warning. */
/** `settings`: where it went is a setting, so the banner says where to change it. */
function spamReason({ from, verdict }: MessageDetail): { danger: boolean; reason: string; settings?: boolean } {
	switch (verdict?.kind) {
		case "marked":
			return { danger: false, reason: `Earlier mail from ${from.address} was marked as spam.` };
		case "unchecked":
			return { danger: false, reason: "It couldn't be checked, so it waits here instead of your inbox." };
		case "checked":
			if (verdict.category === "phishing") return { danger: true, reason: "It looks like phishing: it may be after your password, money, or data." };
			if (verdict.category === "outreach" && verdict.bySetting) return { danger: false, reason: "It looks like cold outreach: a stranger pitching, recruiting, or asking for a meeting.", settings: true };
			if (verdict.category === "spam") return { danger: false, reason: "It looks like marketing you didn't ask for, or a scam." };
			return { danger: false, reason: "It was marked as spam." };
		default:
			return { danger: false, reason: "It was marked as spam." };
	}
}

const RECIPIENTS = new Intl.ListFormat(undefined, { type: "conjunction" });

/** A sent message that didn't make it: who it missed, why, and a way to send it again to just them. Nothing otherwise. */
function Undelivered(props: { mailboxId: string; message: MessageDetail }) {
	const qc = useQueryClient();
	const retry = useMutation({
		mutationFn: () => api.retry(props.mailboxId, props.message.id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	const { delivery } = props.message;
	if (!delivery || !RETRYABLE.has(delivery.status)) return null;
	const { undelivered, detail } = delivery;
	const reason = retry.error ? errorMessage(retry.error) : detail;
	return (
		<div className="mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2">
			<CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
			<div className="min-w-0 flex-1">
				<p className="font-medium text-destructive">{undelivered.length ? `Not delivered to ${RECIPIENTS.format(undelivered)}` : "Not sent"}</p>
				{reason ? <p className="text-xs break-words text-muted-foreground">{reason}</p> : null}
			</div>
			<Button variant="outline" size="xs" disabled={retry.isPending || retry.isSuccess} onClick={() => retry.mutate()}>
				{retry.isPending ? <Spinner className="size-3" /> : <RotateCwIcon />}
				Retry
			</Button>
		</div>
	);
}

/**
 * Email HTML renders in a sandboxed iframe: no scripts (sandbox + CSP), same-origin only so we
 * can size it and so inline cid: images authenticate. Remote images stay blocked until asked.
 * Mail that sets no colours of its own takes the theme's; the rest keeps the look it was designed
 * for, on a white sheet.
 */
function HtmlBody({
	src,
	fold,
	onLink,
}: {
	src: string;
	/** Folds the quote ending a reply (findQuote()). */
	fold: boolean;
	/** Gets each link click first; returns true to keep it in the app. */
	onLink: (href: string) => boolean;
}) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [images, setImages] = useState(false);
	const [height, setHeight] = useState(48);
	const [hasBlocked, setHasBlocked] = useState(false);
	const [plain, setPlain] = useState(false);
	const [hasQuote, setHasQuote] = useState(false);
	const [showQuote, setShowQuote] = useState(false);
	const isDark = useSelector(appearance, (s) => s.isDark);
	const theme = useSelector(appearance, (s) => s.active);
	// Each load (showing images reloads the frame) brings a new document to listen to.
	const [doc, setDoc] = useState<Document | null>(null);

	const onClick = useEffectEvent((e: MouseEvent) => {
		for (const target of e.composedPath()) {
			if (!("href" in target) || typeof target.href !== "string") continue;
			if (onLink(target.href)) e.preventDefault();
			return;
		}
	});
	useEffect(() => {
		if (!doc) return;
		doc.addEventListener("click", onClick);
		return () => doc.removeEventListener("click", onClick);
	}, [doc]);

	const measure = (doc: Document) => {
		const frame = ref.current;
		if (!frame) return;
		const scroller = doc.scrollingElement ?? doc.documentElement;
		// Mail laid out wider than the frame (a newsletter's 600px table, on a phone) shrinks to fit, like Gmail's,
		// rather than scrolling sideways.
		doc.documentElement.style.zoom = "";
		const fit = frame.clientWidth / scroller.scrollWidth;
		if (fit < 1) doc.documentElement.style.zoom = String(fit);
		// Mail without a doctype renders in quirks mode, where the body stretches to fill the frame: shrink the frame
		// first, or it could only ever grow (and hiding a quote again wouldn't give its space back).
		frame.style.height = "0px";
		// The document's own height, margins included, in either mode.
		const next = scroller.scrollHeight + 4;
		frame.style.height = `${next}px`;
		setHeight(next);
	};
	// A new width (a phone turned sideways, the sidebar folded) reflows the mail, so it's fitted and measured again.
	const onResize = useEffectEvent((doc: Document) => measure(doc));
	useEffect(() => {
		const frame = ref.current;
		if (!doc || !frame) return;
		let width = frame.clientWidth;
		const observer = new ResizeObserver(() => {
			if (frame.clientWidth === width) return;
			width = frame.clientWidth;
			onResize(doc);
		});
		observer.observe(frame);
		return () => observer.disconnect();
	}, [doc]);
	const onLoad = () => {
		const doc = ref.current?.contentDocument;
		if (!doc) return;
		// The quote is marked and hidden by a rule keyed on the root, so showing it is one attribute.
		const quote = fold ? findQuote(doc) : [];
		if (quote.length > 0) {
			const style = doc.createElement("style");
			style.textContent = "html:not([data-magnus-show-quote]) [data-magnus-quote] { display: none !important; }";
			doc.head.append(style);
			for (const el of quote) el.setAttribute("data-magnus-quote", "");
			doc.documentElement.toggleAttribute("data-magnus-show-quote", showQuote);
		}
		setHasQuote(quote.length > 0);
		measure(doc);
		setHasBlocked(doc.querySelector("img[data-blocked-src]") !== null);
		setPlain(!setsColors(doc));
		setDoc(doc);
	};
	// Before paint, so plain mail never shows dark text on a dark card. Reruns when the theme changes, to pick up its text colour.
	useLayoutEffect(() => {
		const root = doc?.documentElement;
		if (!plain || !root || !ref.current) return;
		root.style.setProperty("color-scheme", isDark ? "dark" : "light");
		root.style.setProperty("color", getComputedStyle(ref.current).color);
	}, [doc, plain, isDark, theme]);

	return (
		<div>
			{hasBlocked && !images ? (
				<Button variant="secondary" size="xs" onClick={() => setImages(true)} className="mb-2">
					<ImageOffIcon />
					Remote images blocked · Show images
				</Button>
			) : null}
			<iframe
				ref={ref}
				title="Message body"
				src={images ? `${src}?images=1` : src}
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				onLoad={onLoad}
				style={{ height }}
				// Hidden until loaded, so a dark theme doesn't flash a white sheet at plain mail.
				className={cn("w-full border-0", !doc && "invisible", !plain && "rounded-md bg-white")}
			/>
			{hasQuote && doc ? (
				<QuoteToggle
					open={showQuote}
					onToggle={() => {
						doc.documentElement.toggleAttribute("data-magnus-show-quote", !showQuote);
						setShowQuote(!showQuote);
						measure(doc);
					}}
				/>
			) : null}
		</div>
	);
}

/** Whether an email styles its own colours anywhere. False positives only cost a white sheet. */
const setsColors = (doc: Document) =>
	doc.querySelector("[bgcolor], [background], [text], font[color], [style*='color' i], [style*='background' i]") !== null ||
	Array.from(doc.querySelectorAll("style")).some((s) => /color|background/i.test(s.textContent));

/** How a sent message is getting on, as an icon: what each status means is in its tooltip. Nothing once it's gone out. */
const DELIVERY: Partial<Record<DeliveryStatus, { Icon: LucideIcon; tone: string; label: string }>> = {
	queued: { Icon: ClockIcon, tone: "text-amber-600 dark:text-amber-400", label: "Waiting to send" },
	sending: { Icon: ClockIcon, tone: "text-amber-600 dark:text-amber-400", label: "Sending" },
	deferred: { Icon: ClockIcon, tone: "text-amber-600 dark:text-amber-400", label: "Delayed: their server asked to try again later" },
	bounced: { Icon: CircleAlertIcon, tone: "text-destructive", label: "Bounced" },
	failed: { Icon: CircleAlertIcon, tone: "text-destructive", label: "Couldn't send" },
	rejected: { Icon: CircleAlertIcon, tone: "text-destructive", label: "Rejected by their server" },
	complained: { Icon: CircleAlertIcon, tone: "text-destructive", label: "They marked it as spam" },
	cancelled: { Icon: BanIcon, tone: "text-muted-foreground", label: "Cancelled" },
};

function DeliveryBadge({ message }: { message: MessageDetail }) {
	const shown = message.delivery && DELIVERY[message.delivery.status];
	if (!message.delivery || !shown) return null;
	const { Icon, tone, label } = shown;
	return (
		<Tooltip>
			<TooltipTrigger render={<span role="img" aria-label={label} className={cn("inline-flex shrink-0 self-center", tone)} />}>
				<Icon className="size-3.5" />
			</TooltipTrigger>
			<TooltipContent>
				{label}
				{message.delivery.detail ? `. ${message.delivery.detail}` : ""}
			</TooltipContent>
		</Tooltip>
	);
}

/** "to Ann · cc Bo · bcc Cy", naming only the fields it has. Received mail never says who was Bcc'd. */
function recipientsLine(m: MessageDetail): string {
	const fields = [["to", m.to], ["cc", m.cc], ["bcc", m.bcc]] as const;
	return fields
		.filter(([, list]) => list.length > 0)
		.map(([field, list]) => `${field} ${formatList(list)}`)
		.join(" · ");
}

const signatureOf = (from: string, ctx: AnswerContext) => ctx.identities.find((i) => i.address === from)?.signature ?? null;

function replyDraft(m: MessageDetail, all: boolean, ctx: AnswerContext): Draft {
	const ours = new Set(ctx.identities.map((i) => i.address.toLowerCase()));
	const isOurs = (a: Address) => ours.has(a.address.toLowerCase());
	const recipients = [...m.to, ...m.cc];
	const from = answerFrom(m, ctx);
	const { to: primary, bcc } = replyRecipients(m, ctx.outgoing);
	const extra = all ? recipients.filter((a) => !isOurs(a) && !primary.some((p) => p.address === a.address)) : [];
	const signature = signatureOf(from, ctx);
	return {
		mailboxId: ctx.mailboxId,
		from,
		to: primary,
		cc: extra,
		bcc,
		subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
		text: withSignature(quote(m), null, signature),
		attachments: [],
		replyToMessageId: m.id,
	};
}

/** Forwards inline with the original's files, which can be removed in the composer. The signature ends the note. */
function forwardDraft(m: MessageDetail, ctx: AnswerContext): Draft {
	const from = answerFrom(m, ctx);
	return {
		mailboxId: ctx.mailboxId,
		from,
		to: [],
		cc: [],
		bcc: [],
		subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
		text: withSignature("", null, signatureOf(from, ctx)),
		attachments: [],
		forward: { message: m, files: m.attachments.filter((a) => !a.inline) },
	};
}
