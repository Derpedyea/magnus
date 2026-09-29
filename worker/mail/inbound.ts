import { type EmailSendingEvent, type InboundJob, r2Keys, ulid } from "#shared";
import { addressParser } from "postal-mime";
import { resolveRecipient } from "../directory";
import { handleDeliveryEvent } from "./events";
import { ingest } from "./ingest";

/**
 * Runs inside the SMTP session. Keep it short and durable: decide accept/reject,
 * persist the raw bytes, enqueue. Parsing happens in queue() where it can retry.
 */
export async function email(message: ForwardableEmailMessage, env: Env): Promise<void> {
	// Every mailbox in the From header, parsed the way ingest() parses it (it shows the first).
	const fromHeader = addressParser(message.headers.get("from") ?? "", { flatten: true }).flatMap((a) => a.address ?? []);
	const resolution = await resolveRecipient(env.DIRECTORY, [message.from, ...fromHeader], message.to);
	if (resolution.kind === "reject") {
		console.log(JSON.stringify({ msg: "rejected", from: message.from, to: message.to, reason: resolution.reason }));
		message.setReject(resolution.reason);
		return;
	}

	const receivedAt = Date.now();
	const ingestId = ulid(receivedAt);
	const rawKey = r2Keys.raw(ingestId, receivedAt);

	// message.raw is single-use; buffer once (inbound is capped at 25 MiB).
	const raw = await new Response(message.raw).arrayBuffer();
	await env.MAIL.put(rawKey, raw, {
		httpMetadata: { contentType: "message/rfc822" },
		customMetadata: { envelopeFrom: message.from, envelopeTo: message.to },
	});

	const jobs: InboundJob[] = resolution.mailboxIds.map((mailboxId) => ({
		v: 1,
		ingestId,
		rawKey,
		rawSize: message.rawSize,
		mailboxId,
		envelopeFrom: message.from,
		envelopeTo: message.to,
		subaddress: resolution.subaddress,
		receivedAt,
	}));
	await env.INBOUND.sendBatch(jobs.map((body) => ({ body })));

	console.log(JSON.stringify({ msg: "accepted", ingestId, to: message.to, mailboxes: resolution.mailboxIds, size: message.rawSize }));
}

// Messages are told apart by shape rather than queue name, since queues can be renamed when deploying.
const isInboundJob = (body: unknown): body is InboundJob => typeof body === "object" && body !== null && "ingestId" in body && "rawKey" in body;
const isSendingEvent = (body: unknown): body is EmailSendingEvent =>
	typeof body === "object" && body !== null && "type" in body && typeof body.type === "string" && body.type.startsWith("cf.email.sending.");

/** Parses queued inbound mail, and applies Email Sending delivery events. Messages are independent: each acks or retries alone. */
export async function queue(batch: MessageBatch, env: Env): Promise<void> {
	await Promise.all(
		batch.messages.map(async (msg) => {
			try {
				if (isInboundJob(msg.body)) await ingest(env, msg.body);
				else if (isSendingEvent(msg.body)) await handleDeliveryEvent(env, msg.body);
				else console.error(JSON.stringify({ msg: "unknown queue message", queue: batch.queue }));
				msg.ack();
			} catch (err) {
				// After the last retry the message is dropped, but the raw copy stays in R2: re-send its job to replay it.
				console.error(JSON.stringify({ msg: "queue message failed", queue: batch.queue, attempts: msg.attempts, body: msg.body, error: String(err) }));
				msg.retry({ delaySeconds: Math.min(30 * 2 ** (msg.attempts - 1), 3600) });
			}
		}),
	);
}
