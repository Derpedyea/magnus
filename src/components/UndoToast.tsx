import type { SendQueued } from "#shared";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "@/components/ui/toast-manager";
import { api, errorMessage } from "../api";
import { openDraft } from "../compose";
import { currentSession } from "../session";
import type { Draft } from "./Composer";

/** Shows a send while it waits in the Mailbox DO's outbox; Undo pulls it back out and reopens the draft. */
export function toastUndoSend(queued: SendQueued, draft: Draft, qc: QueryClient) {
	const session = currentSession();
	let undoing = false;
	const id = toast.add({
		title: <Countdown until={queued.sendAt} />,
		// Hovering pauses toast timers, but the outbox won't wait: `sent` below ends the undo window instead.
		timeout: 0,
		actionProps: {
			children: "Undo",
			onClick: () => {
				if (undoing) return;
				undoing = true;
				window.clearTimeout(sent);
				api.cancel(draft.mailboxId, queued.id).then(
					() => {
						if (session !== currentSession()) return;
						void qc.invalidateQueries({ queryKey: ["mail"] });
						toast.close(id);
						openDraft(draft, true);
					},
					(error: unknown) => toast.update(id, { title: errorMessage(error), type: "error", actionProps: undefined, timeout: 5000 }),
				);
			},
		},
	});
	const sent = window.setTimeout(() => toast.update(id, { title: "Sent to outbox", actionProps: undefined, timeout: 1500 }), queued.sendAt - Date.now());
}

function Countdown({ until }: { until: number }) {
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		const tick = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(tick);
	}, []);
	return `Sending in ${Math.max(1, Math.ceil((until - now) / 1000))}s`;
}
