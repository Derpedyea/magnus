import type { MailboxApi } from "@magnus/shared";

/** See apps/mx/src/mailbox.ts — typed against the RPC contract, not the class. */
type MailboxNamespace = DurableObjectNamespace<MailboxApi & Rpc.DurableObjectBranded>;
export type MailboxStub = DurableObjectStub<MailboxApi & Rpc.DurableObjectBranded>;

export function mailbox(env: Env, mailboxId: string): MailboxStub {
	return (env.MAILBOX as MailboxNamespace).getByName(mailboxId);
}
