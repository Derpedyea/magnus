import type { Address, DeliveryStatus, MessageDetail } from "@magnus/shared";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { ArchiveIcon, ImageOffIcon, InboxIcon, MailIcon, OctagonAlertIcon, PaperclipIcon, ReplyAllIcon, ReplyIcon, StarIcon, StarOffIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, formatList, type Identity, messageUrl } from "../api";
import { openDraft } from "../compose";
import { useAccount, useScope } from "../hooks";
import { threadQuery } from "../queries";
import type { Draft } from "./Composer";

const route = getRouteApi("/_app/$view/$mailboxId/$threadId");

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
	const [open, setOpen] = useState(props.defaultOpen);
	const files = m.attachments.filter((a) => !a.inline);

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
				{m.hasHtml ? <HtmlBody src={`${messageUrl(props.mailboxId, m.id)}/body`} /> : <pre className="font-sans whitespace-pre-wrap">{m.text}</pre>}
				{files.length ? (
					<ul className="mt-4 flex flex-wrap gap-2">
						{files.map((a) => (
							<li key={a.id}>
								<a href={`${messageUrl(props.mailboxId, m.id)}/attachments/${a.id}?download=1`} className={buttonVariants({ variant: "outline", size: "sm" })}>
									<PaperclipIcon />
									{a.filename} <span className="text-muted-foreground">{Math.ceil(a.size / 1024)} KB</span>
								</a>
							</li>
						))}
					</ul>
				) : null}
				<div className="mt-4 flex items-center gap-2">
					<Button variant="outline" size="sm" onClick={() => props.onReply(false)}>
						<ReplyIcon />
						Reply
					</Button>
					<Button variant="outline" size="sm" onClick={() => props.onReply(true)}>
						<ReplyAllIcon />
						Reply all
					</Button>
					<a href={`${messageUrl(props.mailboxId, m.id)}/raw`} className={cn(buttonVariants({ variant: "link", size: "xs" }), "ml-auto text-muted-foreground")}>
						Download .eml
					</a>
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * Email HTML renders in a sandboxed iframe: no scripts (sandbox + CSP), same-origin only so we
 * can size it and so inline cid: images authenticate. Remote images stay blocked until asked.
 */
function HtmlBody({ src }: { src: string }) {
	const ref = useRef<HTMLIFrameElement>(null);
	const [images, setImages] = useState(false);
	const [height, setHeight] = useState(48);
	const [hasBlocked, setHasBlocked] = useState(false);

	const onLoad = () => {
		const doc = ref.current?.contentDocument;
		if (!doc) return;
		// documentElement.scrollHeight never drops below the iframe's own height; measure the body.
		const margin = Number.parseFloat(getComputedStyle(doc.body).marginTop) + Number.parseFloat(getComputedStyle(doc.body).marginBottom);
		setHeight(Math.ceil(doc.body.scrollHeight + margin) + 4);
		setHasBlocked(doc.querySelector("img[data-blocked-src]") !== null);
	};

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
				className="w-full border-0"
			/>
		</div>
	);
}

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
	const quoted = (m.text ?? "")
		.split("\n")
		.map((l) => `> ${l}`)
		.join("\n");
	return {
		mailboxId: ctx.mailboxId,
		from: from.toLowerCase(),
		to: formatList(primary),
		cc: formatList(extra),
		bcc: "",
		subject: /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
		text: `\n\nOn ${new Date(m.date).toLocaleString()}, ${m.from.name || m.from.address} wrote:\n${quoted}`,
		attachments: [],
		replyToMessageId: m.id,
	};
}
