import { getAuthenticatorName, passkey } from "@better-auth/passkey";
// Unused, but lets the emitted declarations name the WebAuthn types in the passkey plugin's endpoints.
import type * as _webauthn from "@simplewebauthn/server";
import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, freshSessionMiddleware, getAuthoritativeSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { env, waitUntil } from "cloudflare:workers";
import { z } from "zod";
import { FRESH_SIGN_IN_MINUTES, MIN_PASSWORD_LENGTH, type User } from "#shared";
import { findUserByEmail, loginCodeSender } from "./directory";
import { optional } from "./optional";
import { isRemoved } from "./removals";
import { authSecret } from "./settings";

const CODE_MINUTES = 10;
/** Both steps of adding a passkey. */
const REGISTER_PATHS = new Set(["/passkey/generate-register-options", "/passkey/verify-registration"]);
/** Setting or replacing your password (savePassword below). */
const SAVE_PASSWORD = "/save-password";
/**
 * Better Auth's endpoints that need no session: signing in or out, and asking who's signed in. OAuth callbacks too
 * (/callback/*). Every other one acts for a session, so D1 has to vouch for it (hooks.before below).
 */
const SESSIONLESS = new Set([
	"/sign-in/email-otp",
	"/sign-in/email",
	"/email-otp/send-verification-otp",
	"/sign-in/social",
	"/passkey/generate-authenticate-options",
	"/passkey/verify-authentication",
	"/sign-out",
	"/get-session",
	// Swaps back to the admin's own session, which Better Auth looks up in D1, even once the person they were signed in
	// as has been removed or suspended (and that session with them).
	"/admin/stop-impersonating",
	"/ok",
	"/error",
]);

type Auth = ReturnType<typeof createAuth>;
/** This install's session secret, once read. A plain value, so any request can use it. */
let secret: string | undefined;
const instances = new WeakMap<Request, Auth>();

/**
 * Better Auth at /api/auth/*: a passkey, a code emailed to your sign-in address, a password once you've set one, or
 * Google when configured, then a session cookie in D1. Nobody signs up; an admin adds people (the admin plugin).
 *
 * Each instance is made for the origin the request came in on (its workers.dev URL, a custom domain), so callbacks
 * return to the same site and only that origin is trusted. Passkeys are bound to that origin's hostname too: one made
 * on the custom domain doesn't work on workers.dev.
 *
 * One instance per request, made on first use since Workers forbid I/O at import. An instance can't outlive its
 * request: it runs its queries one at a time (Kysely's single SQLite connection) and keeps locks of its own, and a
 * request's I/O is cancelled when its client hangs up, so a query that never answers would hold up every later request.
 * Making one is CPU work; only the secret is kept between requests.
 */
export async function auth(request: Request): Promise<Auth> {
	const made = instances.get(request);
	if (made) return made;
	secret ??= await authSecret(env.DIRECTORY);
	const instance = instances.get(request) ?? createAuth(new URL(request.url).origin, secret);
	instances.set(request, instance);
	return instance;
}

/** Google needs both halves of an OAuth client; without them the sign-in page offers codes only. */
export const googleEnabled = () => Boolean(google());

function google() {
	const clientId = optional("GOOGLE_CLIENT_ID");
	const clientSecret = optional("GOOGLE_CLIENT_SECRET");
	return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function createAuth(baseURL: string, secret: string) {
	const googleConfig = google();
	return betterAuth({
		baseURL,
		basePath: "/api/auth",
		secret,
		database: env.DIRECTORY,
		user: { modelName: "auth_users" },
		// People are added before they first sign in, so Google has to join an existing account by email.
		account: { modelName: "auth_accounts", accountLinking: { trustedProviders: ["google"] } },
		verification: { modelName: "auth_verifications" },
		session: {
			modelName: "auth_sessions",
			// A mail client should stay signed in; every day of use pushes expiry out again.
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			// Skips the D1 session lookup for who's asking on most requests. A cookie can renew this cache itself, so an ended
			// session can stay signed in: reading mail checks the session still exists (Reader in directory.ts), and so do
			// admin powers (isAdminNow()) and Better Auth's own endpoints (hooks.before).
			cookieCache: { enabled: true, maxAge: 5 * 60 },
			// Adding a passkey (or unlinking Google) needs a recent sign-in, so a stolen session cookie can't plant a
			// passkey that outlives the session.
			freshAge: FRESH_SIGN_IN_MINUTES * 60,
		},
		socialProviders: googleConfig ? { google: { ...googleConfig, prompt: "select_account", disableSignUp: true } } : {},
		// Only signing in: a password is set in Settings (savePassword), and a forgotten one is replaced the same way after
		// signing in with a code. Better Auth's own ways to change or reset one are off (disabledPaths).
		emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD_LENGTH },
		plugins: [
			emailOTP({
				sendVerificationOTP: ({ email, otp, type }) => (type === "sign-in" ? sendSignInCode(email, otp) : Promise.resolve()),
				// Unknown addresses get the same "code sent" answer, but no email and no account.
				disableSignUp: true,
				expiresIn: CODE_MINUTES * 60,
				// Three wrong guesses and the code is dead; a D1 leak doesn't reveal live codes.
				allowedAttempts: 3,
				storeOTP: "hashed",
			}),
			// Registering needs a session; nobody signs up with a passkey. A removed person's stay unusable until they're
			// restored, and go when they're deleted (ON DELETE CASCADE).
			passkey({
				rpID: new URL(baseURL).hostname,
				rpName: "Magnus Mail",
				origin: baseURL,
				// Named for the password manager that holds it, when it says (Apple's don't). Here rather than in the
				// browser, where the lookup would bring the plugin's server code along.
				registration: { afterVerification: ({ verification }) => ({ name: getAuthenticatorName(verification.registrationInfo?.aaguid) }) },
				schema: { passkey: { modelName: "auth_passkeys" } },
			}),
			admin(),
			{ id: "magnus-password", endpoints: { savePassword } },
			// Refuses a password that's turned up in a breach. Only the first 5 characters of its SHA-1 leave the Worker.
			haveIBeenPwned({ paths: [SAVE_PASSWORD], customPasswordCompromisedMessage: "That password has turned up in a data breach. Choose another." }),
		],
		databaseHooks: {
			session: {
				create: {
					// Every way in makes a session: a code, a passkey, Google, an admin signing in as them. Asked once it's written,
					// so a removal can't slip in between: one before this check finds it here, and one after deletes it with the
					// rest of their sessions. Throwing here fails the sign-in before any cookie is set.
					async after(session) {
						if (!(await isRemoved(env.DIRECTORY, session.userId))) return;
						await env.DIRECTORY.prepare(`DELETE FROM auth_sessions WHERE id = ?1`).bind(session.id).run();
						throw new APIError("FORBIDDEN", { message: "An admin removed you from Magnus." });
					},
				},
			},
		},
		hooks: {
			before: createAuthMiddleware(async (ctx) => {
				// A call with no HTTP request is Magnus's own (auth.api.*), made behind its own checks.
				if (!ctx.request || SESSIONLESS.has(ctx.path) || ctx.path.startsWith("/callback/")) return;
				// Asks D1 rather than the cookie cache, which vouches for a session after it's ended (suspended, removed, signed
				// out elsewhere) and can renew itself: such a cookie can't touch passkeys, the person's details, or admin powers.
				const session = await getAuthoritativeSessionFromCtx(ctx);
				if (!session) throw new APIError("UNAUTHORIZED", { message: REGISTER_PATHS.has(ctx.path) ? "Sign in to add a passkey." : "Sign in again." });
				// An admin signed in as someone else (impersonation) can't leave a passkey behind on their account.
				if (REGISTER_PATHS.has(ctx.path) && session.session.impersonatedBy) throw new APIError("FORBIDDEN", { message: "You can't add a passkey for someone else." });
				if (ctx.path === SAVE_PASSWORD && session.session.impersonatedBy) throw new APIError("FORBIDDEN", { message: "You can't set a password for someone else." });
			}),
			after: createAuthMiddleware(async (ctx) => {
				if (ctx.path !== "/passkey/verify-registration" || !ctx.request) return;
				// The session can end (they're removed, say) between the check above and the passkey being saved. Asked again
				// now it's saved: an ended session stays ended, so if it's gone, so is the passkey, which would outlive it.
				if (await getAuthoritativeSessionFromCtx(ctx)) return;
				// Only the passkey this request saved, as Better Auth answered with it: nothing if registering failed.
				const returned: unknown = ctx.context.returned;
				const answer: unknown = returned instanceof Response ? (returned.ok ? await returned.clone().json() : null) : returned;
				const saved = z.object({ id: z.string(), userId: z.string() }).safeParse(answer);
				if (!saved.success) return;
				await env.DIRECTORY.prepare(`DELETE FROM auth_passkeys WHERE id = ?1 AND userId = ?2`).bind(saved.data.id, saved.data.userId).run();
				throw new APIError("UNAUTHORIZED", { message: "Sign in to add a passkey." });
			}),
		},
		// Sign-in endpoints allow a few tries per minute per client IP (the email-code plugin's own limits, matched for
		// passwords). Each passkey challenge is a D1 row, so asking for them is limited too.
		rateLimit: {
			enabled: true,
			storage: "database",
			modelName: "auth_rate_limits",
			customRules: {
				"/sign-in/email": { window: 60, max: 3 },
				"/passkey/generate-authenticate-options": { window: 60, max: 10 },
				"/passkey/verify-authentication": { window: 60, max: 10 },
			},
		},
		advanced: {
			// Migrations own the schema (worker/migrate.ts). Better Auth's own check would read D1's schema for every
			// instance, so every request, and hold each auth call until it's done.
			database: { validateSchema: false },
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			// Codes send after the response, so its timing can't reveal which addresses have an account.
			backgroundTasks: { handler: waitUntil },
		},
		// Deleting someone at once would skip their removal (worker/removals.ts) and leave their mailbox behind. People are
		// removed through /api/admin. And nothing links accounts: Google joins someone by their sign-in email when they first
		// use it, while linking would let any session attach any Google account, which signs in long after it's ended.
		// Only you set your password, through savePassword after a recent sign-in: checking the old one would let a stolen
		// session guess at it, and a reset by email is signing in with a code. People are added through /api/admin too,
		// which makes their mailbox; the plugin's own way would also take a password for them. Only HTTP is turned off.
		disabledPaths: [
			"/admin/remove-user",
			"/link-social",
			"/admin/create-user",
			"/admin/set-user-password",
			"/change-password",
			"/verify-password",
			"/request-password-reset",
			"/reset-password",
			"/email-otp/request-password-reset",
			"/forget-password/email-otp",
			"/email-otp/reset-password",
		],
		telemetry: { enabled: false },
	});
}

/**
 * Sets your password, or replaces it, on a sign-in from the last FRESH_SIGN_IN_MINUTES (as adding a passkey needs): a
 * stolen session can't plant one that outlives it. A forgotten password is replaced after signing in with a code.
 */
const savePassword = createAuthEndpoint(
	SAVE_PASSWORD,
	{ method: "POST", body: z.object({ password: z.string() }), use: [freshSessionMiddleware] },
	async (ctx) => {
		const { password } = ctx.body;
		const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
		if (password.length < minPasswordLength) throw new APIError("BAD_REQUEST", { message: `Use at least ${minPasswordLength} characters.` });
		if (password.length > maxPasswordLength) throw new APIError("BAD_REQUEST", { message: `Use at most ${maxPasswordLength} characters.` });
		const hash = await ctx.context.password.hash(password);
		const { user, session } = ctx.context.session;
		const now = new Date().toISOString();
		// Written only while the session still exists, in one go: one that's ended (they're removed, say) since the check in
		// hooks.before can't leave a password behind. Better Auth looks for the one whose accountId is the person's id.
		const alive = `EXISTS (SELECT 1 FROM auth_sessions WHERE id = ?4)`;
		const [updated, inserted] = await env.DIRECTORY.batch([
			env.DIRECTORY.prepare(`UPDATE auth_accounts SET password = ?1, updatedAt = ?2 WHERE userId = ?3 AND providerId = 'credential' AND ${alive}`).bind(hash, now, user.id, session.id),
			env.DIRECTORY.prepare(
				`INSERT INTO auth_accounts (id, accountId, providerId, userId, password, createdAt, updatedAt)
				 SELECT ?5, ?3, 'credential', ?3, ?1, ?2, ?2 WHERE ${alive}
				 AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE userId = ?3 AND providerId = 'credential')`,
			).bind(hash, now, user.id, session.id, ctx.context.generateId({ model: "account" }) || crypto.randomUUID()),
		]);
		if (!updated?.meta.changes && !inserted?.meta.changes) throw new APIError("UNAUTHORIZED", { message: "Sign in again." });
		return ctx.json({ saved: true });
	},
);

async function sendSignInCode(email: string, code: string) {
	// LOGIN_CODE_FROM's domain needs Email Sending turned on, though it needn't be one of Magnus's domains.
	const from = optional("LOGIN_CODE_FROM") ?? (await loginCodeSender(env.DIRECTORY));
	if (!from) {
		console.error(JSON.stringify({ msg: "no domain can send sign-in codes yet", to: email }));
		return;
	}
	await env.EMAIL.send({
		from: { email: from, name: "Magnus" },
		to: email,
		subject: `${code} is your Magnus sign-in code`,
		text: [
			code,
			"",
			`Enter this code to sign in to Magnus. It works once and expires in ${CODE_MINUTES} minutes.`,
			"",
			"If you didn't just try to sign in, ignore this email. Nobody gets in without the code.",
		].join("\n"),
	});
}

/**
 * Signs someone in on the server's word: setup does this for the first admin, local dev for the seeded person.
 * The one-time code is made and used right here; it never leaves the Worker. Returns the session cookies.
 */
export async function signInWithoutCode(request: Request, email: string): Promise<string[]> {
	const a = await auth(request);
	const otp = await a.api.createVerificationOTP({ body: { email, type: "sign-in" } });
	const { headers } = await a.api.signInEmailOTP({ body: { email, otp }, headers: request.headers, returnHeaders: true });
	return headers.getSetCookie();
}

/** The signed-in person and their session, plus any cookies the response has to set; null if nobody is. */
export async function currentUser(request: Request): Promise<{ user: User; sessionId: string; cookies: string[] } | null> {
	const session = await (await auth(request)).api.getSession({ headers: request.headers });
	if (session) {
		const { id, email, name, role } = session.user;
		return { user: { id, email, name, isAdmin: role === "admin" }, sessionId: session.session.id, cookies: [] };
	}

	// Local dev: sign the seeded person in for real, so admin actions (which need a session) work too.
	const { hostname } = new URL(request.url);
	const devEmail = optional("DEV_USER_EMAIL");
	if (!devEmail || (hostname !== "localhost" && hostname !== "127.0.0.1")) return null;
	const user = await findUserByEmail(env.DIRECTORY, devEmail);
	if (!user) return null;
	const cookies = await signInWithoutCode(request, user.email);
	const signedIn = await (await auth(request)).api.getSession({ headers: { Cookie: cookies.map((c) => c.split(";")[0]).join("; ") } });
	if (!signedIn) throw new Error("Signing the local dev person in made no session");
	return { user, sessionId: signedIn.session.id, cookies };
}

/** The request's session id, for what belongs to the session rather than the person. Null if it has none. */
export async function currentSessionId(request: Request): Promise<string | null> {
	const session = await (await auth(request)).api.getSession({ headers: request.headers });
	return session?.session.id ?? null;
}

/**
 * Signing in over another session (the sign-in page while still signed in, or Back to it) replaces that session's
 * cookie but leaves the session, and the push subscription it holds for this browser (worker/push-api.ts), behind:
 * the previous person's mail would keep showing here. This ends it, unless the new cookie is the same session renewed.
 * Deleted directly, since Better Auth's sign-out logs a failed delete and carries on; a failure here fails the sign-in.
 */
export async function endReplacedSession(request: Request, response: Response): Promise<void> {
	// Impersonating someone swaps the admin's cookie too, but Better Auth keeps their session to return to.
	if (new URL(request.url).pathname.endsWith("/admin/impersonate-user")) return;
	const sent = sessionToken(request.headers.get("Cookie"));
	// The last one counts, as in a browser: some endpoints clear the cookie before setting it. Signing out leaves it empty.
	const set = response.headers.getSetCookie().map(sessionToken).findLast((token) => token !== null);
	if (!sent || !set || sent === set) return;
	const previous = await (await auth(request)).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
	if (previous) await env.DIRECTORY.prepare(`DELETE FROM auth_sessions WHERE id = ?1`).bind(previous.session.id).run();
}

/** The session cookie's value in a Cookie or Set-Cookie header. Better Auth prefixes its name with __Secure- on https. */
const sessionToken = (header: string | null) => (header && /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]*)/.exec(header)?.[1]) ?? null;

/**
 * Whether the request's session is an admin's right now. Asks D1 instead of the session cookie's 5-minute cache,
 * so a suspended or demoted admin can't use those minutes to add another admin.
 */
export async function isAdminNow(request: Request): Promise<boolean> {
	const session = await (await auth(request)).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
	return session?.user.role === "admin";
}
