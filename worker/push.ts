import { fromBase64Url, type IngestInput, makeSnippet, toBase64Url } from "#shared";
import { z } from "zod";

// Web Push (RFC 8030) signed with VAPID (RFC 8292), its payload encrypted to the browser (RFC 8291, aes128gcm from
// RFC 8188), on WebCrypto alone. The browser shows it from public/sw.js.

/** How long a push service keeps a notification for a browser that's offline. */
const TTL_SECONDS = 24 * 3600;
/** A push service that hasn't answered by then counts as failed, so it can't hold the queue consumer up. */
const PUSH_TIMEOUT_MS = 10_000;
/** VAPID tokens may last a day. Each push signs a fresh one. */
const TOKEN_SECONDS = 12 * 3600;
/** A push service takes 4096 bytes. The payload goes as one record, so it has to fit one. */
const RECORD_SIZE = 4096;
/** The record, less the header (salt, record size, key id length, 65-byte key id), the GCM tag, and the delimiter. */
const MAX_PAYLOAD = RECORD_SIZE - 86 - 16 - 1;

/** What public/sw.js shows. */
export interface Notice {
	title: string;
	body: string;
	/** A notification with the same tag replaces it silently, so mail fanned out to two of your mailboxes shows once. */
	tag: string;
	/** Where clicking it goes: a path in the app. */
	url: string;
}

/** A row of push_subscriptions. */
interface Device {
	endpoint: string;
	p256dh: string;
	auth: string;
	origin: string;
}

/**
 * Every browser to notify about new mail in this mailbox: its members', under a session that's live, theirs (not an
 * admin impersonating them), and not suspended. Membership is read now, so someone removed from a shared mailbox stops
 * hearing about it at once.
 */
const DEVICES = `
	SELECT p.endpoint, p.p256dh, p.auth, p.origin FROM push_subscriptions p
	JOIN auth_sessions s ON s.id = p.session_id
	JOIN auth_users u ON u.id = s.userId
	JOIN mailbox_members m ON m.user_id = s.userId
	WHERE m.mailbox_id = ?1 AND s.expiresAt > ?2 AND s.impersonatedBy IS NULL AND coalesce(u.banned, 0) = 0`;

/**
 * Tells the mailbox's members' browsers about mail that just reached its inbox. Each is tried once: the mail is in the
 * inbox either way, and the app counts it unread. A browser its push service has forgotten is forgotten here too.
 */
export async function notifyNewMail(env: Env, mailboxId: string, threadId: string, message: Pick<IngestInput, "id" | "from" | "subject" | "text">) {
	const now = Date.now();
	const { results: devices } = await env.DIRECTORY.prepare(DEVICES).bind(mailboxId, new Date(now).toISOString()).all<Device>();
	if (devices.length === 0) return;
	const notice: Notice = {
		title: clip(message.from.name || message.from.address, 100),
		body: [clip(message.subject, 200), makeSnippet(message.text)].filter(Boolean).join("\n"),
		tag: message.id,
		url: `/inbox/${encodeURIComponent(mailboxId)}/${encodeURIComponent(threadId)}`,
	};
	const keys = await vapidKeys(env.DIRECTORY);
	const sent = await Promise.allSettled(devices.map((device) => push(env.DIRECTORY, keys, device, notice, now)));
	for (const result of sent) {
		if (result.status === "rejected") console.error(JSON.stringify({ msg: "push failed", mailboxId, messageId: message.id, error: String(result.reason) }));
	}
}

/**
 * Subscriptions whose session expired without being used again. Better Auth deletes an expired session only when it's
 * presented, so these would stay. Run hourly (worker/index.ts).
 */
export async function forgetExpiredDevices(db: D1Database, now: number): Promise<void> {
	await db
		.prepare(`DELETE FROM push_subscriptions WHERE session_id IN (SELECT id FROM auth_sessions WHERE expiresAt <= ?1)`)
		.bind(new Date(now).toISOString())
		.run();
}

async function push(db: D1Database, keys: VapidKeys, device: Device, notice: Notice, now: number): Promise<void> {
	const res = await fetch(device.endpoint, {
		method: "POST",
		headers: {
			Authorization: await authorization(device.endpoint, device.origin, keys, now),
			TTL: String(TTL_SECONDS),
			// Every push shows a notification, the kind FCM delivers at once rather than holding while a phone dozes.
			Urgency: "high",
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
		},
		body: await encryptPayload(device, encode(JSON.stringify(notice))),
		signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
	});
	// The endpoint alone lets anyone push to the browser, so only its host is logged.
	const host = new URL(device.endpoint).host;
	// Any https URL can be an endpoint, so its answer is never read whole: just enough of a refusal to say why.
	const reason = res.ok ? "" : await start(res, 200);
	await res.body?.cancel();
	if (res.ok) return;
	if (res.status === 404 || res.status === 410) {
		// Unsubscribed or expired. Push services never reuse an endpoint, so it can go whoever holds it now.
		await db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?1`).bind(device.endpoint).run();
		console.log(JSON.stringify({ msg: "push subscription gone", host, status: res.status }));
		return;
	}
	throw new Error(`${host} answered ${res.status}: ${reason}`);
}

/** The first `bytes` of a response body, from its first chunk only. */
async function start(res: Response, bytes: number): Promise<string> {
	const reader = res.body?.getReader();
	if (!reader) return "";
	const { value } = await reader.read();
	reader.releaseLock();
	return new TextDecoder().decode(value?.slice(0, bytes));
}

/**
 * VAPID tokens, reused until an hour before they expire: Apple asks for one no more often than hourly, and each push
 * would otherwise sign its own. Keyed by push service, sender, and key, which a token names.
 */
const tokens = new Map<string, { header: Promise<string>; until: number }>();

function authorization(endpoint: string, origin: string, keys: VapidKeys, now: number): Promise<string> {
	const key = `${new URL(endpoint).origin} ${origin} ${keys.publicKey}`;
	const cached = tokens.get(key);
	if (cached && cached.until > now) return cached.header;
	// Stored before it's signed, so pushes to several devices at once share it. A failed signing isn't kept.
	const header = vapidAuthorization(endpoint, origin, keys, now);
	const entry = { header, until: now + (TOKEN_SECONDS - 3600) * 1000 };
	tokens.set(key, entry);
	header.catch(() => tokens.get(key) === entry && tokens.delete(key));
	return header;
}

const VapidSchema = z.object({
	/** The raw public key: what browsers subscribe with as the application server key. */
	publicKey: z.string(),
	privateKey: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string(), d: z.string() }),
});

type VapidKeys = Awaited<ReturnType<typeof vapidKeys>>;

/**
 * This install's VAPID key pair, in D1's settings. Made on first use, like the session secret, and never replaced: a
 * push service only delivers to a subscription when the push is signed with the key it was made with. Anyone who can
 * read D1 can read every subscription and session too, so keeping it there adds no exposure.
 */
export async function vapidKeys(db: D1Database): Promise<{ publicKey: string; privateKey: CryptoKey }> {
	const read = db.prepare(`SELECT value FROM settings WHERE key = 'vapid'`);
	let row = await read.first<{ value: string }>();
	if (!row) {
		const pair = await keyPair({ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"]);
		const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
		if (privateKey instanceof ArrayBuffer) throw new Error("Expected a JWK");
		const fresh = { publicKey: toBase64Url(await rawKey(pair.publicKey)), privateKey };
		// Two at once both insert. The first wins, and both read it back.
		const [, stored] = await db.batch<{ value: string }>([
			db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?1)`).bind(JSON.stringify(fresh)),
			read,
		]);
		row = stored?.results[0] ?? null;
		if (!row) throw new Error("VAPID keys missing after insert");
	}
	const { publicKey, privateKey } = VapidSchema.parse(JSON.parse(row.value));
	return { publicKey, privateKey: await crypto.subtle.importKey("jwk", privateKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]) };
}

/** RFC 8292: a token signed with this install's key, which the push service checks against the subscription's. */
export async function vapidAuthorization(endpoint: string, origin: string, keys: VapidKeys, now: number): Promise<string> {
	const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: origin };
	const unsigned = `${base64Json({ typ: "JWT", alg: "ES256" })}.${base64Json(claims)}`;
	// WebCrypto signs ECDSA as r‖s, the form JWS wants.
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encode(unsigned));
	return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

/**
 * RFC 8291: the payload encrypted so only the browser that subscribed can read it. `local` and `salt` are fresh for
 * every push; the RFC's test vector fixes them.
 */
export async function encryptPayload(
	device: Pick<Device, "p256dh" | "auth">,
	plaintext: Uint8Array<ArrayBuffer>,
	local?: CryptoKeyPair,
	salt = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array<ArrayBuffer>> {
	if (plaintext.length > MAX_PAYLOAD) throw new Error(`Push payload is ${plaintext.length} bytes, over ${MAX_PAYLOAD}`);
	const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
	const sender = local ?? (await keyPair(ecdh, ["deriveBits"]));
	const receiverKey = fromBase64Url(device.p256dh);
	const senderKey = await rawKey(sender.publicKey);
	// Passed as a variable: Workers' types call `public` `$public`, though the runtime reads `public`.
	const agreement = { name: "ECDH", public: await crypto.subtle.importKey("raw", receiverKey, ecdh, false, []) };
	const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, sender.privateKey, 256));

	const ikm = await hkdf(fromBase64Url(device.auth), shared, concat(encode("WebPush: info\0"), receiverKey, senderKey), 32);
	const [cek, nonce] = await Promise.all([
		hkdf(salt, ikm, encode("Content-Encoding: aes128gcm\0"), 16),
		hkdf(salt, ikm, encode("Content-Encoding: nonce\0"), 12),
	]);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// The only record, so it ends with the last-record delimiter and needs no padding.
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));

	const header = new Uint8Array(21);
	header.set(salt);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = senderKey.length;
	return concat(header, senderKey, ciphertext);
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

// Workers' WebCrypto types are looser than the DOM's, so these check what they get back.

export async function keyPair(algorithm: SubtleCryptoGenerateKeyAlgorithm, usages: string[]): Promise<CryptoKeyPair> {
	const pair = await crypto.subtle.generateKey(algorithm, true, usages);
	if (!("privateKey" in pair)) throw new Error("Expected a key pair");
	return pair;
}

export async function rawKey(key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
	const raw = await crypto.subtle.exportKey("raw", key);
	if (!(raw instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
	return new Uint8Array(raw);
}

const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const base64Json = (value: object) => toBase64Url(encode(JSON.stringify(value)));
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
