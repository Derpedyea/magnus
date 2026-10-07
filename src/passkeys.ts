import { passkeyClient } from "@better-auth/passkey/client";
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

export const passkeys = {
	list: async () => unwrap(await client.passkey.listUserPasskeys()),
	add: async () => unwrap(await client.passkey.addPasskey()),
	remove: async (id: string) => unwrap(await client.passkey.deletePasskey({ id })),
	/** With `autoFill`, waits for the person to pick a passkey from the email field's autofill instead of prompting. */
	signIn: async (autoFill = false) => {
		try {
			return unwrap(await client.signIn.passkey({ autoFill }));
		} catch (error) {
			// Autofill still fetching its challenge when the prompt opened cancels the prompt once it starts. Asking again
			// cancels autofill instead, and fetches a fresh challenge (the two share one challenge cookie).
			if (autoFill || !(error instanceof PasskeySuperseded)) throw error;
			return unwrap(await client.signIn.passkey());
		}
	},
};

export type Passkey = Awaited<ReturnType<typeof passkeys.list>>[number];
