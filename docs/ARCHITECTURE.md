# Magnus — architecture

Self-hosted mail for a few people on their own domains, running entirely on
Cloudflare: Email Routing for inbound, Email Sending for outbound, Workers + Durable Objects + D1 + R2 +
Queues for everything in between, and a web client served from Workers.

## 1. What the platform gives us (and doesn't)

Verified against the Email Service docs (Sept 2026). These facts shape every decision below.

| | Inbound (Email Routing) | Outbound (Email Sending) |
| --- | --- | --- |
| Entry point | MX → Cloudflare → `email()` handler of a Worker | `send_email` binding (`env.EMAIL.send`) / REST / SMTP (`smtp.mx.cloudflare.net:465`) |
| Size limit | 25 MiB per message | **5 MiB** per message incl. attachments, 32 attachments, 50 recipients |
| Auth | SPF/DKIM/DMARC/ARC checked upstream. DMARC-policy failures and RBL-listed IPs are rejected before our code runs | SPF/DKIM/DMARC records auto-created on `cf-bounce.<domain>` + `_dmarc` |
| Invocation | Once per envelope recipient (`message.to` is one address). Catch-all rules exist for the apex only. `+tag` subaddressing falls back to the base rule | — |
| Headers | Full raw MIME available (`message.raw`, single-use stream) | **Message-ID is platform-assigned** (returned as `messageId`). `In-Reply-To`/`References` allowed, 2,048 B per value |
| Status | — | Event subscriptions → Queue: `delivered`, `deferred`, `bounced`, `failed`, `rejected`, `complained` |
| Price | Free (Worker CPU billed normally) | Workers Paid: 3,000/month included, then $0.35 / 1,000 |

Constraints worth being honest about:

- **Web client only, by choice.** Cloudflare doesn't host mailboxes, so there's no IMAP/POP out of the box.
  Running our own IMAP server became possible in August 2026 (private beta: Workers `connect(socket)` behind a
  Spectrum app), but for a handful of users it isn't worth the protocol work. Phones use the web app
  installed to the home screen, with push notifications. See the roadmap.
- **"Transactional" positioning.** Cloudflare describes Email Sending as transactional and forbids marketing and
  bulk mail. One person writing to other people isn't bulk, but don't use this system for newsletters or
  mass mail. That could put the account's sending reputation at risk.
- **We can't choose Message-IDs.** The ID Cloudflare assigns is stored and registered for threading
  (see §5.5).

## 2. Topology

```
                    ┌─────────────────────── Cloudflare ─────────────────────────────────────────────┐
  Internet MTAs     │                                                                                │
  ── SMTP :25 ──▶  Email Routing (catch-all *@domain) ──▶ email() ──▶ R2 raw/…/<ulid>.eml            │
                    │                                        │                                       │
                    │                                        └──▶ Queue magnus-inbound ──┐           │
                    │                                                                    ▼           │
                    │   D1 magnus-directory ◀───────────────────────────────────── queue(): parse    │
                    │   (people, domains,                                    (postal-mime) │ ──▶ R2   │
                    │    addresses, settings)                                              │ RPC      │
                    │          ▲                                                           ▼          │
  Browser ─ HTTPS ──────────▶ fetch(): React app + Hono API ──── RPC ────▶ Mailbox DO (1 per mailbox) │
  (*.workers.dev    │         /api/* (mail, setup, admin,         ◀─ WS ── SQLite: threads, labels,   │
   or your domain)  │         Better Auth)                                 FTS5, outbox, deliveries ──── alarm ──▶ Email Sending
                    │                                                                  ▲                 │
                    │   Email Sending events ──▶ Queue magnus-email-events ──▶ queue() ─┘                │
                    └────────────────────────────────────────────────────────────────────────────────┘
```

**One Worker**, `magnus`, with four entry points:

| Entry | Code | Role |
| --- | --- | --- |
| `email()` | `worker/mail/inbound.ts` | SMTP-time accept/reject, raw capture to R2, enqueue |
| `queue()` | `worker/mail/` | Parse inbound mail into its mailbox; apply delivery events. Messages are told apart by shape, since queues can be renamed at deploy |
| `fetch()` | `worker/api.ts`, `worker/links.ts`, `worker/mta-sts.ts`, `src/` | The React app (static assets), `/api/*` (mail, `/setup`, `/admin`, Better Auth), `/f/*` downloads for files sent as links, and each domain's MTA-STS policy |
| `Mailbox` | `worker/mailbox/` | The Durable Object class that owns all mail data and the outbox |

Why one Worker: it's what the Deploy to Cloudflare button can install in one click, it deploys as a unit, and
local development is a single `vite dev`. The earlier design split inbound, storage, and web into three Workers
so a broken web deploy couldn't stop mail. The trade is accepted because the entry points share no
module-level state that can fail at import, and Workers keeps previous versions for instant rollback.

`shared/` holds what the browser and the Worker both use: DTOs, queue payloads, the R2 key layout, threading
and address utilities, and zod schemas (a separate `#shared/schemas` entry, so the mail path doesn't bundle zod).
The Worker types its Durable Object stubs from the `Mailbox` class itself.

### Resources and migrations

`wrangler.jsonc` names every resource but gives no IDs, so the first deploy (from the button or `wrangler
deploy`) creates them. D1 migrations (`migrations/*.sql`) are applied by the Worker the first time each instance
touches D1 (`worker/migrate.ts`), recorded in wrangler's own `d1_migrations` table, so a deploy never needs a
separate migration step. The Mailbox schema migrates itself the same way, per object.

## 3. Storage

Each store holds one kind of data:

| Store | Holds | Why this store |
| --- | --- | --- |
| **D1 `magnus-directory`** | people and sessions (Better Auth), domains, mailboxes, memberships, addresses, address→mailbox routes, sender blocks, install settings | Small, global, read on every inbound message and every API call |
| **Durable Object `Mailbox`** (SQLite, one per mailbox) | threads, messages, labels, attachment metadata, Message-ID→thread index, FTS5 index, outbox, per-recipient delivery state | Strongly consistent per-mailbox transactions, a natural isolation boundary, alarms for scheduled send, hibernatable WebSockets for live push, 10 GB each |
| **Durable Object `Vault`** (one instance) | the key to the saved Cloudflare token | Its storage can only be read from outside with edit access to this Worker, which could read any secret anyway. D1 and R2 can be read with much narrower tokens |
| **R2 `magnus-mail`** | raw `.eml`, HTML bodies, attachments, composer uploads | Blobs. Cheap, no egress fees |
| **Queues** | `magnus-inbound`, `magnus-email-events` | Durable hand-off with retries. Parsing never blocks the SMTP session |

### D1 directory (`migrations/0001_init.sql`)

```
auth_users(id, name, email, role, banned, …)                  ← Better Auth + admin plugin; email = where codes go
auth_sessions, auth_accounts, auth_verifications, …          ← Better Auth's own
auth_passkeys(userId, credentialID, publicKey, counter, …)    ← passkey plugin; one row per passkey, gone with its person
settings(key, value)                                         ← install (account, Worker name), session secret, saved Cloudflare token (encrypted)
domains(name, zone_id, receiving, sending, catch_all_mailbox_id)
mailboxes(id, name)                                          ← id = Durable Object name
mailbox_members(mailbox_id, user_id, role)                   ← user_id → auth_users; everyone gets their own
addresses(address, domain, display_name, enabled)            ← normalized, no +tag
address_routes(address, mailbox_id, can_send)                ← >1 row = group alias (e.g. family@)
sender_blocks(pattern)                                       ← 'x@y.com' or '*@y.com', matched against the envelope sender and From header at SMTP time
signatures(user_id, address, text, markdown)                 ← per person and address they send as; the composer adds it. markdown = 0: plain text from before, escaped on read
push_subscriptions(endpoint, session_id, p256dh, auth, origin) ← a browser to notify, one per session, gone with it (§4.6)
```

### Mailbox DO schema (`worker/mailbox/schema.ts`)

`threads`, `messages`, `message_labels`, `message_addresses`, `attachments`, `thread_refs`, `outbox`, `deliveries`,
`contacts`, `sends` (every id Email Sending gave a message), `messages_fts` (FTS5, porter + unicode61). Migrations are an append-only array applied in `blockConcurrencyWhile`.

Labels follow the Gmail model: they live on messages, and a thread appears in a view if any of its messages
has the label. System labels are `inbox`, `sent`, `outbox`, `spam`, `trash`, `starred`. "Archive" means
removing `inbox`, and "All mail" is a pseudo-view. `+tag` subaddresses become labels automatically
(`me+receipts@…` → `receipts`).

### Mailboxes vs. addresses

A **mailbox** is an access boundary (who can read it), not a domain. One person's `me@` on every domain belongs
in one mailbox; a shared `family@` can be its own mailbox with several members. **Addresses** are how you slice
the mail: `message_addresses` records which of our addresses each message was delivered to (+tag stripped) or
sent from. List, search, and count reads take an optional address filter.

`GET /api/threads`, `/api/search`, and `/api/counts` span every mailbox the user belongs to. The API fans
out to each Mailbox DO and merges the results (`shared/scope.ts`); `?in=a@x,b@y` narrows the view
to some addresses. Lists and search both run newest first (ties broken by thread id) and come 50 threads at a
time: each page's `next` goes back as `?cursor=` and resumes every mailbox just past the last thread shown.
Reads and writes on a single thread stay under `/api/mailboxes/:id/…`.

`GET /api/contacts` fans out the same way. Each mailbox's `contacts` table remembers who it has written to
(counted on send) and heard from (on ingest, spam aside), and the API merges them into one list of up to a
thousand, people written to first (`shared/contacts.ts`). The composer fetches it once and matches what's typed
locally, so suggestions need no round trip.

### R2 layout (`shared/keys.ts`)

```
raw/2026/09/26/<ingestId>.eml          raw inbound, shared across fan-out, kept while a mailbox has it or lists it under Failed (source of truth)
m/<mailboxId>/<messageId>/body.html     HTML body (served through the sanitizer)
m/<mailboxId>/<messageId>/att/<attId>   attachments (inbound, and outbound once the outbox picks them up)
m/<mailboxId>/draft-files/<userId>/<uuid> account-owned draft sources; conflict copies can share one source
uploads/<mailboxId>/<uuid>              composer uploads; a lifecycle rule (DEPLOY.md) can reap abandoned ones
```

Everything a mailbox owns sits under `m/<mailboxId>/`, so deleting a mailbox (removing a person) is a prefix delete. Its
originals under `raw/` go too, unless another mailbox holds that message or is still due it from the queue. The raw archive
means any parsing bug can be fixed by re-queuing `InboundJob`s. Ingest is idempotent.

Every `m/` object is referenced by a row (`messages.html_key`, `attachments.r2_key`) or waits in the Mailbox's `trash`.
It's deleted only through `trash`, which keeps a key another row still has and retries until R2 deletes it; deleting a
whole mailbox is the one exception. Code that writes or drops `m/` objects keeps to this.

## 4. Flows

### 4.1 Inbound

1. A remote MTA delivers to Cloudflare MX. Email Routing enforces the size limit, DMARC policy, and RBLs, then
   invokes the Worker's `email()` once per recipient.
2. `resolveRecipient()` makes one D1 batch covering the exact address, the domain catch-all, and sender blocks.
   Unknown recipients get `setReject("5.1.1 …")` **during the SMTP session**, so we never send backscatter.
   A block matches the envelope sender or any address in the From header: bulk mail carries its sending service's
   bounce address on the envelope, and the header is what the app shows. Admins block from a message
   (the sender or their whole domain) or from Admin › Blocked senders.
3. The raw bytes are buffered once and written to R2. Then one `InboundJob` per target mailbox is enqueued
   (group aliases fan out here). Returning ends the SMTP transaction. If R2 or the queue fails, the handler
   throws instead of returning. Email Routing then answers `421 4.3.0` and the sender retries later, so the
   message is neither silently accepted nor bounced (§7 #4).
4. `queue()` first checks the target mailbox is still in the directory: one deleted since (its person removed,
   or a failed add undone) gets nothing, and its original goes once no mailbox it was queued for is left. Then it
   parses with postal-mime, writes the HTML and attachments to R2, extracts the `Authentication-Results`
   verdicts, works out who the sender verifiably is (§5.6), and calls `Mailbox.ingest()`. Only the verdicts
   Email Routing stamped count: its `mx.cloudflare.net` header above its `X-CF-SpamH-Score`, since everything
   below that came from the sender. SPF is the envelope sender's result, not the HELO name's. If the mailbox was
   deleted while that ran, it's cleared again (`destroy()`), in case its deletion got there first.
5. `ingest()` is idempotent. It dedupes on `ingestId` and on `Message-ID`, so the same mail arriving via two
   of our addresses, or our own outbound copy coming back, is stored once with merged labels. It decides between
   Inbox and Spam (§5.6), threads the message (§5.5), indexes it for search, and broadcasts `threads.changed`
   over WebSocket.

Failures retry with exponential backoff, 10 tries over about three hours. A message that still fails goes to its
mailbox's **Failed** box (a `failed` table in the Mailbox DO), which shows in the sidebar only while it holds mail.
From there a member can retry it (the job goes back in the queue, and `ingest()` removes it from Failed once it's
delivered), download the original, or delete it for good (a `deleted_messages` tombstone, like permanent deletion).
A try past the 10th lists it without parsing again: the earlier ones ended without reporting, so the Worker likely
crashed or ran out of time. The queue allows 10 more retries so that listing it is retried too, and only if all of
them fail is the job dropped, logged with its raw key. (There's no dead-letter queue: the Deploy button can't be
relied on to create one, and nobody would see it.)

### 4.2 Outbound

1. `POST /api/mailboxes/:id/send` validates the request (zod). It checks that `from` is one of **this mailbox's
   send identities** (`address_routes.can_send` on a domain with `sending = 1`), that attachments are this
   mailbox's own uploads (sizes re-read from R2, not trusted from the client). Files that would push the
   message past 5 MiB go as download links instead (§4.5).
2. `Mailbox.enqueueSend()` writes the message into the thread, labeled `outbox`, with status `queued`. For
   replies it computes `In-Reply-To`/`References` from the parent, capped at 2,048 bytes (root + newest IDs).
   It then inserts an `outbox` row with `send_at = now + delay` and sets a DO alarm.

   **Formatting:** the composer writes markdown (a Tiptap editor; `src/markdown.ts` fixes the dialect), and
   `noteBody()` (`shared/markdown.ts`) renders both parts from it: HTML with inline styles and no text colours,
   spaced like the editor, and plain text the way Gmail writes it for rich mail. The route sizes the message
   from those, and the DO renders them again with the file links in place.

   **Forwards** (`shared/forward.ts`) name the original message rather than copying it into the composer, the
   way EmailEngine's `reference` does. Below the note go Gmail's divider and header, then the original: its text,
   and its HTML document with the note and header inserted at the top of `<body>`, so its layout and styles
   survive. The files the sender kept are copied like uploads; images the HTML shows by `cid:` go inline and
   never as links. The forward joins the original's thread, with the same threading headers as a reply.
3. **Undo send / scheduled send:** until `send_at`, `cancelSend()` removes the message. The UI shows a 10 s
   undo toast. Delays up to 7 days work as scheduled send.
4. `alarm()` drains due rows. Each first copies its composer attachments to permanent message keys under `m/…`, and reads the attached
   ones, while still `queued`, so Undo still works and a copy cut short is redone. Undo deletes the message's own
   files from R2 (copies, a retry's files, its body), retried by the alarm if R2 refuses, except any a forward still
   sends from: a forward uses the original's files. Then
   it's marked `sending` → `env.EMAIL.send()` → marked `sent`, with the platform `messageId` stored as
   `provider_message_id` and registered in `thread_refs`, and legacy uploads enter retryable cleanup.
   Account-owned draft sources remain available to other drafts and queued sends. Only hourly draft cleanup
   removes them when no references remain and they are at least 24 hours old, including after a failed send is deleted.
   Transient errors (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`, `E_INTERNAL_SERVER_ERROR`,
   `E_DELIVERY_FAILED`, and `E_STORAGE` when R2 fails a copy or read) back off from 30 s up to 1 h, for at most 8
   attempts. Other errors are permanent and marked `failed` with the code.
5. **At-most-once on crash:** if an alarm finds a row still marked `sending`, the previous attempt died after
   handing off to Cloudflare. It's marked `failed` ("check Sent logs") rather than risking a duplicate send.
6. **Local delivery:** step 1 also resolves every recipient against the directory. Recipients routed only to the
   sending mailbox never need the internet: when the row leaves the outbox, the sent copy is labeled like inbound
   mail (`inbox`, plus the `+tag` label), tagged with their address, marked unread, and recorded as `delivered`.
   If every recipient is local, `env.EMAIL.send()` is skipped. Otherwise the message still goes to everyone,
   and the copy that loops back through MX merges into this one by Message-ID. Our addresses that live in
   *other* mailboxes still take the round trip.
7. **Retry:** a message that failed, bounced, or was rejected says who it didn't reach, with a Retry button.
   `POST /api/mailboxes/:id/messages/:messageId/retry` checks the sender and routes the recipients again, then
   `Mailbox.retrySend()` rebuilds the message from what's stored and puts it back in the outbox, addressed to
   everyone if it never left, or else only to the recipients whose servers refused it, so nobody gets it twice.
   It's the same message: it keeps its thread and the date it first went out, and each send's id goes in
   `sends`. A copy with nobody left in To addresses its Cc'd recipients there, since they're the only people it
   names. Undo doesn't apply: it would delete mail others already have.

### 4.3 Delivery status

An Email Sending **event subscription** per domain feeds `magnus-email-events` (setup creates it). `queue()` looks up which
mailboxes may send as `payload.sender` and offers the event to each. The one whose `sends` holds the message
ID applies it to `deliveries(message_id, recipient)` and rolls it up to a message status, worst first:
bounced > rejected > failed > complained > deferred > sent > delivered. The UI shows this as a badge on each
sent message. Every recipient a send goes to starts at `sent`, so a message reads delivered only once all of
them are. A retry restarts only its own recipients, so another recipient's complaint or deferral still shows.
Events from the earlier send are older, so they no longer apply to the retried recipients.

### 4.4 Live updates

The browser opens `GET /api/mailboxes/:id/live` for each of the user's mailboxes. The API authenticates the request and hands the upgrade
to the Mailbox DO, which accepts it with the **hibernation API**. Idle sockets cost nothing, and `ping`/`pong`
is answered by `setWebSocketAutoResponse` without waking the object. Every mutation broadcasts a small
event, and the client invalidates the matching TanStack Query caches.

### 4.5 Files too big to attach

Email Sending caps a message at 5 MiB, so larger files go as download links, the way Gmail's Drive links
work. Code: `shared/links.ts`, `worker/links.ts`.

1. **Upload** takes files up to 100 MB (Cloudflare's request body limit on Free and Pro plans).
2. **Split:** `planAttachments()` counts every part as base64 plus a fixed allowance for headers, then turns
   the largest files into links until the rest fits. Linking grows the body (step 3), so once anything is
   linked it splits again against the linked body. The composer runs the same function to mark linked files
   as you attach them, and the send route runs it again on the sizes in R2, refusing a body too big to send.
3. **Enqueue:** each linked file becomes an ordinary attachment row with a 128-bit `link_token`. The text part
   gets a block naming each file, its size, and link, above any trailing quote, where Gmail would fold it away.
   The HTML part gets a card per file in the same place (extension tile, name, size, View or Download), built
   from tables and inline styles so it holds up in Gmail and Outlook. HTML readers never see the bare URLs. The sent copy keeps both, so the sender sees what recipients
   got.
4. **Send:** every file is first streamed from `uploads/` to `m/…` like any attachment; only the attached ones
   are then read into memory.
5. **Download:** the link, `GET /f/<mailboxId>/<token>`, opens a plain page (no scripts) with the file's name,
   size, and sender, a preview when the browser can show it safely (§5.3), and a Download button. The bytes
   are at `/f/<mailboxId>/<token>/<filename>`, streamed with Range support, and `?download=1` saves them. The
   name in the path is only there for viewers to show and save as. Both are public; the token is the
   credential. The mailbox is checked in D1 before touching the Durable Object, since `getByName` would create
   one for any name.
6. **Stop sharing:** links don't expire, because an attachment stays readable in the recipient's archive forever
   and a link should too. Instead the sender can stop sharing a file from its Sent message (`link_stopped`),
   which turns the link into a 410 page naming the sender, and share it again, which revives the same link.

### 4.6 Push notifications

Web Push with VAPID, on WebCrypto alone. Code: `worker/push.ts`, `worker/push-api.ts`, `src/push.ts`, `public/sw.js`.

1. **Subscribe:** Settings › Notifications asks for permission, registers `public/sw.js`, and subscribes with the
   install's VAPID key, which is made on first use and kept in `settings` like the session secret. It's never
   replaced: a push service only takes pushes signed with the key a subscription was made with.
2. **One per session:** `PUT /api/push` stores the subscription against the session, not the person. A session is one
   browser, so it has one subscription, and `ON DELETE CASCADE` ends it with the session: signing out, suspension, or
   removal. The insert lands only while the session is live and isn't an admin impersonating someone, checked in the
   same write, since the session cookie stays cached for minutes after revocation. Signing in over someone's session
   ends it (`endReplacedSession()`), so a shared browser stops showing their mail. Impersonation is the exception:
   Better Auth keeps the admin's session to return to. When a session ends in the app, or notifications are turned
   off, the browser also drops its subscription (`src/push.ts`), since a push service holds pushes for a device that's
   offline and one could otherwise reach whoever signs in next. Signing in waits for that before showing the new
   account (its passkey offer included), and Google sign-in, which leaves the page, does it first. The hourly cron
   forgets subscriptions whose session expired unused, which Better Auth never deletes.
3. **Notify:** once `ingest()` stores new mail its verdict puts in the inbox, the queue consumer pushes to every
   member of the mailbox with a live session: the sender, subject, and snippet, encrypted to the browser (RFC 8291) so
   the push service can't read it, at `Urgency: high` so a dozing phone gets it at once. The tag is the ingest id, so
   mail fanned out to two of your mailboxes shows once. Spam doesn't notify, even sent to a `+inbox` tag, and neither
   do copies of mail already there or mail the outbox delivers locally (§4.2). A VAPID token is reused until an hour
   before it expires, since Apple refuses ones refreshed more than hourly; it's kept in `settings`, as a Worker runs in
   many isolates.
4. **Failures:** a push service answering 404 or 410 has dropped the subscription, so it's deleted. Anything else is
   logged, with the start of its answer (never read whole: an endpoint can be any https URL), and not retried. The mail
   is in the inbox either way, and a retried job would find it delivered.
5. **Click:** the service worker tells an open window (not a message body's frame) to route to the thread, so a draft in
   progress survives, or opens one. Every push shows a notification, even one it can't read, since Safari stops
   delivering to sites whose pushes show nothing.

## 5. Cross-cutting design

### 5.1 Authentication and authorization

- **Better Auth** runs at `/api/auth/*` with the email-code, passkey, and admin plugins. You sign in with a
  passkey, with a 6-digit code emailed to your *sign-in email*, or with Google if its client ID and secret are
  set. Each yields a 30-day rolling session cookie backed by D1.
- The sign-in email has to be outside this install: setup and adding a person refuse an address at one of
  Magnus's domains, since its codes would land in the inbox they unlock. Adding a domain warns about anyone
  whose sign-in email is there, because it can't be refused (their address may predate the domain).
- **Passkeys** keep you in when codes can't reach you: that inbox moved into Magnus, or Email Sending is down.
  After a code sign-in the app offers to add one; Settings → Sign-in lists and removes them. Adding one needs a
  session under 15 minutes old (`freshAge`), read from D1 rather than the cookie cache, and not an admin's
  impersonation, so a stolen or revoked session can't plant a passkey that outlives it. A passkey is bound to
  the hostname it was made on (one Better Auth instance per origin), so one made on a custom domain doesn't work
  on `workers.dev`. Each challenge is a D1 row used once; asking for them is rate-limited per IP.
- **Nobody signs up.** `auth_users` is the list of people, and admins add them. Codes are only sent to
  people who exist (`disableSignUp`), though the page answers the same for anyone, and Google only signs in
  an existing person, matched by email.
- Codes go out through Email Sending from `login@` the oldest domain that can send. They expire after 10
  minutes, die after 3 wrong guesses, and are stored hashed. Sign-in endpoints are rate-limited per client
  IP (3 a minute), with the counters in D1 so the limit holds across Worker instances.
- **Roles** are the admin plugin's: `admin` or not. Role changes and suspensions go from the browser straight
  to the plugin (`/api/auth/admin/*`); adding and removing people goes through `/api/admin`, since that also
  creates or deletes their mailbox. Suspending revokes sessions immediately, apart from the 5-minute session
  cookie cache. You can't change your own role, suspend yourself, or remove yourself.
- Mailbox access requires a `mailbox_members` row, and sending as an address requires
  `address_routes.can_send` on a domain that can send.
- One Better Auth instance per origin the Worker is reached on (`workers.dev`, a custom domain), so OAuth
  callbacks return to the same host and only that origin is trusted.
- The session secret is generated on first run and kept in `settings`. Anyone who can read D1 can already
  read every session, so it adds no exposure, and there's no secret to set when deploying.
- Requests whose `Origin` is another site (form posts, WebSocket upgrades) are refused, so another page
  can't ride the session cookie. Better Auth checks its own endpoints.
- Why not Cloudflare Access: it signs you in on its own domain before the app loads, which fights the
  installable app (login redirects inside a home-screen app, manifest and service-worker fetches
  without the cookie) and leaves no room for in-app sign-in such as passkeys.
- Local dev: `DEV_USER_EMAIL` in `.dev.vars` signs that person in for real (a server-made one-time code), and
  only on localhost.

### 5.2 Setup and Cloudflare configuration

A fresh install has no people, so every page leads to `/setup` until someone claims it. The claim needs a
Cloudflare API token, which also proves ownership: setup lists the token's accounts and Workers and looks for
**the exact version that's running** (`CF_VERSION_METADATA`). Only the account that deployed this install can
see that version, so a stranger who finds the `workers.dev` URL first can't take it over, and a renamed
Worker is still found. The claim is a single `INSERT OR IGNORE` into `settings`, so two racing setups can't
both win. The first admin is created server-side with the admin plugin and signed in with a one-time code that
never leaves the Worker.

Turning a domain on (`worker/connect.ts`) is five idempotent steps, each checked before it acts:
Email Routing on the zone (removing another provider's MX records only after the admin confirms), a catch-all
rule sending every address to this Worker, Email Sending on the domain, an event subscription from Email
Sending to the queue this Worker consumes but doesn't produce to, and MTA-STS. The directory's `receiving` and
`sending` flags follow what Cloudflare reports after every step. Setup and the admin Domains page run the same
steps.

MTA-STS (RFC 8461, `worker/mta-sts.ts`) makes servers that support it deliver only over TLS to the MX hosts a
policy names, so an attacker on the path can't strip encryption or redirect the mail. Cloudflare publishes the
policy for Email Routing's MX hosts and keeps its id current, so Magnus follows
[Cloudflare's recipe](https://developers.cloudflare.com/email-service/configuration/mta-sts/) and owns neither:
`_mta-sts.<domain>` is a CNAME to Cloudflare's id, and a Workers route on a proxied `mta-sts.<domain>` sends
`/.well-known/mta-sts.txt` to this Worker, which proxies Cloudflare's policy.

- **A route, not a custom domain.** Attaching a custom domain needs Workers Scripts · Edit, which would let the
  saved token replace this Worker and read every mailbox. A route needs Workers Routes · Edit, which adds
  little to the DNS · Edit the token already has.
- **The policy is published before it's announced.** The host and route go in before the CNAME, so a sender
  that finds the id can always fetch the policy.
- **The policy only stays up while it's true.** The Worker serves it only while the domain is in the directory,
  receiving, and its live MX records (DNS-over-HTTPS) are Cloudflare's. Otherwise it answers 404, and senders'
  cached copies expire within a day (`max_age: 86400`). Without this, a domain that left for another provider
  would keep telling senders to deliver only to Cloudflare. If Cloudflare's policy can't be fetched, the Worker
  answers 502. It never makes up a policy, since a wrong one turns mail away.
- **Another policy already there** is replaced only while moving mail here, which the admin confirmed with the
  MX records. It names the old provider's servers, so leaving it would bounce mail. Otherwise the step stops
  and names the records or route to delete. Records that don't route requests, like a verification TXT, stay.

TLS reporting (TLS-RPT) isn't set up. Its reports would arrive as mail that nothing reads yet.

The token setup is given is saved, so admins don't paste one again. The `Vault` Durable Object encrypts it
(AES-256-GCM) and keeps the key, which never leaves the object; only the ciphertext goes in `settings`
(`worker/vault.ts`, `worker/settings.ts`). Keys and data live apart, as OWASP recommends: a D1 backup or read
token reveals nothing, and Durable Object storage is only reachable from outside (Data Studio, its query API)
with edit access to this Worker, audit-logged. The key is stored as raw bytes, since workerd can't persist a
`CryptoKey`, and imported non-extractable for each use. The browser never holds the token after it's pasted;
admin endpoints read it server-side, and replacing it first checks that the new one can see this install. Setup
never reads the saved token, since pasting one is how setup proves ownership.

Forgetting it deletes the ciphertext and the key, but D1 Time Travel and Durable Objects' point-in-time recovery
keep both for 30 days, so revoking the token in Cloudflare is what ends it for certain.

### 5.3 Rendering untrusted HTML

Email HTML is hostile by default. Four layers protect the client:

1. **HTMLRewriter** (streaming, in the Worker) strips `script`, `iframe`, `object`, `embed`, `form`, `base`,
   `link`, `meta refresh`, every `on*` attribute, `ping`, and `javascript:`/`data:text/html` URLs. It rewrites
   `cid:` images to authenticated attachment URLs and blocks remote images by default (tracking pixels),
   recording what it blocked.
2. **CSP** on the body response: `default-src 'none'`, no scripts, inline styles only, `img-src` limited to
   self/data unless the user clicks "Show images", `form-action 'none'`, `base-uri 'none'`.
3. **Sandboxed iframe** without `allow-scripts`. `allow-same-origin` is safe without scripts and lets inline
   images authenticate and the frame auto-size.
4. **Attachments** show inline only when `preview()` in `shared/files.ts` allows it: raster images, common
   video and audio, and PDF, never HTML or SVG. They're served as the allowlisted type rather than the
   sender's label (a page named `photo.png` goes out as `image/png`, which browsers won't run); everything
   else downloads as `application/octet-stream`. Every file response carries a `sandbox` CSP, which Chrome's
   and Firefox's PDF viewers both tolerate, and honours `Range`, so video and audio seek without downloading
   first. An HTML or SVG attachment can't execute on the mail origin.

### 5.4 Deliverability

Cloudflare manages SPF/DKIM on `cf-bounce.<domain>`, IP reputation, soft-bounce retries, and suppression lists.
Your part:

- Keep **DMARC** at `p=quarantine` or stricter, with `rua` pointing at a mailbox here (reports arrive as mail
  and can be parsed later).
- Always send a text part (the composer renders one from its markdown).
- Give the app a custom domain before sending large files. Their links point at the app's host, and filters
  distrust `workers.dev`, which phishing kits use heavily.
- Watch bounce and complaint rates. The delivery badges surface them per message.

### 5.5 Threading

Threading is RFC 5322 first, heuristic second:

1. Every known Message-ID (inbound headers and Cloudflare-assigned outbound IDs) maps to a thread in
   `thread_refs`. An incoming message joins the first thread matched by `In-Reply-To`, then by `References`,
   newest first.
2. If a message *claims* to be a reply but nothing matches, it falls back to the normalized subject
   (`Re:`/`Fwd:`/`AW:`… stripped) where the sender is already a participant, within 30 days. This covers
   replies whose parent Message-ID we never saw.
3. Everything else starts a new thread. Unrelated "Hello" emails never merge.

Outbound replies carry `In-Reply-To` + a trimmed `References` chain, so Gmail, Apple Mail, and Outlook thread
them too.

Within a thread, the same headers say which message each one answers (`replyParents()`: `In-Reply-To`, else
the nearest `References` entry that's here, matching any id a retried send went out under). The client lays
that out as a tree that only branches where replies fork (`src/replies.ts`), so a thread without forks reads
as a plain list.

### 5.6 Spam

Modern spam passes SPF, DKIM, and DMARC, so authentication alone catches forgeries, not spam. What tells them
apart for one person's mailbox is who you know, and what you've said about who you don't, the way
[mox](https://www.xmox.nl/features/#hdr-junk-filtering) judges senders by your own mail.

- **Verified senders.** The queue counts the From address as verified when DMARC passed for its domain or, for
  domains without a DMARC policy, a DKIM signature or the envelope sender's SPF passed for that domain or a
  parent of it (a child of a shared domain can belong to anyone). Only a verified sender can be trusted or
  marked, so a forged From address can't borrow a friend's standing or get them marked as spam.
- **Standing.** Each mailbox keeps a `senders` table: marking a thread as spam marks who verifiably sent it, and
  taking a thread out of Spam into the inbox (Move to inbox) trusts them. A thread from one sender speaks for
  them; in a conversation with several, someone already trusted isn't marked for what the others sent. The Not
  spam button answers for one message and its sender only (`judgeMessage()`). Writing to someone trusts them too,
  and everyone a mailbox had written to before this existed starts out trusted. The latest judgment stands.
- **Checks** (`worker/mail/checks.ts`). Mail from a sender the mailbox doesn't know (`Mailbox.needsCheck()`) is
  sorted into personal, transactional, newsletter, spam, or phishing. Cloudflare's Clef, a Workers AI decision
  model that returns a probability per category, reads every such message (about 500 ms and a few hundred
  tokens). Not Clef Flash: it scored a mailbox-quota phish at 0.23, and 0.18 with a line claiming the mail was
  personal, where Clef gave both 0.78. When Clef's odds of spam or phishing land between 0.2 and 0.9, OpenAI's
  GPT-6 Luna reads it too and its category stands. Luna goes through OpenRouter on the account's `default` AI
  Gateway, which holds the OpenRouter key (BYOK, Provider Keys) and adds it to the request, so the Worker never
  has it. The request asks only for providers that retain nothing (OpenRouter's `zdr`, which for Luna means Azure)
  and don't train on it (`data_collection: deny`), and tells the gateway not to log it. Without the key, Luna's
  mail ends up unchecked (below). The models read a bounded summary (sender, whether it's verified, subject, up
  to 5 Reply-To addresses, 10 file names, each cut to 200 characters, link hosts, and the body as the recipient
  sees it, cut to 4,000 characters), and their answers are validated. Mail from known senders never reaches them,
  so a message written to sway a model can at most get a stranger's mail into the inbox. Nor does a deleted
  mailbox's: the directory is asked again just before the call. A check that fails puts the job back in the queue with the failure
  counted (`checkFailures`, 30 then 60 seconds later), so failures elsewhere don't use up its tries. After the
  third, the mail is delivered to Spam as unchecked, saying so: not held for an outage, not let through unseen.
- **Reading HTML** (`readHtml()`). The app shows the HTML part when there is one, so that's what the models read,
  not a plain-text part the sender could make say something else. HTMLRewriter parses the whole document as the
  iframe renders it, so nothing placed before the visible part can push it out; only what's collected is bounded.
  Text inside elements hidden by their own style (declarations parsed, comments and custom properties ignored) or
  `hidden` attribute doesn't count, nor do links in them. Link hosts come from anchors' `href`s resolved with `URL`
  after decoding character references, so `https://trusted.example@phish.example/` reads as `phish.example`; the
  first 40 shown hosts are kept. Hiding through a stylesheet class isn't caught: only a browser could tell.
- **Verdicts.** `Mailbox.ingest()` decides, in order: failed its domain's authentication → Spam; a judged sender
  → their standing; verified mail from one of this install's own addresses → Inbox; anyone else → the checks'
  call (spam and phishing → Spam). Standing is read inside the insert's transaction, so a click can't land
  between the check and the write, and it overrides a check made before the sender became known. Each inbound
  message keeps its verdict, and mail in Spam shows it with a Not spam button, like Gmail's "Why is this message
  in spam?". Every Spam or Not spam click on mail the filter placed otherwise logs the verdicts it got wrong
  (`spam verdict corrected`, no content or addresses), to tune the thresholds by.

### 5.7 Reliability summary

| Failure | Outcome |
| --- | --- |
| Parser crash or DO unavailable during ingest | Queue retry with backoff, then listed under Failed to retry, download, or delete; raw message kept in R2 |
| Duplicate delivery (queue at-least-once, same mail to two aliases) | Idempotent on `ingestId` + `Message-ID` |
| R2 or Queue failure inside `email()` | Handler throws instead of accepting; the sender gets `421 4.3.0` and retries |
| Transient Email Sending error | DO alarm retries with backoff |
| Permanent send failure, bounce, or rejection | Retry from the message, to just the recipients it didn't reach |
| DO evicted mid-send | Marked failed rather than possibly duplicated |
| Bad deploy | Roll back to the previous version in the dashboard; raw mail accepted meanwhile is in R2 |

## 6. Cost at personal scale

- Workers Paid ($5/mo) is required for Email Sending to arbitrary recipients and includes 3,000 outbound
  emails a month.
- Inbound, D1, DO, R2, and Queues usage for one to a few people sits inside the plan's included allowances.
  The one variable is R2 storage for large attachment archives (~$0.015/GB-month).
- Spam checks only read mail from senders a mailbox doesn't know. Clef costs $0.24 per million input tokens,
  about 0.012¢ a message, inside Workers AI's free 10,000 neurons a day for several hundred messages. GPT-6 Luna
  ($0.10/M input, $0.50/M output) reads only the ones Clef isn't sure of, billed by OpenRouter to the key stored
  on the gateway (see §5.6).

## 7. Checked on the pilot install

The local simulator can't prove these, so they were checked against real Cloudflare on derped.dev:

1. **Returned `messageId` vs. the delivered `Message-ID` header.** They match. `env.EMAIL.send` returned
   `<…@derped.dev>` and the recipient got that exact header, so reply threading can rely on it.
2. **Event subscription `payload.messageId` vs. the binding's `messageId`.** Same id, in the same bracketed
   `<…@derped.dev>` form, not the `0101018f…-msg-…` shape in the docs' examples. `applyDeliveryEvent` still
   accepts the raw or bracketed form.
3. **Does onboarding Sending on a domain that already has mail rewrite its existing `_dmarc` record?** No. It
   left derped.dev's `_dmarc` record as it was. Still review `wrangler email sending dns get <domain>` before
   applying.
4. **What the sending server sees when `email()` throws.** A temporary failure. Email Routing replies
   `421 4.3.0 Upstream error, please check https://developers.cloudflare.com/email-routing/postmaster …` and
   logs "worker script threw an exception" as a temporary error. The sender retried the same message after
   24 s and again 67 s later. So a brief R2 or Queue outage delays mail instead of bouncing it.

Still open:

5. **Does the 5 MiB limit count base64 or raw bytes?** Magnus assumes base64, so files over about 3.8 MB go as
   links. If a 4.5 MB attachment sends fine, `encodedSize()` in `shared/links.ts` can count raw bytes instead.

## 8. Roadmap

The web app is the only client, so it has to be good on phones and good enough to live in all day.

**Next: daily-driver essentials**

1. **Mobile layout + installable app (PWA)**: implemented. The list and a thread take turns on small screens, and
   a manifest installs it to the home screen on iOS and Android, or as a desktop app. There's no offline mode:
   signed-in responses are `no-store`, so nothing of an account outlives its sign-out.
2. **Push notifications** (Web Push, VAPID): implemented (§4.6). iOS only delivers web push to home-screen apps,
   which item 1 covers. Not yet: clearing a notification once its mail is read elsewhere, and following a browser that
   replaces its subscription (`pushsubscriptionchange`, Firefox) instead of waiting for it to be turned on again.
3. **Drafts**: implemented with private, account-scoped D1 storage, version checks, and a device-local recovery
   journal. Attachments live outside the temporary upload prefix; hourly cleanup keeps referenced files.
4. **Keyboard shortcuts** (j/k, e archive, r reply, c compose, / search), **bulk select**.
5. **Mailbox import** from your previous provider (export to `.eml`, e.g. Proton's Import-Export app). Upload
   the raw files to R2 and enqueue `InboundJob`s; the existing ingest path does the rest.

**Later**

6. **Rules and filters** per mailbox (from/to/subject → labels, skip inbox, auto-archive), evaluated in ingest.
7. **Image proxy** through the Worker so "Show images" doesn't leak your IP.
8. **Workers AI**: category labels and thread summaries (spam and phishing checks are in, §5.6). Use
   **Vectorize** for semantic search next to FTS5.
9. **Vacation responder** via `env.EMAIL.send` (skip auto-submitted and list mail; honor `Auto-Submitted`).
10. **DMARC aggregate report parsing** from the `rua` mailbox into a dashboard.
11. **Retention/export**: per-label retention, full mailbox export (raw `.eml` is already in R2).

**Decided against:** IMAP and JMAP servers (see §1).
