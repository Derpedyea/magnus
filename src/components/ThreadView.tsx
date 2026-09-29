import { type Address, type AttachmentMeta, type DeliveryStatus, formatBytes, type MessageDetail, type PreviewKind, preview, RETRYABLE } from "#shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { ArchiveIcon, CircleAlertIcon, ImageOffIcon, InboxIcon, Link2OffIcon, LinkIcon, MailIcon, OctagonAlertIcon, PaperclipIcon, ReplyAllIcon, ReplyIcon, RotateCwIcon, StarIcon, StarOffIcon, Trash2Icon } from "lucide-react";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage, formatList, type Identity, messageUrl } from "../api";
import { openDraft, quote, withSignature } from "../compose";
import { useAccount, useScope } from "../hooks";
import { threadQuery } from "../queries";
import { appearance } from "../theme";
import { BlockSender } from "./BlockSender";
import type { Draft } from "./Composer";
import { FileViewer } from "./FileViewer";

const route = getRouteApi("/_app/_mail/$view/$mailboxId/$threadId");

export function ThreadView() {
	const { view, mailboxId, threadId } = route.useParams();
	const navigate = route.useNavigate();
	// Replies must be sent from the thread's own mailbox.
	const identities = useAccount().identities.filter((i) => i.mailboxId === mailboxId);
	const qc = useQueryClient();
	const { data } = useSuspenseQuery(threadQuery(mailboxId, threadId));
	const close = () => void navigate({ to: "/$view", params: { view }, search: true });
	const invalidate = () => qc.invalidateQueries({ queryKey: ["mail"] });

	const modify = useMutation({
		mutationFn: (v: { add?: string[]; remove?: string[] }) => api.modify(mailboxId, [threadId], v.add ?? [], v.remove ?? []),
		onSuccess: invalidate,
	});
	const markRead = useMutation({ mutationFn: (read: boolean) => api.markRead(mailboxId, [threadId], read), onSuccess: invalidate });

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

	const action = (icon: React.ReactNode, label: string, onClick: () => void) => (
		<Button variant="ghost" size="sm" onClick={onClick} className="text-muted-foreground">
			{icon}
			{label}
		</Button>
	);

	return (
		<article className="mx-auto max-w-4xl p-6">
			<div className="mb-4 flex flex-wrap items-center gap-1 border-b pb-3">
				{inInbox
					? action(<ArchiveIcon />, "Archive", () => (modify.mutate({ remove: ["inbox"] }), close()))
					: action(<InboxIcon />, "Move to inbox", () => modify.mutate({ add: ["inbox"], remove: ["trash", "spam"] }))}
				{action(<Trash2Icon />, "Trash", () => (modify.mutate({ add: ["trash"] }), close()))}
				{action(<OctagonAlertIcon />, "Spam", () => (modify.mutate({ add: ["spam"] }), close()))}
				{starred
					? action(<StarOffIcon />, "Unstar", () => modify.mutate({ remove: ["starred"] }))
					: action(<StarIcon />, "Star", () => modify.mutate({ add: ["starred"] }))}
				{action(<MailIcon />, "Mark unread", () => (markRead.mutate(false), close()))}
			</div>
			<h1 className="mb-6 font-heading text-xl font-semibold">{summary.subject}</h1>
			<div className="space-y-3">
				{messages.map((m, i) => (
					<Message
						key={m.id}
						mailboxId={mailboxId}
						message={m}
						outgoing={m.direction === "out" && inView(m.from.address)}
						defaultOpen={i === messages.length - 1 || !m.isRead}
						onReply={(all) =>
							openDraft(
								replyDraft(m, all, {
									mailboxId,
									identities,
									delivered: summary.addresses,
									outgoing: m.direction === "out" && inView(m.from.address),
									inView,
								}),
							)
						}
					/>
				))}
			</div>
		</article>
	);
}

function Message(props: {
	mailboxId: string;
	message: MessageDetail;
	/** Sent from an address in view; see ThreadView. */
	outgoing: boolean;
	defaultOpen: boolean;
	onReply: (all: boolean) => void;
}) {
	const m = props.message;
	const qc = useQueryClient();
	const [open, setOpen] = useState(props.defaultOpen);
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

	return (
		<Collapsible open={open} onOpenChange={setOpen} render={<Card size="sm" />}>
			<CardHeader>
				<CollapsibleTrigger className="-my-1 flex w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
					<span className="font-medium">{m.from.name || m.from.address}</span>
					{m.from.name ? <span className="truncate text-xs text-muted-foreground">{m.from.address}</span> : null}
					{props.outgoing ? <DeliveryBadge message={m} /> : null}
					<time className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(m.date).toLocaleString()}</time>
				</CollapsibleTrigger>
			</CardHeader>
			<CollapsibleContent render={<CardContent />}>
				<p className="pb-2 text-xs text-muted-foreground">
						to {formatList(m.to)}
						{m.cc.length ? ` · cc ${formatList(m.cc)}` : ""}
						{m.auth ? ` · spf ${m.auth.spf ?? "?"} · dkim ${m.auth.dkim ?? "?"} · dmarc ${m.auth.dmarc ?? "?"}` : ""}
				</p>
				{props.outgoing && m.delivery && RETRYABLE.has(m.delivery.status) ? (
					<Undelivered mailboxId={props.mailboxId} messageId={m.id} delivery={m.delivery} />
				) : null}
				{m.hasHtml ? (
					<HtmlBody src={`${messageUrl(props.mailboxId, m.id)}/body`} onLink={openLinked} />
				) : (
					<pre className="font-sans whitespace-pre-wrap">{m.text}</pre>
				)}
				{files.length ? (
					<ul className="mt-4 flex flex-wrap gap-2">
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
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => props.onReply(false)}>
						<ReplyIcon />
						Reply
					</Button>
					<Button variant="outline" size="sm" onClick={() => props.onReply(true)}>
						<ReplyAllIcon />
						Reply all
					</Button>
					<div className="ml-auto flex items-center">
						{m.direction === "in" ? <BlockSender address={m.from.address} /> : null}
						<a href={`${messageUrl(props.mailboxId, m.id)}/raw`} className={cn(buttonVariants({ variant: "link", size: "xs" }), "text-muted-foreground")}>
							Download .eml
						</a>
					</div>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

const RECIPIENTS = new Intl.ListFormat(undefined, { type: "conjunction" });

/** A sent message that didn't make it: who it missed, why, and a way to send it again to just them. */
function Undelivered(props: { mailboxId: string; messageId: string; delivery: NonNullable<MessageDetail["delivery"]> }) {
	const qc = useQueryClient();
	const retry = useMutation({
		mutationFn: () => api.retry(props.mailboxId, props.messageId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["mail"] }),
	});
	const { undelivered, detail } = props.delivery;
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
function HtmlBody({ src, onLink }: { src: string; /** Gets each link click first; returns true to keep it in the app. */ onLink: (href: string) => boolean }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [images, setImages] = useState(false);
	const [height, setHeight] = useState(48);
	const [hasBlocked, setHasBlocked] = useState(false);
	const [plain, setPlain] = useState(false);
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

	const onLoad = () => {
		const doc = ref.current?.contentDocument;
		if (!doc) return;
		// documentElement.scrollHeight never drops below the iframe's own height; measure the body.
		const margin = Number.parseFloat(getComputedStyle(doc.body).marginTop) + Number.parseFloat(getComputedStyle(doc.body).marginBottom);
		setHeight(Math.ceil(doc.body.scrollHeight + margin) + 4);
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
		</div>
	);
}

/** Whether an email styles its own colours anywhere. False positives only cost a white sheet. */
const setsColors = (doc: Document) =>
	doc.querySelector("[bgcolor], [background], [text], font[color], [style*='color' i], [style*='background' i]") !== null ||
	Array.from(doc.querySelectorAll("style")).some((s) => /color|background/i.test(s.textContent));

const DONE = "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
const WAITING = "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
const DELIVERY_TONES: Partial<Record<DeliveryStatus, string>> = { delivered: DONE, sent: DONE, queued: WAITING, sending: WAITING, deferred: WAITING };

function DeliveryBadge({ message }: { message: MessageDetail }) {
	if (!message.delivery) return null;
	const { status, detail } = message.delivery;
	const tone = DELIVERY_TONES[status];
	// Anything without a tone didn't make it.
	const badge = (
		<Badge variant={tone ? "secondary" : "destructive"} className={tone}>
			{status}
		</Badge>
	);
	if (!detail) return badge;
	return (
		<Tooltip>
			<TooltipTrigger render={badge} />
			<TooltipContent>{detail}</TooltipContent>
		</Tooltip>
	);
}

function replyDraft(
	m: MessageDetail,
	all: boolean,
	ctx: {
		mailboxId: string;
		identities: Identity[];
		/** The thread's own addresses, which catch mail that reached us via Bcc or a list. */
		delivered: string[];
		outgoing: boolean;
		inView: (address: string) => boolean;
	},
): Draft {
	const ours = new Set(ctx.identities.map((i) => i.address.toLowerCase()));
	const isOurs = (a: Address) => ours.has(a.address.toLowerCase());
	const recipients = [...m.to, ...m.cc];
	// Answer from the address being viewed when the message reached several of ours.
	const from = ctx.outgoing
		? m.from.address
		: (recipients.find((a) => isOurs(a) && ctx.inView(a.address))?.address ??
			recipients.find(isOurs)?.address ??
			ctx.delivered.find((a) => ours.has(a)) ??
			ctx.identities[0]?.address ??
			"");
	const primary = ctx.outgoing ? m.to : m.replyTo.length ? m.replyTo : [m.from];
	const extra = all ? recipients.filter((a) => !isOurs(a) && !primary.some((p) => p.address === a.address)) : [];
	const signature = ctx.identities.find((i) => i.address === from.toLowerCase())?.signature ?? null;
	return {
		mailboxId: ctx.mailboxId,
		from: from.toLowerCase(),
		to: primary,
		cc: extra,
		bcc: [],
		subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
		text: withSignature(quote(m), null, signature),
		attachments: [],
		replyToMessageId: m.id,
	};
}
