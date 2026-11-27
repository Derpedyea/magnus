import type { Draft } from "#shared/drafts";
import { createStore, useSelector } from "@tanstack/react-store";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ApiError, api, errorMessage } from "./api";
import { draftJournalKey } from "./draft-journal";
import { DraftSync } from "./draft-sync";
import type { DraftEntry } from "./draft-sync";
import { onSessionEnd } from "./session";
import { closeDraft, compose } from "./compose";

const DraftContext = createContext<ReturnType<typeof createDraftSync> | null>(null);

export function createDraftSync(userId: string, synced: () => void) {
	const store = createStore<DraftEntry[]>([]);
	const key = draftJournalKey(userId);
	// Once the session ends nothing writes the journal again, even a send failing after it (Composer's onError).
	let ended = false;
	const sync = new DraftSync({
		read: () => localStorage.getItem(key), write: (journal) => { if (!ended) localStorage.setItem(key, journal); },
		save: api.saveDraft, discard: api.discardDraft,
		uuid: () => crypto.randomUUID(), now: Date.now,
		after: (delay, run) => { const timer = window.setTimeout(run, delay); return () => window.clearTimeout(timer); },
		classify: (error) => ({ message: errorMessage(error), conflict: error instanceof ApiError && [409, 410].includes(error.status), retry: !(error instanceof ApiError) || error.status >= 500 || error.status === 429 }),
		changed: (entries) => store.setState(() => entries), synced,
		discarded: (id) => { if (compose.state?.draftId === id) closeDraft(compose.state.id); },
	});
	const endSession = () => {
		ended = true;
		sync.stop();
		try {
			localStorage.removeItem(key);
		} catch (error) {
			console.error("Couldn't clear the draft recovery journal", error);
		}
	};
	return { sync, store, endSession };
}

export function DraftProvider({ userId, children }: { userId: string; children: ReactNode }) {
	const qc = useQueryClient();
	const [context] = useState(() => createDraftSync(userId, () => void qc.invalidateQueries({ queryKey: ["drafts"] })));
	useEffect(() => {
		context.sync.start();
		const unsubscribeSession = onSessionEnd(context.endSession);
		const retry = () => { void context.sync.flushAll().catch((error: unknown) => console.error("Draft sync:", errorMessage(error))); };
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (context.store.state.some((entry) => entry.dirty || entry.request || entry.removing)) event.preventDefault();
		};
		const hidden = () => { if (document.visibilityState === "hidden") retry(); };
		window.addEventListener("online", retry);
		window.addEventListener("beforeunload", beforeUnload);
		document.addEventListener("visibilitychange", hidden);
		return () => {
			unsubscribeSession();
			window.removeEventListener("online", retry);
			window.removeEventListener("beforeunload", beforeUnload);
			document.removeEventListener("visibilitychange", hidden);
			context.sync.stop();
		};
	}, [context]);
	return <DraftContext.Provider value={context}>{children}</DraftContext.Provider>;
}

export function useDraftSync() {
	const context = useContext(DraftContext);
	if (!context) throw new Error("Drafts need a signed-in account");
	return context.sync;
}

export function useOptionalDraftSync() { return useContext(DraftContext)?.sync; }

export function useDraftEntries() {
	const context = useContext(DraftContext);
	if (!context) throw new Error("Drafts need a signed-in account");
	return useSelector(context.store, (entries) => entries);
}

export type { Draft };
