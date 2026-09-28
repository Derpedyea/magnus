# Magnus

Self-hosted email for your own domains, running entirely on Cloudflare. There's no mail server to patch and
no IP reputation to nurse: Email Routing receives, Email Sending delivers, Workers, Durable Objects, D1, R2,
and Queues handle everything in between, and a fast web client sits on top.

![Magnus: one inbox across three addresses, with a threaded conversation open](docs/screenshot.png)

> **Status: early.** Receiving, threading, search, sending, and delivery tracking work end to end. It's built
> for a few people on a few domains. Read [the constraints](docs/ARCHITECTURE.md#1-what-the-platform-gives-us-and-doesnt)
> before moving real mail onto it.

## Features

- **Every address, one inbox.** Any number of domains and addresses feed one mailbox. Filter by address in a
  click. Group aliases like `family@` can fan out to several people's mailboxes.
- **`+tag` becomes a label.** Mail to `me+receipts@` lands under *receipts* automatically.
- **Rejects during the SMTP session.** Unknown recipients and blocked senders bounce before the message is
  accepted, so Magnus never sends backscatter.
- **Real threading** by `Message-ID`/`References`, with a careful subject fallback. Replies thread in Gmail,
  Apple Mail, and Outlook too.
- **Full-text search**, undo send, and a delivery badge on every sent message (delivered, bounced, …).
- **Live updates** over hibernatable WebSockets, so idle tabs cost nothing.
- **Hostile HTML stays contained**: streaming sanitizer, strict CSP, sandboxed iframe, and remote images
  blocked until you ask.
- **Sign in with Google or an emailed code.** There's no sign-up; only people you add can get in.
- **Every raw message is kept in R2**, so a parsing bug is fixed by replaying the queue, not by losing mail.

## How it works

```
Internet ── SMTP ──▶ Email Routing ──▶ magnus-mx ──▶ raw .eml to R2 ──▶ Queue ──▶ parse ──▶ Mailbox DO
Browser ── HTTPS ──▶ magnus-web ──── RPC / WebSocket ────────────────────────────────────▶ Mailbox DO
                                                        Mailbox DO ── alarm ──▶ Email Sending ──▶ recipients
```

| Worker | Role |
| --- | --- |
| `apps/mx` → **magnus-mx** | Accepts or rejects at SMTP time, stores the raw message, parses it, routes delivery events |
| `apps/mailstore` → **magnus-mailstore** | One `Mailbox` Durable Object (SQLite) per mailbox: threads, labels, search, outbox, live updates |
| `apps/web` → **magnus-web** | React client and JSON API, sign-in via Better Auth |

They deploy independently, so mail keeps arriving while the web app redeploys. Shared contracts live in
`packages/shared`, and the D1 directory (domains, users, addresses, routes) in `packages/directory`.
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) covers the full design and its tradeoffs.

## Run it locally

Needs Node 22+ and pnpm 10. No Cloudflare account required.

```sh
git clone https://github.com/Derpedyea/magnus && cd magnus
pnpm install
pnpm db:migrate:local && pnpm db:seed:local       # a dev user, two domains, three addresses
sed "s|^BETTER_AUTH_SECRET=|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" \
  apps/web/.dev.vars.example > apps/web/.dev.vars
pnpm dev                                          # mailstore :8790, mx :8791, web :5173
```

Open http://localhost:5173. You're signed in as the seeded dev user (`DEV_USER_EMAIL`, honored only on
localhost). Send it some mail through the real `email()` handler:

```sh
pnpm mail:test                                                  # → me@example.com
pnpm mail:test "me+receipts@example.com" shop@example.org "Your receipt"
pnpm mail:test me@example.com friend@example.org "Re: hi" --reply-to "<some-message-id@host>"
```

Nothing is really sent locally. Outbound mail is written to `apps/mailstore/.wrangler/tmp/email/`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | All Workers in watch mode, sharing D1/R2 state in `.wrangler/state/` |
| `pnpm typecheck` | `tsc` across every package |
| `pnpm test` | Unit tests (threading, addressing, multi-mailbox views) |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after changing any `wrangler.jsonc` |
| `pnpm db:migrate:local` / `db:migrate:remote` | Apply D1 migrations |

## Deploy

You need a Cloudflare account on **Workers Paid** ($5/month, which includes 3,000 outbound emails) and your
domains on Cloudflare DNS. Everything else for a few people fits in the included usage.
[docs/DEPLOY.md](docs/DEPLOY.md) walks through creating resources, pointing the config at your domain,
sign-in, and moving a domain over from your current provider without losing mail.

## Limitations

- **Web client only.** No IMAP, POP, or JMAP, by design. Phones use the web app.
- **Personal mail, not bulk.** Cloudflare Email Sending is for transactional mail. Don't send newsletters
  from it.
- **Outbound messages max out at 5 MiB** including attachments (inbound allows 25 MiB).

Next up: a mobile layout and installable app, push notifications, drafts, forwarding, and importing mail
from other providers. The full list is in [the roadmap](docs/ARCHITECTURE.md#8-roadmap).

## License

[MIT](LICENSE)
