import { app } from "./api";
import { email, queue } from "./mail/inbound";
import { migrate } from "./migrate";

export { Mailbox } from "./mailbox/mailbox";

/** The whole of Magnus: the app and its API, mail in at SMTP time, and the queues in between. */
export default {
	async fetch(request, env, ctx) {
		await migrate(env.DIRECTORY);
		return app.fetch(request, env, ctx);
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
