import { app } from "./api";
import { receivesMail } from "./directory";
import { links } from "./links";
import { email, queue } from "./mail/inbound";
import { migrate } from "./migrate";
import { mtaStsPolicy, POLICY_PATH } from "./mta-sts";

export { Mailbox } from "./mailbox/mailbox";
export { Vault } from "./vault";

/**
 * The whole of Magnus: the app and its API, linked-file downloads, each domain's MTA-STS policy, mail in at SMTP
 * time, and the queues in between.
 */
export default {
	async fetch(request, env, ctx) {
		await migrate(env.DIRECTORY);
		const url = new URL(request.url);
		if (url.pathname === POLICY_PATH) return mtaStsPolicy(url.hostname, (domain) => receivesMail(env.DIRECTORY, domain));
		return (url.pathname.startsWith("/f/") ? links : app).fetch(request, env, ctx);
	},
	async email(message, env) {
		await migrate(env.DIRECTORY);
		await email(message, env);
	},
	async queue(batch, env) {
		await migrate(env.DIRECTORY);
		await queue(batch, env);
	},
} satisfies ExportedHandler<Env>;
