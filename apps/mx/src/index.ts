import { resolveRecipient } from "@magnus/directory";
import { type EmailSendingEvent, type InboundJob, r2Keys, ulid } from "@magnus/shared";
import { handleDeliveryEvent } from "./events";
import { ingest } from "./ingest";

export default {
	/**
	 * Runs inside the SMTP session. Keep it short and durable: decide accept/reject,
	 * persist the raw bytes, enqueue. Parsing happens in queue() where it can retry.
	 */
	async email(message, env) {
		const resolution = await resolveRecipient(env.DIRECTORY, message.from, message.to);
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
	},

	async queue(batch, env) {
		for (const msg of batch.messages) {
			try {
				if (batch.queue.startsWith("magnus-inbound")) {
					await ingest(env, msg.body as InboundJob);
				} else if (batch.queue.startsWith("magnus-email-events")) {
					await handleDeliveryEvent(env, msg.body as EmailSendingEvent);
				} else {
					console.error(JSON.stringify({ msg: "unknown queue", queue: batch.queue }));
				}
				msg.ack();
			} catch (err) {
				console.error(JSON.stringify({ msg: "queue message failed", queue: batch.queue, attempts: msg.attempts, error: String(err) }));
				msg.retry({ delaySeconds: Math.min(30 * 2 ** (msg.attempts - 1), 3600) });
			}
		}
	},
} satisfies ExportedHandler<Env>;
