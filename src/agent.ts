import type { AgentMessage, PendingAction } from "#shared";
import { MAX_AGENT_MESSAGES } from "#shared/schemas";
import type { QueryClient } from "@tanstack/react-query";
import { createStore } from "@tanstack/react-store";
import { api, errorMessage } from "./api";

// The assistant's side panel (components/AgentPanel.tsx): whether it's open, and the conversation in it. Stores rather
// than state, so a question still being answered survives the panel closing, which on a phone unmounts it.

const OPEN = "agent-open";
const CHAT = "agent-chat";

/** Open or not, kept across visits. */
export const agentOpen = createStore(localStorage.getItem(OPEN) === "1");
export function toggleAgent(open = !agentOpen.state) {
	if (open) localStorage.setItem(OPEN, "1");
	else localStorage.removeItem(OPEN);
	agentOpen.setState(() => open);
}

interface Chat {
	messages: AgentMessage[];
	/** What the agent waits for the person to approve or decline. */
	pending: PendingAction | null;
	waiting: boolean;
	error: string | null;
}

/** The conversation open beside the panel, which the agent is told of. */
export type AgentContext = { mailboxId: string; threadId: string } | null;

const EMPTY: Chat = { messages: [], pending: null, waiting: false, error: null };

/** Kept for this tab, so a reload doesn't lose it, and no longer: it quotes mail. */
function restore(): Chat {
	try {
		const saved = JSON.parse(sessionStorage.getItem(CHAT) ?? "null") as Pick<Chat, "messages" | "pending"> | null;
		return saved ? { ...EMPTY, messages: saved.messages, pending: saved.pending } : EMPTY;
	} catch {
		return EMPTY;
	}
}

export const agentChat = createStore<Chat>(restore());
agentChat.subscribe(() => {
	const { messages, pending } = agentChat.state;
	if (messages.length === 0) {
		sessionStorage.removeItem(CHAT);
		return;
	}
	// Thrown here, a full quota would come out of setState(), and stop whatever set it from asking: past it, the end of
	// the conversation is kept, or none.
	try {
		sessionStorage.setItem(CHAT, JSON.stringify({ messages, pending }));
	} catch {
		try {
			sessionStorage.setItem(CHAT, JSON.stringify({ messages: recent(messages), pending }));
		} catch {
			sessionStorage.removeItem(CHAT);
		}
	}
});

/** Counts conversations, so an answer to one that's gone (New chat, signing out) is dropped. */
let generation = 0;

/** Starts over. Signing out does too (endSession()), so the next person can't scroll back through it. */
export function newChat() {
	generation++;
	agentChat.setState(() => EMPTY);
}

/** Asks the agent. Asking something else while it waits for approval declines what it asked. */
export function ask(qc: QueryClient, text: string, context: AgentContext) {
	const { pending, messages, waiting } = agentChat.state;
	if (waiting) return;
	agentChat.setState((s) => ({ ...s, messages: [...messages, ...(pending ? [declined(pending)] : []), { role: "user", content: text }], pending: null }));
	void converse(qc, context);
}

/** Does what the agent asked to, then lets it go on. */
export async function approve(qc: QueryClient, context: AgentContext) {
	const { pending } = agentChat.state;
	if (!pending || agentChat.state.waiting) return;
	const at = generation;
	agentChat.setState((s) => ({ ...s, waiting: true, error: null }));
	try {
		const { message } = await api.approveAgent({ id: pending.id, name: pending.name, args: pending.args });
		if (at !== generation) return;
		agentChat.setState((s) => ({ ...s, messages: [...s.messages, message], pending: null, waiting: false }));
		void qc.invalidateQueries({ queryKey: ["mail"] });
	} catch (error) {
		if (at === generation) agentChat.setState((s) => ({ ...s, waiting: false, error: errorMessage(error) }));
		return;
	}
	await converse(qc, context);
}

/** Tells the agent no, and lets it answer that. */
export function decline(qc: QueryClient, context: AgentContext) {
	const { pending } = agentChat.state;
	if (!pending || agentChat.state.waiting) return;
	agentChat.setState((s) => ({ ...s, messages: [...s.messages, declined(pending)], pending: null }));
	void converse(qc, context);
}

/** Tries again what failed: the approval, if it waits still, or else the conversation. */
export const retry = (qc: QueryClient, context: AgentContext) => void (agentChat.state.pending ? approve(qc, context) : converse(qc, context));

function declined(pending: PendingAction): AgentMessage {
	return { role: "tool", toolCallId: pending.id, name: pending.name, content: "The user declined.", summary: `Rejected: ${pending.summary}` };
}

async function converse(qc: QueryClient, context: AgentContext) {
	const at = generation;
	agentChat.setState((s) => ({ ...s, waiting: true, error: null }));
	try {
		const reply = await api.agent({ messages: recent(agentChat.state.messages), context });
		if (at !== generation) return;
		agentChat.setState((s) => ({ ...s, messages: [...s.messages, ...reply.messages], pending: reply.pending, waiting: false }));
		if (reply.messages.some((m) => m.role === "tool")) void qc.invalidateQueries({ queryKey: ["mail"] });
	} catch (error) {
		if (at === generation) agentChat.setState((s) => ({ ...s, waiting: false, error: errorMessage(error) }));
	}
}

/** As much of the end of the conversation as the server takes, starting with a question, so no result loses its call. */
function recent(messages: AgentMessage[]): AgentMessage[] {
	const tail = messages.slice(-MAX_AGENT_MESSAGES);
	const start = tail.findIndex((m) => m.role === "user");
	if (start !== -1) return tail.slice(start);
	// One question's answer, approvals and all, can run longer: then it's the question, and its latest steps that fit, whole.
	const question = messages.findLastIndex((m) => m.role === "user");
	let from = messages.length - (MAX_AGENT_MESSAGES - 1);
	while (from < messages.length && messages[from]!.role !== "assistant") from++;
	return [...(question === -1 ? [] : [messages[question]!]), ...messages.slice(from)];
}
