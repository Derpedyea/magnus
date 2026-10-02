# Deploying Magnus

You need a Cloudflare account on **Workers Paid** ($5/month; Email Sending to arbitrary recipients requires it)
and a domain whose DNS is on Cloudflare.

## 1. Deploy

**With the button** (recommended):
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Derpedyea/magnus)

Cloudflare copies the repository to your GitHub, creates the D1 database, R2 bucket, and queues, and deploys
the Worker. Every push to that copy triggers Workers Builds.

In the Worker's **Settings → Builds → Build configuration**, set **Build command** to:

```sh
pnpm typecheck && pnpm test && pnpm run build
```

Keep **Deploy command** as `npx wrangler deploy`. A failed typecheck, test, or build stops deployment;
the current version keeps running. Build settings live in Cloudflare, so set this for each install.

**From the command line** instead:

```sh
git clone https://github.com/Derpedyea/magnus && cd magnus
pnpm install
npx wrangler login
npx wrangler queues create magnus-inbound       # once; wrangler doesn't create queues itself
npx wrangler queues create magnus-email-events
pnpm run deploy        # typechecks, tests, and builds; creates the database and bucket on first deploy
```

The Worker applies the D1 schema itself and generates the session secret on first run.

## 2. Set up

Open the Worker's URL, `https://magnus.<your-subdomain>.workers.dev`. Until someone finishes setup, every
page leads to `/setup`:

1. **Connect Cloudflare.** *Create a token* opens Cloudflare's token page with every permission filled in.
   Create the token and paste it. It must belong to the account Magnus is deployed to: setup looks for this
   exact deployment in it, which is how it knows you own this install and aren't a stranger who found the URL
   first. Magnus keeps the token encrypted, so nobody has to paste one again.
2. **Pick your domain.** Each one shows who receives its mail today.
3. **Create your account:** your name, your new address, and a *sign-in email* somewhere else (your current
   inbox), where sign-in codes go.
4. **Turn on the domain.** Magnus does it, one step at a time:
   Email Routing, a catch-all rule sending every address to this Worker, Email Sending, a delivery-event
   subscription, and MTA-STS. Sending usually waits a minute for DNS; *Check again* picks it up.

Then you're in. Everything else happens under **Admin** in the sidebar.

### The token's permissions

| Permission | Why |
| --- | --- |
| Account · Workers Scripts · Read | Find this install in your account |
| Account · Queues · Edit | Subscribe the delivery-events queue to Email Sending |
| Account · Email Sending · Edit | Turn on sending for a domain |
| Zone · Zone · Read | List your domains |
| Zone · Zone Settings · Edit | Turn on Email Routing |
| Zone · DNS · Edit | Read MX records, remove another provider's when you move a domain, and publish MTA-STS |
| Zone · Workers Routes · Edit | Serve the MTA-STS policy at `mta-sts.<domain>` from this Worker |
| Zone · Email Routing Rules · Edit | Point the catch-all at this Worker |

The token is saved encrypted. A Durable Object holds the key and D1 holds only the ciphertext, so a D1 backup
or an R2 or D1 API token reveals nothing. Adding and turning on domains use it without asking. *Use a different
token* in the Turn on dialog replaces it, and *Forget it* under the domain list deletes it. Cloudflare's 30-day
recovery can still bring a forgotten one back, so to end a token for certain, revoke it in Cloudflare. Magnus
then says so the next time it needs one, and *Use a different token* takes a new one.

Installs from before MTA-STS have a token without Workers Routes · Edit. The MTA-STS step says so; create a
new token and give it to *Use a different token*.

## 3. Admin

- **Domains.** Add more of your Cloudflare domains, turn them on, and choose what happens to mail for
  addresses that don't exist: reject it (the default), or deliver it to someone.
- **People.** Add someone with their own mailbox and address; they sign in with a code sent to their sign-in
  email. Make them an admin, suspend them (they can't sign in, but their mail keeps arriving), or remove
  them (their mailbox and its mail are deleted).
- **Addresses.** Add addresses and choose who receives them. Several people makes a shared address like
  `family@`: each gets a copy and can reply from it.

## Moving a domain from another provider

A domain that gets mail elsewhere (Proton, Google, …) shows that provider when you pick it. Turning it on
removes the provider's MX records and adds Cloudflare's, so **mail stops arriving at the old provider right
away**, and Magnus asks you to confirm first. Before you do:

1. Export your old mail (usually to `.eml`). Importing it is on the [roadmap](ARCHITECTURE.md#8-roadmap).
2. Lower the TTL on the existing MX records a day ahead, so the switch spreads quickly.

Moving also replaces the old provider's MTA-STS records, if it had any: their policy names its own mail servers,
so senders that check it would refuse to deliver to Cloudflare's.

Afterwards, remove the old provider's SPF `include:`, DKIM records, and verification TXT from the zone, and
tighten DMARC to `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.net` (then `p=reject` once the reports
look clean).

To roll back, restore the old MX records in Cloudflare DNS. Every message that arrived in the meantime is in
R2 under `raw/`.

## A custom domain for the app

The app works at its `workers.dev` URL. To use something like `mail.example.com`, add it under the Worker's
**Settings → Domains & Routes** in the Cloudflare dashboard. Sign-in works on both.

Do this before sending large files. Their download links use the address you sent from, and spam filters
trust your own domain far more than `workers.dev`, which phishing kits use heavily.

## Google sign-in (optional)

Codes by email need nothing extra. To add "Continue with Google":

1. In Google Cloud's **Google Auth Platform**, create a web client with the redirect URI
   `https://<your Magnus host>/api/auth/callback/google`.
2. Set both halves as secrets: `npx wrangler secret put GOOGLE_CLIENT_ID`, then `GOOGLE_CLIENT_SECRET`.

Only people already added can sign in with Google, matched by their sign-in email.

## Updating

With the button, your copy is a new repository in your GitHub account. Pull this one into it and push, and
Workers Builds runs the checks above before redeploying:

```sh
git remote add upstream https://github.com/Derpedyea/magnus   # once
git pull upstream main && git push
```

From the command line, `git pull && pnpm run deploy` runs the same checks before deployment. If an automatic
build fails, open the Worker's **Deployments** page for its build log, fix the error, and push again. New D1
migrations apply themselves when the updated Worker first runs.

## Operations cheat sheet

```sh
npx wrangler tail magnus                                      # live logs: accepted/rejected/ingested, sends
npx wrangler d1 execute DIRECTORY --remote --command "SELECT address, domain FROM addresses"
# Optional: reap legacy temporary uploads. Saved draft files use a separate prefix and do not expire.
npx wrangler r2 bucket lifecycle add magnus-mail reap-uploads uploads/ --expire-days 14
```

An hourly Worker cron cleans up unreferenced draft files after 24 hours. Saved drafts and queued sends retain
their files; failed cleanup is retried on the next run. The cron is configured in `wrangler.jsonc`.

A message that still fails to parse after its retries is logged as `queue message failed`, with its raw copy's
R2 key. Send its job to the inbound queue again to replay it.
