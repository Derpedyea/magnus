import { passkeyClient } from "@better-auth/passkey/client";
import { type PublicKeyCredentialRequestOptionsJSON, startAuthentication, WebAuthnError } from "@simplewebauthn/browser";
import { createAuthClient } from "better-auth/client";
import { ApiError, errorMessage } from "./api";

/**
 * Passkeys get their own client. The plugin reports failures as `{ error }` and catches its own WebAuthn errors,
 * which authClient's throwing hook would turn into a generic "Auth cancelled".
 */
const client = createAuthClient({ basePath: "/api/auth", plugins: [passkeyClient()] });

/** False in browsers without WebAuthn, where the passkey options stay hidden. */
export const passkeysSupported = typeof window !== "undefined" && "PublicKeyCredential" in window;

/**
 * The browser's passkey prompt closed without one: cancelled, timed out, or nothing saved for this site. Browsers
 * deliberately don't say which, so nothing is shown.
 */
export class PasskeyDismissed extends Error {}

/** Another passkey request on the page took over: starting one cancels whichever is open. */
class PasskeySuperseded extends PasskeyDismissed {}

/** Adding a passkey needs a recent sign-in (FRESH_SIGN_IN_MINUTES, the server's freshAge). */
export class SignInAgain extends Error {}

/** Better Auth's messages, in plainer words. */
const MESSAGES: Record<string, string> = {
	"Passkey not found": "That passkey was removed. Sign in with a code instead.",
	"Previously registered": "This device already has a passkey for Magnus Mail.",
	"Auth cancelled": "Couldn't use a passkey on this device.",
};

type Result<T> = { data: T; error: null } | { data: null; error: { message?: string; status: number; statusText: string } };

function unwrap<T>(result: Result<T>): NonNullable<T> {
	const { data, error } = result;
	if (error === null) {
		// Every passkey endpoint answers something on success; an empty answer isn't one.
		if (data === null || data === undefined) throw new ApiError("Magnus Mail sent an empty answer.", 500);
		return data;
	}
	const code = "code" in error ? error.code : null;
	if (code === "ERROR_CEREMONY_ABORTED") throw new PasskeySuperseded();
	if (code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY") throw new PasskeyDismissed();
	if (code === "SESSION_NOT_FRESH") throw new SignInAgain();
	const message = error.message ?? error.statusText;
	throw new ApiError(MESSAGES[message] ?? message, error.status);
}

/** What to show for a failed passkey action: nothing when the browser's prompt just closed. */
export const passkeyFailure = (error: Error | null) => (error && !(error instanceof PasskeyDismissed) ? errorMessage(error) : null);

/** The server keeps a sign-in challenge 5 minutes (the passkey plugin's MAX_AGE_IN_SECONDS); one is reused for less. */
const CHALLENGE_REUSE_MS = 4 * 60_000;
let challenge: { options: Promise<PublicKeyCredentialRequestOptionsJSON>; until: number } | null = null;
/**
 * The last challenge asked for, answered or not. Each answer sets the one challenge cookie, so a new ask waits for the
 * last: answers arriving out of order would leave the cookie naming a challenge other than the one kept here.
 */
let asking: Promise<unknown> = Promise.resolve();

/**
 * The sign-in page's challenge. It's fetched as the page opens, so pressing the passkey button opens the prompt without
 * waiting on the server, and autofill and the button share it as they share the cookie naming it. Checking a passkey
 * uses it up, pass or fail, so the next try fetches another.
 */
function signInChallenge() {
	if (!challenge || Date.now() > challenge.until) {
		const options = asking.then(() => client.$fetch<PublicKeyCredentialRequestOptionsJSON>("/passkey/generate-authenticate-options", { method: "GET" })).then(unwrap);
		asking = options.catch(() => undefined);
		const fetched = { options, until: Date.now() + CHALLENGE_REUSE_MS };
		challenge = fetched;
		// A failed fetch isn't kept: the next try asks again.
		options.catch(() => {
			if (challenge === fetched) challenge = null;
		});
	}
	return challenge.options;
}

/** Better Auth's passkey sign-in (its client's signIn.passkey), on the page's challenge instead of a new one each time. */
async function signInWithPasskey(autoFill: boolean) {
	const optionsJSON = await signInChallenge();
	let response;
	try {
		response = await startAuthentication({ optionsJSON, useBrowserAutofill: autoFill });
	} catch (error) {
		// As the plugin reports it, for unwrap.
		const code = error instanceof WebAuthnError ? error.code : "AUTH_CANCELLED";
		return { data: null, error: { code, message: "Auth cancelled", status: 400, statusText: "BAD_REQUEST" } };
	}
	challenge = null;
	return client.$fetch<{ user: { id: string } }>("/passkey/verify-authentication", { method: "POST", body: { response } });
}

export const passkeys = {
	list: async () => unwrap(await client.passkey.listUserPasskeys()),
	add: async () => unwrap(await client.passkey.addPasskey()),
	remove: async (id: string) => unwrap(await client.passkey.deletePasskey({ id })),
	/** Fetches the challenge ahead of signIn; a failure shows when signIn asks again. */
	prepareSignIn: () => void signInChallenge().catch(() => undefined),
	/** Off the sign-in page: whoever signs in next gets a challenge of their own. */
	forgetSignIn: () => {
		challenge = null;
	},
	/** With `autoFill`, waits for the person to pick a passkey from the email field's autofill instead of prompting. */
	signIn: async (autoFill = false) => {
		try {
			return unwrap(await signInWithPasskey(autoFill));
		} catch (error) {
			// Autofill still waiting on its challenge when the prompt opened cancels the prompt once it starts. Asking again
			// cancels autofill instead, on the same challenge.
			if (autoFill || !(error instanceof PasskeySuperseded)) throw error;
			return unwrap(await signInWithPasskey(false));
		}
	},
};

export type Passkey = Awaited<ReturnType<typeof passkeys.list>>[number];
