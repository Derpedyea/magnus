# Deploying Magnus

Everything below runs against your own Cloudflare account, by hand, in order. Steps that change DNS or mail
flow are marked ⚠️. The examples use `example.com`; substitute your domain throughout.

**Turning on Email Routing for a domain replaces its MX records**, so whatever receives that domain's mail
today stops receiving it immediately. Turning on Email Sending only adds records under `cf-bounce.<domain>`
(plus `_dmarc`), so it's safe while another provider still receives. If you can, pilot on a domain with no
mail yet.

## 0. Prerequisites

- A Cloudflare account on **Workers Paid** ($5/mo). Email Sending to arbitrary recipients requires it.
- Your domain(s) on Cloudflare DNS.
- Node 22+, pnpm 10, then `pnpm install` at the repo root and `npx wrangler login`.

## 1. Create resources

```sh
npx wrangler d1 create magnus-directory
#   → paste the printed database_id into apps/mx/wrangler.jsonc AND apps/web/wrangler.jsonc

npx wrangler r2 bucket create magnus-mail
npx wrangler r2 bucket lifecycle add magnus-mail reap-uploads uploads/ --expire-days 14

npx wrangler queues create magnus-inbound
npx wrangler queues create magnus-inbound-dlq
npx wrangler queues create magnus-email-events
```

## 2. Point the config at your domain

| File | Key | Set to |
| --- | --- | --- |
| `apps/mx/wrangler.jsonc` | `addresses` | `*@example.com` for each domain that receives here |
| `apps/web/wrangler.jsonc` | `routes[0].pattern` | Where the web app lives, e.g. `mail.example.com` |
| | `vars.BETTER_AUTH_URL` | `https://` + that hostname |
| | `vars.LOGIN_CODE_FROM` and `send_email[0].allowed_sender_addresses` | The address sign-in codes come from, e.g. `login@example.com` |

## 3. Directory schema and data

```sh
pnpm db:migrate:remote
```

Then create your users, mailboxes, and addresses. Copy `packages/directory/seed/dev.sql` as a template: swap
`dev@localhost` for the email you'll sign in with, and use your real domains and local parts. Only set
`receiving = 1` for domains whose MX actually points at Cloudflare.

```sh
npx wrangler d1 execute magnus-directory --remote --file path/to/your-seed.sql
```

## 4. Google sign-in

Only emails in `users.login_email` (step 3) can sign in; anyone else is turned away after Google. The other
way in, a code emailed to that address, needs nothing here and starts working once step 6 turns on Email
Sending for the `LOGIN_CODE_FROM` domain.

1. Google Cloud console → **Google Auth Platform**: create a project, then under **Branding** name the app.
   Audience: External, publishing status **In production** (it only asks for `openid`, `email`, and
   `profile`, which need no Google review).
2. **Clients → Create client → Web application.** Authorized redirect URI:
   `https://mail.example.com/api/auth/callback/google`. For real sign-in locally, also add
   `http://localhost:5173/api/auth/callback/google` and put the same pair in `apps/web/.dev.vars`.
3. Put the client ID in `apps/web/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`, then set the secrets:

   ```sh
   cd apps/web
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   openssl rand -base64 32 | npx wrangler secret put BETTER_AUTH_SECRET
   ```

   Rotating `BETTER_AUTH_SECRET` signs everyone out.

## 5. Deploy (order matters: the DO class must exist before bindings reference it)

```sh
(cd apps/mailstore && npx wrangler deploy)
(cd apps/web && pnpm build && npx wrangler deploy)      # creates the custom domain from step 2
# mx is deployed in step 6, together with routing
```

## 6. ⚠️ First domain

```sh
npx wrangler email routing enable example.com          # apex MX/SPF/DKIM for inbound
npx wrangler email sending enable example.com          # cf-bounce MX/SPF/DKIM + DMARC for outbound
npx wrangler email sending dns get example.com         # confirm records
(cd apps/mx && npx wrangler deploy)                    # installs the *@example.com catch-all → magnus-mx
```

Subscribe delivery events. The zone ID is on the domain's Overview page in the dashboard. Confirm the event
names with `npx wrangler queues subscription create --help`:

```sh
npx wrangler queues subscription create magnus-email-events \
  --source email.sending --zone-id <zone id> --domain example.com \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
```

Smoke test:

1. From another account, write to `you@example.com`, then to `you+test@example.com` (it should land with a
   `test` label). Write to a nonexistent address too; it should bounce at SMTP time unless you set a
   catch-all mailbox.
2. Reply from the web app. In Gmail, open **Show original** and check SPF/DKIM/DMARC = PASS. Also check that
   the `Message-ID` matches the one on the Sent message ([ARCHITECTURE §7](ARCHITECTURE.md#7-things-to-verify-on-the-first-real-send)).
3. Reply again from the other account and confirm it threads onto the same conversation.
4. Within a minute, the Sent message's badge should change from `sent` to `delivered` (event subscription).

## 7. ⚠️ Domains that already receive mail elsewhere

**Send first (optional).** You can send as the domain while your current provider keeps receiving:

```sh
npx wrangler email sending dns get example.net         # review first: does it touch your existing _dmarc?
npx wrangler email sending enable example.net
```

Set `domains.sending = 1` for it in D1 and repeat the event subscription. Replies still go to the old
provider until you cut over receiving.

**Cut over receiving**, per domain, when you're ready:

1. Export your history from the old provider (`.eml`). Importing it is roadmap item 6 in
   [ARCHITECTURE.md](ARCHITECTURE.md#8-roadmap).
2. Lower the TTL on the existing MX records a day ahead.
3. `npx wrangler email routing enable example.net`. This replaces the old MX records. From here, mail
   arrives in Magnus.
4. Add `"*@example.net"` to `addresses` in `apps/mx/wrangler.jsonc`, set `domains.receiving = 1`, and
   redeploy mx.
5. Afterwards, remove the old provider's SPF `include:`, DKIM records, and verification TXT, and tighten DMARC
   to `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.net` (then `p=reject` once reports are clean).

Rollback: restore the old MX records (and remove the Email Routing ones). The raw copy of every message that
arrived in the meantime is in R2 under `raw/`.

## Operations cheat sheet

```sh
npx wrangler tail magnus-mx                    # live inbound logs (accepted/rejected/ingested)
npx wrangler tail magnus-mailstore             # outbox sends, failures
npx wrangler queues info magnus-inbound-dlq    # anything stuck?
npx wrangler d1 execute magnus-directory --remote --command "SELECT * FROM addresses"
```
