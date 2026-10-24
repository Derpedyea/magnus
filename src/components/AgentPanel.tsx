import type { AgentMessage, AgentThread } from "#shared";
import { useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowUpIcon, FilterIcon, MailOpenIcon, SearchIcon, SparklesIcon, SquarePenIcon, TagIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/lib/use-mobile";
import { cn } from "@/lib/utils";
import { type AgentContext, agentChat, agentOpen, approve, ask, decline, newChat, retry, toggleAgent } from "../agent";
import { formatDate } from "../dates";

/**
 * Open as the app loads, left open from the last visit: its box doesn't take the keyboard from the mail's shortcuts
 * then. Opened since, it does.
 */
let leftOpen = agentOpen.state;

/** The assistant, beside the mail on wider screens and over it on a phone. */
export function AgentPanel() {
	const open = useSelector(agentOpen, (s) => s);
	const mobile = useIsMobile();
	useEffect(() => {
		if (!open) leftOpen = false;
	}, [open]);
	if (mobile) {
		return (
			<Sheet open={open} onOpenChange={(next) => toggleAgent(next)}>
				<SheetContent side="right" showCloseButton={false} aria-label="Assistant" className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-sm">
					<Chat mobile />
				</SheetContent>
			</Sheet>
		);
	}
	return open ? (
		<aside aria-label="Assistant" className="flex h-full w-96 shrink-0 flex-col border-l bg-background">
			<Chat mobile={false} />
		</aside>
	) : null;
}

/** What the tools did, by tool: what it looked at, or what it changed. */
const TOOL_ICONS: Record<string, ReactNode> = {
	search_mail: <SearchIcon />,
	list_threads: <MailOpenIcon />,
	read_thread: <MailOpenIcon />,
	mark_read: <MailOpenIcon />,
	list_labels: <TagIcon />,
	create_label: <TagIcon />,
	modify_threads: <TagIcon />,
};

function Chat({ mobile }: { mobile: boolean }) {
	const qc = useQueryClient();
	const { messages, pending, waiting, error } = useSelector(agentChat, (s) => s);
	const context = useAgentContext();
	const [text, setText] = useState("");
	const end = useRef<HTMLDivElement>(null);
	useEffect(() => {
		end.current?.scrollIntoView({ block: "end" });
	}, [messages.length, pending, waiting]);

	const send = () => {
		const question = text.trim();
		if (!question || waiting) return;
		ask(qc, question, context);
		setText("");
	};

	return (
		<>
			<header className="flex h-12 shrink-0 items-center gap-1 border-b px-3">
				<h2 className="mr-auto font-heading text-base font-semibold">Assistant</h2>
				{messages.length > 0 ? (
					<Tooltip>
						<TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="New chat" onClick={newChat} />}>
							<SquarePenIcon />
						</TooltipTrigger>
						<TooltipContent>New chat</TooltipContent>
					</Tooltip>
				) : null}
				<Button variant="ghost" size="icon-sm" aria-label="Close" onClick={() => toggleAgent(false)}>
					<XIcon />
				</Button>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="flex flex-col gap-3 p-3">
					{messages.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyMedia variant="icon"><SparklesIcon /></EmptyMedia>
								<EmptyTitle>Ask about your mail</EmptyTitle>
								<EmptyDescription>Find conversations, label or archive them, or write rules that file new mail. Anything that could lose mail waits for your OK.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						messages.map((m, i) => <Message key={i} message={m} mobile={mobile} />)
					)}
					{pending ? (
						<div className="border-l-2 border-primary pl-3">
							<p className="font-medium">{pending.summary}</p>
							{pending.threads?.length ? <Threads threads={pending.threads} mobile={mobile} /> : null}
							<div className="mt-3 flex gap-2">
								<Button size="sm" disabled={waiting} onClick={() => void approve(qc, context)}>Approve</Button>
								<Button size="sm" variant="outline" disabled={waiting} onClick={() => decline(qc, context)}>Reject</Button>
							</div>
						</div>
					) : null}
					{waiting ? (
						<p className="flex items-center gap-2 text-muted-foreground">
							<Spinner className="size-3.5" />
							Thinking…
						</p>
					) : null}
					{error ? (
						<div role="alert" className="flex items-center gap-2 text-xs text-destructive">
							<span className="flex-1">{error}</span>
							<Button variant="outline" size="xs" onClick={() => retry(qc, context)}>Try again</Button>
						</div>
					) : null}
					<div ref={end} />
				</div>
			</div>

			<form
				className="border-t p-3"
				onSubmit={(e) => {
					e.preventDefault();
					send();
				}}
			>
				<div className="relative">
					<Textarea
						autoFocus={!leftOpen}
						rows={1}
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							// Enter asks; Shift+Enter is a new line, and so is Enter while an input method is composing.
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								send();
							}
						}}
						placeholder={pending ? "Or say what to do instead" : "Ask about your mail"}
						aria-label="Ask the assistant"
						className="max-h-40 min-h-9 resize-none pr-10"
					/>
					<Button type="submit" size="icon-sm" aria-label="Ask" disabled={!text.trim() || waiting} className="absolute right-1 bottom-1">
						<ArrowUpIcon />
					</Button>
				</div>
			</form>
		</>
	);
}

function Message({ message: m, mobile }: { message: AgentMessage; mobile: boolean }) {
	if (m.role === "user") return <p className="ml-auto max-w-[85%] rounded-2xl bg-primary px-3 py-2 break-words whitespace-pre-wrap text-primary-foreground">{m.content}</p>;
	// Its calls show as what they did, below.
	if (m.role === "assistant") return m.content ? <p className="break-words whitespace-pre-wrap">{m.content}</p> : null;
	return (
		<div>
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
				{TOOL_ICONS[m.name] ?? <FilterIcon />}
				{m.summary}
			</p>
			{m.threads?.length ? <Threads threads={m.threads} mobile={mobile} /> : null}
		</div>
	);
}

/** Conversations a tool found or changed, to open beside the panel; on a phone, in place of it. */
function Threads({ threads, mobile }: { threads: AgentThread[]; mobile: boolean }) {
	const current = useParams({ strict: false, select: (p) => p.view });
	// The thread opens beside a list: Drafts and Failed have none.
	const view = current && current !== "drafts" && current !== "failed" ? current : "all";
	return (
		<ul className="mt-1.5 divide-y overflow-hidden rounded-lg border">
			{threads.map((t) => (
				<li key={`${t.mailboxId}/${t.id}`}>
					<Link
						to="/$view/$mailboxId/$threadId"
						params={{ view, mailboxId: t.mailboxId, threadId: t.id }}
						search={true}
						activeProps={{ className: "bg-accent" }}
						inactiveProps={{ className: "hover:bg-muted/50" }}
						className="block px-2.5 py-1.5 outline-none focus-visible:bg-accent"
						onClick={() => mobile && toggleAgent(false)}
					>
						<span className="flex items-baseline gap-2">
							<span className={cn("truncate", t.unreadCount > 0 && "font-semibold")}>{t.subject || "(no subject)"}</span>
							<time className="ml-auto shrink-0 text-xs text-muted-foreground">{formatDate(t.lastMessageAt)}</time>
						</span>
						<span className="block truncate text-xs text-muted-foreground">{t.participants.map((p) => p.name || p.address).join(", ")}</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

/** The conversation open in the mail view, if any, which the agent is told of so “this” means something. */
function useAgentContext(): AgentContext {
	const mailboxId = useParams({ strict: false, select: (p) => p.mailboxId });
	const threadId = useParams({ strict: false, select: (p) => p.threadId });
	return mailboxId && threadId ? { mailboxId, threadId } : null;
}
