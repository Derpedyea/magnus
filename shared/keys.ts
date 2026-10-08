/**
 * R2 object layout (single bucket: magnus-mail).
 *
 *   raw/2026/09/26/<ingestId>.eml             raw inbound message, shared across fan-out
 *   m/<mailboxId>/<messageId>/body.html        rendered HTML body (cid: rewritten)
 *   m/<mailboxId>/<messageId>/att/<attId>      attachment bytes
 *   m/<mailboxId>/<messageId>/original.eml     raw message imported from another provider, this mailbox's alone
 *   m/<mailboxId>/draft-files/<userId>/<uuid> account-owned draft sources, shared by conflict copies
 *   uploads/<mailboxId>/<uuid>                 composer uploads awaiting send
 *
 * Everything a mailbox keeps sits under m/<mailboxId>/ so deleting a mailbox is a prefix delete, plus its originals
 * under raw/ that no other mailbox holds (Mailbox.deleteOriginals()).
 * Uploads are copied under m/ as their message goes out; put a 14-day lifecycle rule on "uploads/" to reap abandoned ones.
 * Draft sources also get per-message copies; only reference-aware draft cleanup removes the sources.
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
	/** Everything kept for one message: its body and attachments. */
	message(mailboxId: string, messageId: string): string {
		return `m/${mailboxId}/${messageId}/`;
	},
	html(mailboxId: string, messageId: string): string {
		return `m/${mailboxId}/${messageId}/body.html`;
	},
	attachment(mailboxId: string, messageId: string, attachmentId: string): string {
		return `m/${mailboxId}/${messageId}/att/${attachmentId}`;
	},
	/** The original of mail imported from another provider. Unlike raw/, nothing else shares it. */
	imported(mailboxId: string, messageId: string): string {
		return `m/${mailboxId}/${messageId}/original.eml`;
	},
	upload(mailboxId: string, uploadId: string): string {
		return `uploads/${mailboxId}/${uploadId}`;
	},
	/** Account-owned draft files stay outside the lifecycle-reaped uploads/ prefix. */
	draftFile(mailboxId: string, userId: string, uploadId: string): string {
		return `m/${mailboxId}/draft-files/${userId}/${uploadId}`;
	},
};
