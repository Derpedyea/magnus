#!/usr/bin/env node
// Simulate an inbound SMTP delivery to the local Worker (`pnpm dev`).
// Usage: pnpm mail:test [to] [from] [subject] [--reply-to <Message-ID>]
const args = process.argv.slice(2);
const replyIdx = args.indexOf("--reply-to");
const inReplyTo = replyIdx >= 0 ? args.splice(replyIdx, 2)[1] : null;
const [to = "me@example.com", from = "friend@example.org", subject = "Hello from the outside"] = args;
const port = process.env.PORT ?? "5173";
const messageId = `<${crypto.randomUUID()}@example.org>`;
const boundary = `b-${crypto.randomUUID()}`;

const raw = [
	`Received: from mail.example.org (127.0.0.1) by mx.cloudflare.net; ${new Date().toUTCString()}`,
	"Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org",
	"X-CF-SpamH-Score: 1",
	`From: "A Friend" <${from}>`,
	`To: ${to}`,
	`Subject: ${subject}`,
	`Date: ${new Date().toUTCString()}`,
	`Message-ID: ${messageId}`,
	...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
	"MIME-Version: 1.0",
	`Content-Type: multipart/alternative; boundary="${boundary}"`,
	"",
	`--${boundary}`,
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Hi! This is a test message routed through the email() handler.",
	"",
	`--${boundary}`,
	"Content-Type: text/html; charset=utf-8",
	"",
	'<p>Hi! This is a <b>test</b> message.</p><img src="https://example.org/pixel.gif" width="1" height="1"><script>alert(1)</script>',
	"",
	`--${boundary}--`,
	"",
].join("\r\n");

const url = new URL(`http://localhost:${port}/cdn-cgi/local/email`);
url.searchParams.set("from", from);
url.searchParams.set("to", to);
const res = await fetch(url, { method: "POST", body: raw });
console.log(`${res.status} ${res.statusText} ${await res.text()}`.trim());
console.log(`Message-ID: ${messageId}`);
