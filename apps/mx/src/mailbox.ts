import type { MailboxApi } from "@magnus/shared";

/**
 * The Mailbox class lives in magnus-mailstore; this Worker only sees its RPC contract.
 * Typing against MailboxApi (instead of importing the class) keeps each Worker's Env independent.
 */
type MailboxNamespace = DurableObjectNamespace<MailboxApi & Rpc.DurableObjectBranded>;

export function mailbox(env: Env, mailboxId: string) {
	return (env.MAILBOX as MailboxNamespace).getByName(mailboxId);
}
