import { getUserByLogin } from "@magnus/directory";
import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { env, waitUntil } from "cloudflare:workers";

const CODE_MINUTES = 10;

let instance: ReturnType<typeof createAuth> | undefined;

/**
 * Sign-in runs on Better Auth at /api/auth/*: "Continue with Google" or a code emailed to your login address
 * (for devices that block Google sign-in), then a session cookie in D1.
 * Created on first use rather than at import, since Workers forbid some work in global scope.
 */
export const auth = () => (instance ??= createAuth());

function createAuth() {
	return betterAuth({
		baseURL: env.BETTER_AUTH_URL,
		basePath: "/api/auth",
		secret: env.BETTER_AUTH_SECRET,
		database: env.DIRECTORY,
		user: { modelName: "auth_users" },
		account: { modelName: "auth_accounts" },
		verification: { modelName: "auth_verifications" },
		session: {
			modelName: "auth_sessions",
			// A mail client should stay signed in; every day of use pushes expiry out again.
			expiresIn: 60 * 60 * 24 * 30,
			updateAge: 60 * 60 * 24,
			// Skips the D1 session lookup on most requests. A revoked session lingers for up to 5 minutes.
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		socialProviders: {
			google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: "select_account" },
		},
		plugins: [
			emailOTP({
				sendVerificationOTP: ({ email, otp, type }) => (type === "sign-in" ? sendSignInCode(email, otp) : Promise.resolve()),
				expiresIn: CODE_MINUTES * 60,
				// Three wrong guesses and the code is dead; a D1 leak doesn't reveal live codes.
				allowedAttempts: 3,
				storeOTP: "hashed",
			}),
		],
		// Sign-in endpoints allow a few tries per minute per client IP (the email-code plugin's own limits).
		rateLimit: { enabled: true, storage: "database", modelName: "auth_rate_limits" },
		advanced: {
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
			// Codes send after the response, so its timing can't reveal which addresses have an account.
			backgroundTasks: { handler: waitUntil },
		},
		databaseHooks: {
			user: {
				create: {
					// No self sign-up: only people already in the directory get an account.
					// Refusing here sends Google sign-in back to /login?error=unable_to_create_user. Email codes
					// never reach anyone else in the first place (sendSignInCode).
					before: async (user) => user.emailVerified && (await getUserByLogin(env.DIRECTORY, user.email)) !== null,
				},
			},
		},
		telemetry: { enabled: false },
	});
}

/** Anyone can ask for a code; only people in the directory get one. The answer looks the same either way. */
async function sendSignInCode(email: string, code: string) {
	if (!(await getUserByLogin(env.DIRECTORY, email))) return;
	await env.EMAIL.send({
		from: { email: env.LOGIN_CODE_FROM, name: "Magnus Mail" },
		to: email,
		subject: `${code} is your Magnus Mail sign-in code`,
		text: [
			code,
			"",
			`Enter this code to sign in to Magnus Mail. It works once and expires in ${CODE_MINUTES} minutes.`,
			"",
			"If you didn't just try to sign in, ignore this email. Nobody gets in without the code.",
		].join("\n"),
	});
}

/** The signed-in person's verified email, or null. */
export async function signedInEmail(request: Request): Promise<string | null> {
	// Local dev without Google credentials: .dev.vars can name a user, honored only on localhost.
	const { hostname } = new URL(request.url);
	if (env.DEV_USER_EMAIL && (hostname === "localhost" || hostname === "127.0.0.1")) return env.DEV_USER_EMAIL;

	const session = await auth().api.getSession({ headers: request.headers });
	return session?.user.email ?? null;
}
