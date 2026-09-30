import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { emailOTP } from "better-auth/plugins/email-otp";
import { env, waitUntil } from "cloudflare:workers";
import type { User } from "#shared";
import { findUserByEmail, loginCodeSender } from "./directory";
import { optional } from "./optional";
import { authSecret } from "./settings";

const CODE_MINUTES = 10;

type Auth = ReturnType<typeof createAuth>;
const instances = new Map<string, Promise<Auth>>();

/**
 * Better Auth at /api/auth/*: a code emailed to your sign-in address, or Google when configured, then a session
 * cookie in D1. Nobody signs up; an admin adds people (the admin plugin).
 *
 * One instance per origin the Worker is reached on (its workers.dev URL, a custom domain), so callbacks return
 * to the same site and only that origin is trusted. Created on first use, since Workers forbid I/O at import.
 */
export function auth(request: Request): Promise<Auth> {
	const { origin } = new URL(request.url);
	let instance = instances.get(origin);
	if (!instance) {
		instance = authSecret(env.DIRECTORY).then((secret) => createAuth(origin, secret));
		instance.catch(() => instances.delete(origin));
		instances.set(origin, instance);
	}
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
			// Skips the D1 session lookup on most requests. A suspended person keeps access for up to 5 minutes, admin
			// powers aside (isAdminNow()).
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		socialProviders: googleConfig ? { google: { ...googleConfig, prompt: "select_account", disableSignUp: true } } : {},
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
			admin(),
		],
		// Sign-in endpoints allow a few tries per minute per client IP (the email-code plugin's own limits).
		rateLimit: { enabled: true, storage: "database", modelName: "auth_rate_limits" },
		advanced: {
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			// Codes send after the response, so its timing can't reveal which addresses have an account.
			backgroundTasks: { handler: waitUntil },
		},
		telemetry: { enabled: false },
	});
}

async function sendSignInCode(email: string, code: string) {
	const from = await loginCodeSender(env.DIRECTORY);
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

/** The signed-in person, plus any cookies the response has to set; null if nobody is. */
export async function currentUser(request: Request): Promise<{ user: User; cookies: string[] } | null> {
	const session = await (await auth(request)).api.getSession({ headers: request.headers });
	if (session) {
		const { id, email, name, role } = session.user;
		return { user: { id, email, name, isAdmin: role === "admin" }, cookies: [] };
	}

	// Local dev: sign the seeded person in for real, so admin actions (which need a session) work too.
	const { hostname } = new URL(request.url);
	const devEmail = optional("DEV_USER_EMAIL");
	if (!devEmail || (hostname !== "localhost" && hostname !== "127.0.0.1")) return null;
	const user = await findUserByEmail(env.DIRECTORY, devEmail);
	return user ? { user, cookies: await signInWithoutCode(request, user.email) } : null;
}

/**
 * Whether the request's session is an admin's right now. Asks D1 instead of the session cookie's 5-minute cache,
 * so a suspended or demoted admin can't use those minutes to add another admin.
 */
export async function isAdminNow(request: Request): Promise<boolean> {
	const session = await (await auth(request)).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
	return session?.user.role === "admin";
}
