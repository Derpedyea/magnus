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
  (see §5.4).

## 2. Topology

```
                    ┌─────────────────────── Cloudflare ────────────────────────────────────────────┐
  Internet MTAs     │                                                                               │
  ── SMTP :25 ──▶  Email Routing (catch-all *@domain) ──▶ ┌─────────────┐   R2 magnus-mail         │
                    │                                     │  magnus-mx   │──▶ raw/…/<ulid>.eml       │
                    │                          email() ──▶│  accept /    │                           │
                    │                                     │  reject      │──▶ Queue magnus-inbound ─┐│
                    │                                     │              │                          ││
                    │                          queue() ◀──│  parse       │◀─────────────────────────┘│
                    │         D1 magnus-directory ◀──────▶│  (postal-mime)──▶ R2 m/<mbx>/<msg>/…      │
                    │         (domains, users, addresses) └──────┬──────┘                            │
                    │                    ▲                       │ RPC ingest()                      │
                    │                    │                       ▼                                   │
  Browser ─ HTTPS ──────────────────────▶ ┌─────────────┐  ┌──────────────────────────┐              │
  (mail.example     │ (Google sign-in)    │ magnus-web  │  │ magnus-mailstore          │              │
   .com)            │                     │ React SPA + │─▶│ Mailbox DO (1 per mailbox)│── alarm ──▶ Email Sending ─▶ recipients
                    │                     │ Hono API    │  │ SQLite: threads, labels,  │             │
                    │   WebSocket ◀───────│  /api/*     │◀─│ FTS5, outbox, deliveries  │◀─┐          │
                    │   (hibernatable)    └─────────────┘  └──────────────────────────┘   │          │
                    │                                                                     │          │
                    │         Email Sending events ──▶ Queue magnus-email-events ──▶ mx queue() ─────┘
                    └───────────────────────────────────────────────────────────────────────────────┘
```

Three Workers, deployed independently:

| Worker | Role | Public surface |
| --- | --- | --- |
| `apps/mx` → **magnus-mx** | SMTP-time accept/reject, raw capture, parsing, delivery-event routing | None (`workers_dev: false`). Only Email Routing and Queues invoke it |
| `apps/mailstore` → **magnus-mailstore** | Hosts the `Mailbox` Durable Object class, which owns all mail data and the outbox | None. Other Workers reach it through DO bindings (`script_name`) |
| `apps/web` → **magnus-web** | React client + JSON API + WebSocket proxy | `mail.<your domain>`, sign-in with Google or an email code (Better Auth) |

Why split them: the inbound path must keep accepting mail while the web app is redeployed or broken. The
mailstore owns the schema, so its migrations ship on their own schedule. Each Worker gets only the bindings
it needs. For example, only mailstore sends user mail, and only web is reachable from the internet. (Web's own
`send_email` binding can only send as `LOGIN_CODE_FROM`, for sign-in codes.)

Shared code lives in packages, not Workers:

- `packages/shared`: contracts (`MailboxApi` RPC interface, queue payloads, DTOs), R2 key layout, threading and
  address utilities, and zod schemas (as a separate `@magnus/shared/schemas` entry, so the mail path doesn't bundle zod).
- `packages/directory`: the D1 schema, migrations, and typed queries (`resolveRecipient`, `getSendIdentities`, …).

Workers type their DO stubs against `MailboxApi` instead of importing the `Mailbox` class, so each Worker's
generated `Env` stays independent.

## 3. Storage

Each store holds one kind of data:

| Store | Holds | Why this store |
| --- | --- | --- |
| **D1 `magnus-directory`** | domains, users, mailboxes, memberships, addresses, address→mailbox routes, sender blocks | Small, global, read on every inbound message by `mx` and every API call by `web` |
| **Durable Object `Mailbox`** (SQLite, one per mailbox) | threads, messages, labels, attachment metadata, Message-ID→thread index, FTS5 index, outbox, per-recipient delivery state | Strongly consistent per-mailbox transactions, a natural isolation boundary, alarms for scheduled send, hibernatable WebSockets for live push, 10 GB each |
| **R2 `magnus-mail`** | raw `.eml`, HTML bodies, attachments, composer uploads | Blobs. Cheap, no egress fees |
| **Queues** | `magnus-inbound` (+ DLQ), `magnus-email-events` | Durable hand-off with retries. Parsing never blocks the SMTP session |

### D1 directory (`packages/directory/migrations/0001_directory.sql`)

```
domains(name, receiving, sending, catch_all_mailbox_id)
users(id, login_email, display_name, is_admin)               ← login_email = the Google account that signs in
mailboxes(id, name)                                          ← id = Durable Object name
mailbox_members(mailbox_id, user_id, role)                   ← shared mailboxes later
addresses(address, domain, display_name, enabled)            ← normalized, no +tag
address_routes(address, mailbox_id, can_send)                ← >1 row = group alias (e.g. family@)
sender_blocks(pattern)                                       ← 'x@y.com' or '*@y.com', rejected at SMTP time
```

### Mailbox DO schema (`apps/mailstore/src/schema.ts`)

`threads`, `messages`, `message_labels`, `message_addresses`, `attachments`, `thread_refs`, `outbox`, `deliveries`,
`messages_fts` (FTS5, porter + unicode61). Migrations are an append-only array applied in `blockConcurrencyWhile`.

Labels follow the Gmail model: they live on messages, and a thread appears in a view if any of its messages
has the label. System labels are `inbox`, `sent`, `outbox`, `spam`, `trash`, `starred`. "Archive" means
removing `inbox`, and "All mail" is a pseudo-view. `+tag` subaddresses become labels automatically
(`me+receipts@…` → `receipts`).

### Mailboxes vs. addresses

A **mailbox** is an access boundary (who can read it), not a domain. One person's `me@` on every domain belongs
in one mailbox; a shared `family@` can be its own mailbox with several members. **Addresses** are how you slice
the mail: `message_addresses` records which of our addresses each message was delivered to (+tag stripped) or
sent from. List, search, and count reads take an optional address filter.

`GET /api/threads`, `/api/search`, and `/api/counts` span every mailbox the user belongs to. `magnus-web` fans
out to each Mailbox DO and merges the results (`packages/shared/src/scope.ts`); `?in=a@x,b@y` narrows the view
to some addresses. Reads and writes on a single thread stay under `/api/mailboxes/:id/…`.

### R2 layout (`packages/shared/src/keys.ts`)

```
raw/2026/09/26/<ingestId>.eml          raw inbound, shared across fan-out, kept forever (source of truth)
m/<mailboxId>/<messageId>/body.html     HTML body (served through the sanitizer)
m/<mailboxId>/<messageId>/att/<attId>   attachments (inbound, and outbound once sent)
uploads/<mailboxId>/<uuid>              composer uploads; 14-day lifecycle rule reaps abandoned ones
```

Everything a mailbox owns sits under `m/<mailboxId>/`, so deleting a mailbox is a prefix delete. The raw archive
means any parsing bug can be fixed by re-queuing `InboundJob`s. Ingest is idempotent.

## 4. Flows

### 4.1 Inbound

1. A remote MTA delivers to Cloudflare MX. Email Routing enforces the size limit, DMARC policy, and RBLs, then
   invokes `magnus-mx.email()` once per recipient.
2. `resolveRecipient()` makes one D1 batch covering the exact address, the domain catch-all, and sender blocks.
   Unknown recipients get `setReject("5.1.1 …")` **during the SMTP session**, so we never send backscatter.
3. The raw bytes are buffered once and written to R2. Then one `InboundJob` per target mailbox is enqueued
   (group aliases fan out here). Returning ends the SMTP transaction. If R2 or the queue fails, the handler
   throws instead of returning, so the message is never silently accepted (see §7 for the exact SMTP reply).
4. `mx.queue()` parses with postal-mime, writes the HTML and attachments to R2, extracts the
   `Authentication-Results` verdicts, applies first-pass triage (DMARC fail → `spam`), and calls
   `Mailbox.ingest()`.
5. `ingest()` is idempotent. It dedupes on `ingestId` and on `Message-ID`, so the same mail arriving via two
   of our addresses, or our own outbound copy coming back, is stored once with merged labels. It then threads
   the message (§5.4), indexes it for search, and broadcasts `threads.changed` over WebSocket.

Failures retry with exponential backoff (max 10) and then land in `magnus-inbound-dlq`. The raw message is
already safe in R2.

### 4.2 Outbound

1. `POST /api/mailboxes/:id/send` validates the request (zod). It checks that `from` is one of **this mailbox's
   send identities** (`address_routes.can_send` on a domain with `sending = 1`), that attachments are this
   mailbox's own uploads (sizes re-read from R2, not trusted from the client), and that the total stays under 5 MiB.
2. `Mailbox.enqueueSend()` writes the message into the thread, labeled `outbox`, with status `queued`. For
   replies it computes `In-Reply-To`/`References` from the parent, capped at 2,048 bytes (root + newest IDs).
   It then inserts an `outbox` row with `send_at = now + delay` and sets a DO alarm.
3. **Undo send / scheduled send:** until `send_at`, `cancelSend()` removes the message. The UI shows a 10 s
   undo toast. Delays up to 7 days work as scheduled send.
4. `alarm()` drains due rows. Each is marked `sending` → `env.EMAIL.send()` → marked `sent`, with the
   platform `messageId` stored as `provider_message_id` and registered in `thread_refs`. Attachments move from
   `uploads/` to `m/…`. Transient errors (`E_RATE_LIMIT_EXCEEDED`, `E_DAILY_LIMIT_EXCEEDED`,
   `E_INTERNAL_SERVER_ERROR`, `E_DELIVERY_FAILED`) back off from 30 s up to 1 h, for at most 8 attempts.
   Other errors are permanent and marked `failed` with the code.
5. **At-most-once on crash:** if an alarm finds a row still marked `sending`, the previous attempt died after
   handing off to Cloudflare. It's marked `failed` ("check Sent logs") rather than risking a duplicate send.
6. **Local delivery:** step 1 also resolves every recipient against the directory. Recipients routed only to the
   sending mailbox never need the internet: when the row leaves the outbox, the sent copy is labeled like inbound
   mail (`inbox`, plus the `+tag` label), tagged with their address, marked unread, and recorded as `delivered`.
   If every recipient is local, `env.EMAIL.send()` is skipped. Otherwise the message still goes to everyone,
   and the copy that loops back through MX merges into this one by Message-ID. Our addresses that live in
   *other* mailboxes still take the round trip.

### 4.3 Delivery status

An Email Sending **event subscription** per domain feeds `magnus-email-events`. `mx.queue()` looks up which
mailboxes may send as `payload.sender` and offers the event to each. The one holding the message ID applies
it to `deliveries(message_id, recipient)` and rolls it up to a message status, worst first:
bounced > rejected > failed > complained > deferred > sent > delivered. The UI shows this as a badge on each
sent message.

### 4.4 Live updates

The browser opens `GET /api/mailboxes/:id/live` for each of the user's mailboxes. `magnus-web` authenticates the request and hands the upgrade
to the Mailbox DO, which accepts it with the **hibernation API**. Idle sockets cost nothing, and `ping`/`pong`
is answered by `setWebSocketAutoResponse` without waking the object. Every mutation broadcasts a small
event, and the client invalidates the matching TanStack Query caches.

## 5. Cross-cutting design

### 5.1 Authentication and authorization

- **Better Auth** runs inside `magnus-web` at `/api/auth/*`, with two ways in: "Continue with Google", or a
  6-digit code emailed to your `users.login_email` (for devices that block outside Google accounts, like a
  school Chromebook). Either one yields a 30-day rolling session cookie backed by D1 (`auth_*` tables,
  `0002_auth.sql`). There is no sign-up: an account is only created for an email that's already a
  `users.login_email`, and codes are only sent to those addresses, though the page answers the same for any.
- Codes go out through Email Sending from `LOGIN_CODE_FROM`, expire after 10 minutes, die after 3 wrong
  guesses, and are stored hashed. Sign-in endpoints are rate-limited per client IP (3 a minute), with the
  counters in D1 so the limit holds across Worker instances.
- Every other `/api/*` request needs that session. Its verified email maps to `users.login_email`, which stays
  the authority: deleting the row locks the person out within 5 minutes (the session cookie cache). Mailbox
  access requires a `mailbox_members` row, and sending as an address requires `address_routes.can_send`.
- Requests whose `Origin` is another site (form posts, WebSocket upgrades) are refused, so another page
  can't ride the session cookie. Better Auth checks its own endpoints.
- Why not Cloudflare Access: it signs you in on its own domain before the app loads, which fights the
  planned installable app (login redirects inside a home-screen app, manifest and service-worker fetches
  without the cookie) and leaves no room for in-app sign-in such as passkeys, a Better Auth plugin away.
- Local dev bypass: `DEV_USER_EMAIL` in `.dev.vars` is honored **only on localhost** and is never deployed.
- `mx` and `mailstore` have no public URLs.

### 5.2 Rendering untrusted HTML

Email HTML is hostile by default. Four layers protect the client:

1. **HTMLRewriter** (streaming, in the Worker) strips `script`, `iframe`, `object`, `embed`, `form`, `base`,
   `link`, `meta refresh`, every `on*` attribute, `ping`, and `javascript:`/`data:text/html` URLs. It rewrites
   `cid:` images to authenticated attachment URLs and blocks remote images by default (tracking pixels),
   recording what it blocked.
2. **CSP** on the body response: `default-src 'none'`, no scripts, inline styles only, `img-src` limited to
   self/data unless the user clicks "Show images", `form-action 'none'`, `base-uri 'none'`.
3. **Sandboxed iframe** without `allow-scripts`. `allow-same-origin` is safe without scripts and lets inline
   images authenticate and the frame auto-size.
4. **Attachments** are forced to download (`application/octet-stream` + `Content-Disposition: attachment`)
   unless the type is on an inline-safe allowlist (images, PDF, text), and are always served with a
   `sandbox` CSP. An HTML or SVG attachment can't execute on the mail origin.

### 5.3 Deliverability

Cloudflare manages SPF/DKIM on `cf-bounce.<domain>`, IP reputation, soft-bounce retries, and suppression lists.
Your part:

- Keep **DMARC** at `p=quarantine` or stricter, with `rua` pointing at a mailbox here (reports arrive as mail
  and can be parsed later).
- Always send a text part (the composer is text-first).
- Watch bounce and complaint rates. The delivery badges surface them per message.

### 5.4 Threading

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

### 5.5 Reliability summary

| Failure | Outcome |
| --- | --- |
| Parser crash or DO unavailable during ingest | Queue retry with backoff, then DLQ; raw message kept in R2 and replayable |
| Duplicate delivery (queue at-least-once, same mail to two aliases) | Idempotent on `ingestId` + `Message-ID` |
| R2 or Queue failure inside `email()` | Handler throws instead of accepting; see §7 on whether the sender sees a retryable 4xx |
| Transient Email Sending error | DO alarm retries with backoff |
| DO evicted mid-send | Marked failed rather than possibly duplicated |
| Web app outage | Mail keeps flowing in; outbox alarms keep sending |

## 6. Cost at personal scale

- Workers Paid ($5/mo) is required for Email Sending to arbitrary recipients and includes 3,000 outbound
  emails a month.
- Inbound, D1, DO, R2, and Queues usage for one to a few people sits inside the plan's included allowances.
  The one variable is R2 storage for large attachment archives (~$0.015/GB-month).

## 7. Things to verify on the first real send

The local simulator can't prove these:

1. **Returned `messageId` vs. the delivered `Message-ID` header.** Locally it looks like
   `<…@yourdomain.com>`. Check "Show original" in Gmail and confirm it matches what the Sent message shows.
   Reply threading depends on it.
2. **Event subscription `payload.messageId` format vs. the binding's `messageId`.** The docs' examples show a
   different shape (`0101018f…-msg-…`). `applyDeliveryEvent` matches either the raw or bracketed form. If the
   IDs are unrelated, add a lookup by (sender, recipient, subject, time window).
3. **Does onboarding Sending on a domain that already has mail rewrite its existing `_dmarc` record?**
   Review `wrangler email sending dns get <domain>` before applying.
4. **What the sending server sees when `email()` throws.** The docs don't say whether it's a temporary (4xx,
   sender retries) or permanent failure. Test once with a forced exception on the pilot domain. If it's
   permanent, catch R2/Queue errors and fall back to `message.forward()` to a verified backup address.

## 8. Roadmap

The web app is the only client, so it has to be good on phones and good enough to live in all day.

**Next: daily-driver essentials**

1. **Mobile layout + installable app (PWA)**: single-column list → thread → compose on small screens, and a
   manifest + service worker so it installs to the home screen on iOS and Android.
2. **Push notifications** (Web Push, VAPID): the Mailbox DO already knows the moment mail lands. iOS only
   delivers web push to home-screen apps, which item 1 covers.
3. **Drafts** (autosave into the DO), **forward** (with attachments), **retry failed sends**.
4. **Keyboard shortcuts** (j/k, e archive, r reply, c compose, / search), **bulk select**, **infinite scroll**
   (the API already pages with `before`).
5. **Contacts/autocomplete** built from sent and received addresses. **Signatures** per identity.
6. **Mailbox import** from your previous provider (export to `.eml`, e.g. Proton's Import-Export app). Upload
   the raw files to R2 and enqueue `InboundJob`s; the existing ingest path does the rest.
7. **Admin page** for users, mailboxes, addresses, and aliases, so adding someone doesn't mean writing SQL.

**Later**

8. **Rules and filters** per mailbox (from/to/subject → labels, skip inbox, auto-archive), evaluated in ingest.
9. **Image proxy** through the Worker so "Show images" doesn't leak your IP.
10. **Rich-text compose** (the composer is text-first today).
11. **Workers AI**: spam and phishing scoring, category labels, thread summaries. Use **Vectorize** for
    semantic search next to FTS5.
12. **Vacation responder** via `env.EMAIL.send` (skip auto-submitted and list mail; honor `Auto-Submitted`).
13. **DMARC aggregate report parsing** from the `rua` mailbox into a dashboard.
14. **Retention/export**: per-label retention, full mailbox export (raw `.eml` is already in R2).

**Decided against:** IMAP and JMAP servers (see §1).
