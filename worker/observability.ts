import { type EmailSendingEvent, type InboundJob, normalizeAddress } from "#shared";

export async function redactAddress(address: string): Promise<{ hash: string; domain: string } | null> {
	const normalized = normalizeAddress(address);
	const at = normalized.lastIndexOf("@");
	if (at <= 0) return null;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized)));
	const hash = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
	return { hash, domain: normalized.slice(at + 1) };
}

export async function redactedInboundJob(job: InboundJob): Promise<Record<string, unknown>> {
	const [envelopeFrom, envelopeTo] = await Promise.all([redactAddress(job.envelopeFrom), redactAddress(job.envelopeTo)]);
	const redacted: Record<string, unknown> = {
		v: job.v,
		ingestId: job.ingestId,
		rawKey: job.rawKey,
		rawSize: job.rawSize,
		mailboxId: job.mailboxId,
		envelopeFrom,
		envelopeTo,
		subaddress: job.subaddress,
		receivedAt: job.receivedAt,
		checkFailures: job.checkFailures,
		ruleFailures: job.ruleFailures,
	};
	if (job.imported) {
		redacted.imported = {
			labels: job.imported.labels,
			paths: job.imported.paths,
			read: job.imported.read,
			sent: job.imported.sent,
		};
	}
	return redacted;
}

export async function redactedSendingEvent(event: EmailSendingEvent): Promise<Record<string, unknown>> {
	const [sender, recipient] = await Promise.all([redactAddress(event.payload.sender), redactAddress(event.payload.recipient)]);
	return {
		type: event.type,
		eventId: event.payload.eventId,
		messageId: event.payload.messageId,
		sender,
		recipient,
		terminal: event.payload.terminal,
		status: event.payload.delivery.status,
	};
}
