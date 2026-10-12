import { describe, expect, it } from "vitest";
import { Session } from "./session.ts";

/** What proton-mail-export-cli 1.0.7 prints before it asks for anything, as captured from the real tool. */
const BANNER = [
	"Proton Mail Export Tool (1.0.7) (c) Proton AG, Switzerland",
	"This program is licensed under the GNU General Public License v3",
	"Get support at https://proton.me/support/proton-mail-export-tool",
	"",
	"\r- Checking for new version                    ",
	"The export tool is up to date",
	"",
	'Session Log: "/opt/proton-export/logs/20261012_201614_export.log"',
	"",
	"",
].join("\n");
const SPINNER = "\r- Logging In                                  \r\\ Logging In                                  \n";
const VERIFY = "https://verify.proton.me/?methods=captcha&token=abc123";

function tool() {
	const writes: string[] = [];
	let interrupts = 0;
	return {
		writes,
		interrupts: () => interrupts,
		session: new Session({ write: (text) => writes.push(text), interrupt: () => interrupts++ }, "derpy", "hunter2"),
	};
}

/** Signed in and exporting, the code question answered on the way. */
function signedIn() {
	const t = tool();
	t.session.feed(`${BANNER}Password: `);
	t.session.feed(SPINNER);
	return t;
}

describe("Proton export session", () => {
	it("gives the password once, then follows the export to the end", () => {
		const t = signedIn();
		expect(t.writes).toEqual(["hunter2\n"]);
		expect(t.session.state()).toMatchObject({ phase: "signing-in", prompt: 0 });
		t.session.feed("Starting Export - Path=/export/me@proton.test/mail_20261012_201614\n");
		expect(t.session.state().phase).toBe("exporting");
		t.session.feed("\r[045.50%][|||||||||||||||||||||||                            ]");
		expect(t.session.state().percent).toBe(45.5);
		t.session.feed("\r[100.00%][||||||||||||||||||||||||||||||||||||||||||||||||||]\nExport Finished\n");
		t.session.exit(0);
		expect(t.session.state()).toMatchObject({ phase: "exported", percent: 100, error: null });
		expect(t.interrupts()).toBe(0);
	});

	it("stops after one failed sign-in, with Proton's words, even when they arrive in pieces", () => {
		const t = signedIn();
		// stderr is unbuffered: the prefix can come on its own, looking like a prompt until the rest arrives.
		t.session.feed("Failed to login: ");
		t.session.feed("This email address does not exist. Please try again with a different email address.\n");
		t.session.feed("Password: ");
		expect(t.writes).toEqual(["hunter2\n"]);
		expect(t.interrupts()).toBe(1);
		expect(t.session.state()).toMatchObject({ phase: "failed", error: "This email address does not exist. Please try again with a different email address." });
		t.session.exit(0);
		expect(t.session.state().phase).toBe("failed");
	});

	it("asks for the 2FA code, and again with Proton's error after a wrong one", () => {
		const t = signedIn();
		t.session.feed("Enter the code from your authenticator app: ");
		expect(t.session.state()).toMatchObject({ phase: "needs-code", prompt: 1, error: null });
		expect(t.session.answer({ prompt: 1, value: " 123456 " })).toBe(true);
		expect(t.writes.at(-1)).toBe("123456\n");
		expect(t.session.state().phase).toBe("signing-in");
		t.session.feed("\nFailed to submit 2FA code: Incorrect login credentials. Please try again.\nEnter the code from your authenticator app: ");
		expect(t.session.state()).toMatchObject({ phase: "needs-code", prompt: 2, error: "Incorrect login credentials. Please try again." });
		t.session.feed("\nFailed to login: Max attempts reached\n");
		t.session.exit(1);
		expect(t.session.state()).toMatchObject({ phase: "failed", error: "Too many tries. Start again to have another go." });
	});

	it("asks for the mailbox password of a two-password account", () => {
		const t = signedIn();
		t.session.feed("Mailbox Password: ");
		expect(t.session.state()).toMatchObject({ phase: "needs-mailbox-password", prompt: 1 });
		// Exactly as typed: spaces at either end are part of it.
		expect(t.session.answer({ prompt: 1, value: " second secret " })).toBe(true);
		expect(t.writes.at(-1)).toBe(" second secret \n");
	});

	it("passes on Proton's human check and goes on when told", () => {
		const t = tool();
		t.session.feed(`${BANNER}Password: `);
		t.session.feed(
			`\nHuman Verification requested. Please open the URL below in a browser and press ENTER when the challenge has been completed.\n\n${VERIFY}\n\nPress ENTER to continue: `,
		);
		expect(t.session.state()).toMatchObject({ phase: "needs-verification", prompt: 1, verifyUrl: VERIFY });
		expect(t.session.answer({ prompt: 1, value: "" })).toBe(true);
		expect(t.writes).toEqual(["hunter2\n", "\n"]);
		expect(t.session.state()).toMatchObject({ phase: "signing-in", verifyUrl: null });
	});

	it("refuses a human check with no link, rather than send someone nowhere", () => {
		const t = signedIn();
		t.session.feed("Press ENTER to continue: ");
		expect(t.session.state().phase).toBe("failed");
		expect(t.interrupts()).toBe(1);
	});

	it("refuses stale, repeated, and multi-line answers", () => {
		const t = signedIn();
		expect(t.session.answer({ prompt: 0, value: "123456" })).toBe(false);
		t.session.feed("Enter the code from your authenticator app: ");
		expect(t.session.answer({ prompt: 2, value: "123456" })).toBe(false);
		expect(t.session.answer({ prompt: 1, value: "   " })).toBe(false);
		expect(t.session.answer({ prompt: 1, value: "123456\nyes" })).toBe(false);
		expect(t.session.answer({ prompt: 1, value: "123456" })).toBe(true);
		expect(t.session.answer({ prompt: 1, value: "123456" })).toBe(false);
		expect(t.writes).toEqual(["hunter2\n", "123456\n"]);
	});

	it("goes on past the disk-space question, since files leave as they're exported", () => {
		const t = signedIn();
		t.session.feed("\nThis operation requires at least 9000 MB of free space, but the destination volume only has 7000 MB available. \n");
		t.session.feed("Type 'Yes' to continue or 'No' to abort in the prompt below.\n\nDo you wish to proceed?: ");
		expect(t.writes.at(-1)).toBe("yes\n");
		expect(t.session.state().phase).toBe("signing-in");
	});

	it("stops when asked for something it should have been given", () => {
		const t = tool();
		t.session.feed(`${BANNER}Username: `);
		expect(t.session.state()).toMatchObject({ phase: "failed", error: 'Proton\'s export tool asked for something Magnus doesn\'t have ("Username").' });
		expect(t.writes).toEqual([]);
		expect(t.interrupts()).toBe(1);
	});

	it("reports the tool's errors without the account's address or a human-check link", () => {
		const t = signedIn();
		t.session.feed("Starting Export - Path=/export/derpy@proton.test/mail_20261012_201614\n");
		t.session.feed("Failed to export: write /export/derpy@proton.test/mail_20261012_201614/a.eml: no space left on device\n");
		t.session.exit(1);
		expect(t.session.state()).toMatchObject({
			phase: "failed",
			error: "write /export/your Proton address/mail_20261012_201614/a.eml: no space left on device",
		});

		// Killed while waiting on the human check: its link was the last thing said, and isn't repeated.
		const hv = tool();
		hv.session.feed(`${BANNER}Password: \nHuman Verification requested.\n\n${VERIFY}\n\nPress ENTER to continue: `);
		hv.session.exit(137);
		expect(hv.session.state().error).not.toContain("verify.proton.me");
		expect(hv.session.state().error).not.toContain("derpy");

		const login = signedIn();
		login.session.feed("Failed to login: Account derpy is disabled\nPassword: ");
		expect(login.session.state().error).toBe("Account your Proton account is disabled");

		// As 1.0.7 prints it when Proton has switched it off.
		const off = tool();
		off.session.feed(`${BANNER}Due to a technical problem, we temporarily disabled the Export Tool. Check https://status.proton.me/ for updates.\n`);
		off.session.exit(1);
		expect(off.session.state().error).toMatch(/Proton has paused its export tool/);
	});

	it("stops when asked, and the tool's exit then counts as stopped", () => {
		const t = signedIn();
		t.session.feed("Starting Export - Path=/export\n");
		t.session.stop();
		expect(t.interrupts()).toBe(1);
		t.session.feed("\nReceived Ctrl+C, exiting as soon as possible\n");
		t.session.exit(0);
		expect(t.session.state().phase).toBe("stopped");
		// A prompt after being asked to stop isn't answered.
		t.session.feed("Password: ");
		expect(t.writes).toEqual(["hunter2\n"]);
	});
});
