import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("new mail shows in the inbox and opens", async ({ app, screen }) => {
	const subject = `Lunch on Friday? ${crypto.randomUUID().slice(0, 8)}`;
	await deliver(app.baseUrl, { from: "me@example.net", to: "me@example.com", subject, text: "Noon at the usual place." });

	await app.open("/");
	await screen.getByText(subject).tap({ timeout: 30_000 });
	const thread = screen.getByRole("article").filter({ has: screen.getByRole("heading", subject) });
	await expect(thread.getByText("Noon at the usual place.")).toBeVisible();
});

test("a reply shows in its conversation", async ({ app, agent, browser, screen }) => {
	const subject = `Dinner plans ${crypto.randomUUID().slice(0, 8)}`;
	await deliver(app.baseUrl, { from: "me@example.net", to: "me@example.com", subject, text: "Pizza or tacos?" });

	await app.open("/");
	await screen.getByText(subject).tap({ timeout: 30_000 });
	await agent.act("reply {text}", { params: { text: "Tacos, see you at 7." } });
	// Sent mail shows its HTML part in a frame of its own, so this can't match the text still in the reply box.
	await expect(browser.frameLocator('iframe[title="Message body"]').getByText("Tacos, see you at 7.")).toBeVisible();
});

/**
 * Hands a message to the Worker's email() handler, as Email Routing would. From one of the seed's own domains, with
 * passing checks, so it's trusted and no remote AI check runs.
 */
async function deliver(baseUrl: string | undefined, mail: { from: string; to: string; subject: string; text: string }) {
	const domain = mail.from.split("@")[1];
	const raw = [
		`Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=${domain}; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`,
		`From: ${mail.from}`,
		`To: ${mail.to}`,
		`Subject: ${mail.subject}`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@${domain}>`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		mail.text,
	].join("\r\n");
	const url = new URL("/cdn-cgi/local/email", baseUrl);
	url.searchParams.set("from", mail.from);
	url.searchParams.set("to", mail.to);
	const res = await fetch(url, { method: "POST", body: raw });
	expect(res.ok).toBe(true);
}
