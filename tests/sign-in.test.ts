import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { FRESH_SIGN_IN_MINUTES } from "#shared";
import { fixture, type Fixture } from "./runtime/fixture";

const ORIGIN = "https://magnus.test";
/** 1Password's authenticator model, so the passkey has a name to show. */
const AAGUID = "bada5566-a7aa-401f-bd96-45619a55120d";

type Reply = Awaited<ReturnType<Fixture["worker"]["fetch"]>>;

describe("sign-in", () => {
	let f: Fixture;
	beforeAll(async () => { f = await fixture(); }, 30_000);
	afterAll(async () => { await f?.server.close(); });
	beforeEach(async () => {
		await f.seed();
		// Every request here shares one client IP, so the passkey rate limits would carry over between cases.
		await f.env.DIRECTORY.prepare("DELETE FROM auth_rate_limits").run();
		// Dated the way Better Auth dates people. Its session cookie cache rejects the seed's numeric dates, and the
		// checks below have to hold while that cache answers instead of D1.
		await f.env.DIRECTORY.prepare("UPDATE auth_users SET createdAt = ?1, updatedAt = ?1").bind(new Date().toISOString()).run();
	});

	function call(path: string, cookie = "", body?: unknown) {
		return f.worker.fetch(`${ORIGIN}/api${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { Cookie: cookie, Origin: ORIGIN, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async function register(cookie: string, key: Authenticator) {
		const options = await call("/auth/passkey/generate-register-options", cookie);
		expect(options.status).toBe(200);
		const { challenge, rp } = z.object({ challenge: z.string(), rp: z.object({ id: z.string() }) }).parse(await options.json());
		const verified = await call("/auth/passkey/verify-registration", jar(cookie, options), { response: await key.create(challenge, rp.id) });
		expect(verified.status).toBe(200);
		return z.object({ id: z.string() }).parse(await verified.json()).id;
	}

	/** The browser's half of a passkey sign-in: fetch a challenge, sign it, send it back with the challenge cookie. */
	async function signIn(key: Authenticator) {
		const options = await call("/auth/passkey/generate-authenticate-options");
		const { challenge, rpId } = z.object({ challenge: z.string(), rpId: z.string() }).parse(await options.json());
		const body = { response: await key.get(challenge, rpId) };
		const send = () => call("/auth/passkey/verify-authentication", jar("", options), body);
		return { response: await send(), replay: send };
	}

	const signsIn = (response: Reply) => response.headers.getSetCookie().some((cookie) => cookie.includes("session_token"));

	it("adds a passkey on a fresh session, then signs in with it alone", async () => {
		const key = await authenticator();
		await register(await f.login("alice"), key);
		expect(await f.env.DIRECTORY.prepare("SELECT userId, name FROM auth_passkeys").all()).toMatchObject({ results: [{ userId: "alice", name: "1Password" }] });

		const { response } = await signIn(key);
		expect(response.status).toBe(200);
		const me = await call("/me", jar("", response));
		expect(await me.json()).toMatchObject({ user: { id: "alice" } });
	});

	it.each([
		[`older than ${FRESH_SIGN_IN_MINUTES} minutes`, "UPDATE auth_sessions SET createdAt = ?1", 403],
		["revoked, though its cookie cache still says otherwise", "DELETE FROM auth_sessions", 401],
		["an admin's impersonation", "UPDATE auth_sessions SET impersonatedBy = 'admin'", 403],
	])("won't add a passkey from a session that's %s", async (_, sql, status) => {
		const cookie = await f.login("alice");
		const row = await f.env.DIRECTORY.prepare("SELECT createdAt FROM auth_sessions").first<{ createdAt: string | number }>();
		const stale = Date.now() - (FRESH_SIGN_IN_MINUTES + 5) * 60_000;
		const statement = f.env.DIRECTORY.prepare(sql);
		// Written the way Better Auth wrote it.
		await (sql.includes("?1") ? statement.bind(typeof row?.createdAt === "number" ? stale : new Date(stale).toISOString()) : statement).run();
		expect((await call("/auth/passkey/generate-register-options", cookie)).status).toBe(status);
	});

	it("accepts each signed challenge once", async () => {
		const key = await authenticator();
		await register(await f.login("alice"), key);
		const { response, replay } = await signIn(key);
		expect(response.status).toBe(200);
		const again = await replay();
		expect(again.status).toBe(400);
		expect(signsIn(again)).toBe(false);
	});

	it.each(["the passkey", "its person"])("stops a passkey signing in once %s is removed", async (removed) => {
		const key = await authenticator();
		const id = await register(await f.login("alice"), key);
		const removal = removed === "the passkey"
			? await call("/auth/passkey/delete-passkey", await f.login("alice"), { id })
			: await f.worker.fetch(`${ORIGIN}/api/admin/people/alice`, { method: "DELETE", headers: { Cookie: await f.login("admin"), Origin: ORIGIN } });
		expect(removal.ok).toBe(true);
		const { response } = await signIn(key);
		expect(response.status).toBe(401);
		expect(signsIn(response)).toBe(false);
	});

	it("doesn't sign in a suspended person with their passkey", async () => {
		const key = await authenticator();
		await register(await f.login("alice"), key);
		expect((await call("/auth/admin/ban-user", await f.login("admin"), { userId: "alice" })).status).toBe(200);
		const { response } = await signIn(key);
		expect(response.status).toBe(403);
		expect(signsIn(response)).toBe(false);
	});

	it("won't let someone else remove your passkey", async () => {
		const id = await register(await f.login("alice"), await authenticator());
		expect((await call("/auth/passkey/delete-passkey", await f.login("bob"), { id })).status).toBe(401);
		expect(await f.env.DIRECTORY.prepare("SELECT count(*) AS n FROM auth_passkeys").first()).toEqual({ n: 1 });
	});

	it("won't give someone a sign-in email at one of Magnus's own domains", async () => {
		const admin = await f.login("admin");
		const inside = await call("/admin/people", admin, { name: "Carol", email: "Carol@Example.com", isAdmin: false });
		expect(inside.status).toBe(400);
		expect(await inside.json()).toEqual({ error: "Codes sent to example.com would arrive in Magnus itself. Use an address somewhere else." });
		expect(await f.env.DIRECTORY.prepare("SELECT 1 FROM auth_users WHERE email = 'carol@example.com'").first()).toBeNull();
		expect((await call("/admin/people", admin, { name: "Carol", email: "carol@outside.test", isAdmin: false })).status).toBe(201);
	});
});

/** A request's cookies plus whatever a response set, later ones winning, as a Cookie header. */
function jar(cookie: string, response: Reply): string {
	const all = new Map(cookie.split("; ").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair] as const));
	for (const set of response.headers.getSetCookie()) {
		const pair = set.split(";")[0] ?? "";
		all.set(pair.slice(0, pair.indexOf("=")), pair);
	}
	return [...all.values()].join("; ");
}

type Authenticator = Awaited<ReturnType<typeof authenticator>>;

/**
 * A software passkey: a P-256 key that answers WebAuthn ceremonies the way a browser and authenticator would
 * (attestation "none"), so the server's real verification runs.
 */
async function authenticator() {
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
	if (!("privateKey" in keys)) throw new Error("Expected a key pair");
	const exported = await crypto.subtle.exportKey("raw", keys.publicKey);
	if (!(exported instanceof ArrayBuffer)) throw new Error("Expected raw key bytes");
	const point = new Uint8Array(exported);
	// COSE_Key: EC2, ES256, P-256, x, y.
	const publicKey = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, point.slice(1, 33)], [-3, point.slice(33)]]));
	const id = crypto.getRandomValues(new Uint8Array(16));
	let counter = 0;
	const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	const clientData = (type: string, challenge: string) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
	const credential = { id: b64(id), rawId: b64(id), type: "public-key", clientExtensionResults: {} };

	return {
		async create(challenge: string, rpId: string) {
			// Flags: user present, user verified, attested credential data follows.
			const aaguid = AAGUID.replaceAll("-", "").match(/../g)?.map((byte) => parseInt(byte, 16)) ?? [];
			const authData = concat(await sha256(new TextEncoder().encode(rpId)), [0x45], uint32(counter), aaguid, [0, id.length], id, publicKey);
			const attestationObject = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
			return { ...credential, response: { clientDataJSON: b64(clientData("webauthn.create", challenge)), attestationObject: b64(attestationObject), transports: ["internal"] } };
		},
		async get(challenge: string, rpId: string) {
			const authData = concat(await sha256(new TextEncoder().encode(rpId)), [0x05], uint32(++counter));
			const data = clientData("webauthn.get", challenge);
			const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, concat(authData, await sha256(data)));
			return { ...credential, response: { clientDataJSON: b64(data), authenticatorData: b64(authData), signature: b64(derSignature(new Uint8Array(signature))) } };
		},
	};
}

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

/** Just enough CBOR for attestation objects and COSE keys: small integers, strings, bytes, and maps. */
function cbor(value: Cbor): Uint8Array {
	const head = (major: number, n: number) => (n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255]);
	if (typeof value === "number") return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
	if (typeof value === "string") {
		const bytes = new TextEncoder().encode(value);
		return concat(head(3, bytes.length), bytes);
	}
	if (value instanceof Uint8Array) return concat(head(2, value.length), value);
	return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

/** WebCrypto signs ECDSA as r‖s; WebAuthn sends ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		const trimmed = bytes.slice(start);
		const body = (trimmed[0] ?? 0) & 0x80 ? concat([0], trimmed) : trimmed;
		return concat([0x02, body.length], body);
	};
	const r = integer(raw.slice(0, 32));
	const s = integer(raw.slice(32));
	return concat([0x30, r.length + s.length], r, s);
}

const uint32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
