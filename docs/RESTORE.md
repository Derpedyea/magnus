# Restoring Magnus

What Cloudflare keeps of Magnus, and how to put it back. All of it lives in the same Cloudflare account as Magnus,
so none of it helps if that account is lost.

| What | Kept | Put back with |
| --- | --- | --- |
| A removed person and their mail | 30 days | Admin › People › Removed › **Restore** |
| One mailbox: threads, labels, read state, contacts, Failed, the outbox | Any moment in the last 30 days | [Restoring a mailbox](#restoring-a-mailbox) |
| The directory (D1): people, sign-in, domains, addresses, drafts, settings | Any minute in the last 30 days | [Restoring the directory](#restoring-the-directory) |
| Bodies, attachments, and originals (R2) | Until deleted. Not versioned: deleted for good is gone | — |

Cloudflare's own words: Durable Objects can be restored "to any point in time in the past 30 days", and D1
"to any minute within the last 30 days".

## Restoring a mailbox

For when a bug or a bad deploy has spoiled one mailbox, or all of them. A restore puts the whole mailbox back as it
was at that moment. Single threads can't be restored. Restore while nobody is using the mailbox: suspend its person
first (Admin › People), and give access back once it's done, since a send in flight as the restore happens can go
twice.

1. Find the mailbox's id. It's in the address bar when you open mail (`/inbox/<mailboxId>/…`), and every mailbox is
   listed at `/api/admin/directory`.
2. Signed in as an admin, open the browser console on Magnus and run, with the id and the time to go back to:

   ```js
   await (await fetch("/api/admin/mailboxes/MAILBOX_ID/restore", {
   	method: "POST",
   	headers: { "Content-Type": "application/json" },
   	body: JSON.stringify({ at: "2026-10-14T09:00:00Z" }),
   })).json()
   ```

3. It answers `{ held, linksStopped, replayed, unknown, undo }`. Keep `undo`, even from an answer that says the
   restore didn't finish: sending it back as the body (`body: JSON.stringify(undo)`) undoes this restore, to exactly the
   moment before it.

What else changes:

- Mail received since then arrives again (`replayed`), from the originals Magnus keeps of incoming mail. Spam checks
  run on it again. `unknown` counts originals that don't say which mailboxes they were for, which aren't queued.
- Mail sent since then is gone from Sent, though it was delivered. Only Magnus's copy is lost.
- Whatever was waiting to send at that moment fails with a note instead of sending (`held`), since it may have gone
  out already. Its sender sends it again if it didn't.
- Every file the mailbox shared by link stops (`linksStopped`), since a link stopped since then would otherwise work
  again. Its sender shares again any that should be.
- A draft that was being sent as the restore happened goes back to being a draft, for its sender to send again if it
  didn't go.
- Mail imported since then (Settings › Import mail) is gone. Import it again; anything already there is skipped.
- Mail deleted for good since then comes back without its body and attachments, which were deleted from R2.

To restore every mailbox, such as after a deploy that spoiled them all:

```js
const { mailboxes } = await (await fetch("/api/admin/directory")).json();
for (const m of mailboxes) {
	const restore = await fetch(`/api/admin/mailboxes/${m.id}/restore`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ at: "2026-10-14T09:00:00Z" }),
	});
	console.log(m.name, restore.status, await restore.json());
}
```

A restore that fails partway (a non-200 answer) is finished by running it again with the same time. A mailbox
restores one at a time: another restore of it while one runs answers 409.

## Restoring the directory

For when a bug or a bad migration has spoiled people, addresses, domains, or settings. This overwrites the whole
directory: D1 "does not yet allow you to clone or fork an existing database to a new copy".

```sh
npx wrangler d1 time-travel info magnus-directory --timestamp=2026-10-14T09:00:00Z     # the bookmark for that time
npx wrangler d1 time-travel restore magnus-directory --timestamp=2026-10-14T09:00:00Z
```

The restore prints "the previous bookmark"; restoring to that (`--bookmark=…`) undoes it. Everything in the directory
goes back, including:

- Sessions: people who signed in since are signed out, and anyone who signed out since is signed in again.
- Drafts and signatures.
- Removals: someone removed since is back, and someone deleted for good since is back in the directory without their
  mail, which can't come back. Remove them again.
- Domains' settings in Magnus, but not Cloudflare's routing or DNS: check each domain in Admin › Domains afterwards.

## Practising

Do this once after deploying, then every few months, on a test person rather than someone's mail.

1. Add a person called "Restore drill" with an address and a sign-in email you can read. Sign in as them in a private
   window, and send their address two messages.
2. Note the time. Then archive one message, star the other, and send their address one more.
3. Restore their mailbox to the time you noted.
4. Expect both first messages back in the inbox, unread and unstarred; the third arriving again; and
   `{ held: 0, replayed: 1, unknown: 0 }`.
5. Remove the drill person.
