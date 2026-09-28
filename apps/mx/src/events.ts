import { getSenderMailboxes } from "@magnus/directory";
import type { DeliveryStatus, EmailSendingEvent } from "@magnus/shared";
import { mailbox } from "./mailbox";

const STATUS: Record<EmailSendingEvent["type"], DeliveryStatus> = {
	"cf.email.sending.message.delivered": "delivered",
	"cf.email.sending.message.deferred": "deferred",
	"cf.email.sending.message.bounced": "bounced",
	"cf.email.sending.message.failed": "failed",
	"cf.email.sending.message.rejected": "rejected",
	"cf.email.sending.message.complained": "complained",
};

/**
 * Email Sending lifecycle event → the mailbox that sent it.
 * Events carry the sender address, not our mailbox id, so offer the event to every mailbox
 * allowed to send as that address; the one holding the message id applies it.
 */
export async function handleDeliveryEvent(env: Env, event: EmailSendingEvent): Promise<void> {
	const status = STATUS[event.type];
	if (!status) return;
	const p = event.payload;
	const detail = p.bounce?.reason ?? p.rejection?.detail ?? p.failure?.reason ?? p.delivery.smtpResponse ?? null;

	for (const mailboxId of await getSenderMailboxes(env.DIRECTORY, p.sender)) {
		const applied = await mailbox(env, mailboxId).applyDeliveryEvent({
			providerMessageId: p.messageId,
			recipient: p.recipient,
			status,
			detail,
			at: Date.parse(event.metadata.eventTimestamp) || Date.now(),
		});
		if (applied) return;
	}
	console.warn(JSON.stringify({ msg: "delivery event for unknown message", messageId: p.messageId, sender: p.sender }));
}
