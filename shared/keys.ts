/**
 * R2 object layout (single bucket: magnus-mail).
 *
 *   raw/2026/09/26/<ingestId>.eml             raw inbound message, shared across fan-out
 *   m/<mailboxId>/<messageId>/body.html        rendered HTML body (cid: rewritten)
 *   m/<mailboxId>/<messageId>/att/<attId>      attachment bytes
 *   uploads/<mailboxId>/<uuid>                 composer uploads awaiting send
 *
 * Everything a mailbox keeps sits under m/<mailboxId>/ so deleting a mailbox is a prefix delete, plus its originals
 * under raw/ that no other mailbox holds (Mailbox.deleteOriginals()).
 * Uploads are copied under m/ as their message goes out; put a 14-day lifecycle rule on "uploads/" to reap abandoned ones.
 */
export const r2Keys = {
	raw(ingestId: string, receivedAt: number): string {
		const d = new Date(receivedAt);
		const pad = (n: number) => String(n).padStart(2, "0");
		return `raw/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${ingestId}.eml`;
	},
	mailbox(mailboxId: string): string {
		return `m/${mailboxId}/`;
	},
	html(mailboxId: string, messageId: string): string {
		return `m/${mailboxId}/${messageId}/body.html`;
	},
	attachment(mailboxId: string, messageId: string, attachmentId: string): string {
		return `m/${mailboxId}/${messageId}/att/${attachmentId}`;
	},
	upload(mailboxId: string, uploadId: string): string {
		return `uploads/${mailboxId}/${uploadId}`;
	},
};
