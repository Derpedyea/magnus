import { app } from "./api";
import { receivesMail } from "./directory";
import { links } from "./links";
import { email, queue } from "./mail/inbound";
import { migrate } from "./migrate";
import { mtaStsPolicy, POLICY_PATH } from "./mta-sts";
import { cleanDraftFiles } from "./drafts";
import { forgetExpiredDevices } from "./push";

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
	async scheduled(_event, env) {
		await migrate(env.DIRECTORY);
		const now = Date.now();
		// Independent, so one failing doesn't hold the other up. Both run again next hour.
		const [drafts, devices] = await Promise.allSettled([cleanDraftFiles(env, now), forgetExpiredDevices(env.DIRECTORY, now)]);
		if (drafts.status === "rejected") console.error(JSON.stringify({ msg: "draft cleanup failed", error: String(drafts.reason) }));
		if (devices.status === "rejected") console.error(JSON.stringify({ msg: "push cleanup failed", error: String(devices.reason) }));
		if (drafts.status === "rejected" || devices.status === "rejected") throw new Error("Hourly cleanup failed");
	},
} satisfies ExportedHandler<Env>;
