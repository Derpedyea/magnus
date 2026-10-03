import { zValidator } from "@hono/zod-validator";
import { normalizeAddress, STEP_IDS } from "#shared";
import { Hono } from "hono";
import { z } from "zod";
import { signInWithoutCode } from "./auth";
import { cloudflare, findInstall, getZone, listZones } from "./cloudflare";
import { domainStatus } from "./connect";
import { addAddress, createMailbox } from "./directory";
import { cloudflareTokenStatement, getInstall, type Install, saveCloudflareToken } from "./settings";

export const NOT_THIS_INSTALL =
	"That token can't see this Magnus install. Create it in the Cloudflare account Magnus is deployed to, with Workers Scripts · Read.";

export const TokenSchema = z.object({ token: z.string().trim().min(1, "Paste your Cloudflare API token.") });

export const LocalPartSchema = z
	.string()
	.trim()
	.toLowerCase()
	.regex(/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/, "Use letters, digits, dots, dashes, or underscores.")
	.max(64);

const CompleteSchema = TokenSchema.extend({
	zoneId: z.string().min(1),
	name: z.string().trim().min(1).max(100),
	localPart: LocalPartSchema,
	/** Where sign-in codes go. */
	email: z.email().transform(normalizeAddress),
	moveMail: z.boolean().default(false),
});

/**
 * First run, before anyone can sign in: /setup proves the visitor owns this install with a Cloudflare token
 * (see findInstall), then creates them as the first admin with their own mailbox and address, and signs them in.
 * Account, directory, encrypted token, and resumable setup state commit in one transaction. There is no
 * in-progress lock to strand after a crash. Pasting the ownership token again resumes activation and sign-in.
 */
export const setup = new Hono<{ Bindings: Env }>()
	.use("*", async (c, next) => {
		const install = await getInstall(c.env.DIRECTORY);
		if (install && !install.setup && c.req.path !== "/api/setup/finish") return c.json({ error: "Magnus is already set up. Sign in instead." }, 409);
		c.header("Cache-Control", "no-store");
		await next();
	})

	.post("/verify", zValidator("json", TokenSchema), async (c) => {
		const cf = cloudflare(c.req.valid("json").token);
		const install = await findInstall(cf, c.env.CF_VERSION_METADATA.id);
		if (!install) return c.json({ error: NOT_THIS_INSTALL }, 403);
		const stored = await getInstall(c.env.DIRECTORY);
		if (stored && (stored.accountId !== install.accountId || stored.workerName !== install.workerName))
			return c.json({ error: NOT_THIS_INSTALL }, 403);
		const zones = await listZones(cf, install.accountId);
		if (stored?.setup) {
			await saveCloudflareToken(c.env, c.req.valid("json").token);
			for (const cookie of await signInWithoutCode(c.req.raw, stored.setup.email)) c.header("Set-Cookie", cookie, { append: true });
		}
		return c.json({ accountName: install.accountName, zones, claimed: stored?.setup ? claimed(stored.setup) : null });
	})

	.post("/complete", zValidator("json", CompleteSchema), async (c) => {
		const body = c.req.valid("json");
		const db = c.env.DIRECTORY;
		const cf = cloudflare(body.token);
		const install = await findInstall(cf, c.env.CF_VERSION_METADATA.id);
		if (!install) return c.json({ error: NOT_THIS_INSTALL }, 403);
		const zone = await getZone(cf, install.accountId, body.zoneId);
		if (!zone) return c.json({ error: "That domain isn't in this Cloudflare account." }, 404);
		if (body.email.endsWith(`@${zone.name}`)) {
			return c.json({ error: `Codes sent to ${zone.name} would arrive in Magnus itself. Use an address somewhere else.` }, 400);
		}
		const target = { domain: zone.name, zoneId: zone.id, email: body.email, address: `${body.localPart}@${zone.name}`, moveMail: body.moveMail };
		const userId = crypto.randomUUID();
		const mailbox = createMailbox(db, userId, body.name);
		const token = await cloudflareTokenStatement(c.env, body.token);
		try {
			// Better Auth's createUser commits separately. Bootstrap its schema here so the unique install row
			// arbitrates concurrent attempts and rolls back the entire losing account, not just the claim.
			await db.batch([
				db
					.prepare(`INSERT INTO settings (key, value) VALUES ('install', ?1)`)
					.bind(JSON.stringify({ accountId: install.accountId, workerName: install.workerName, setup: target })),
				db
					.prepare(`INSERT INTO auth_users (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?1, ?2, ?3, 0, 'admin', ?4, ?4)`)
					.bind(userId, body.name, body.email, Date.now()),
				db.prepare(`INSERT INTO domains (name, zone_id) VALUES (?1, ?2)`).bind(zone.name, zone.id),
				...mailbox.statements,
				...addAddress(db, target.address, body.name, [mailbox.id]),
				token,
			]);
		} catch (error) {
			// D1 can report an error after a commit. Matching the persisted attempt also handles a lost response.
			const stored = await getInstall(db);
			if (!stored) throw error;
			if (
				stored.accountId !== install.accountId ||
				stored.workerName !== install.workerName ||
				stored.setup?.email !== target.email ||
				stored.setup.address !== target.address ||
				stored.setup.zoneId !== target.zoneId
			) {
				return c.json({ error: "Someone else started setting up Magnus. Connect again to resume." }, 409);
			}
		}
		// Session failure leaves the committed setup intact. /verify can sign its owner in and resume.
		for (const cookie of await signInWithoutCode(c.req.raw, body.email)) c.header("Set-Cookie", cookie, { append: true });
		const stored = await getInstall(db);
		if (!stored?.setup) return c.json({ error: "Magnus is already set up. Sign in instead." }, 409);
		return c.json(claimed(stored.setup));
	})

	.post("/finish", zValidator("json", TokenSchema), async (c) => {
		const cf = cloudflare(c.req.valid("json").token);
		const [found, install] = await Promise.all([findInstall(cf, c.env.CF_VERSION_METADATA.id), getInstall(c.env.DIRECTORY)]);
		if (!found || !install || found.accountId !== install.accountId || found.workerName !== install.workerName)
			return c.json({ error: NOT_THIS_INSTALL }, 403);
		if (!install.setup) return c.body(null, 204);
		const { domain, zoneId } = install.setup;
		const statuses = await domainStatus({ cf, db: c.env.DIRECTORY, install, domain, zoneId });
		if (!STEP_IDS.every((id) => statuses[id].state === "done"))
			return c.json({ error: "The domain isn't ready yet. Check again to finish setup." }, 409);
		// Compare-and-swap: repeated finish requests are safe and can't overwrite an intervening change.
		await c.env.DIRECTORY.prepare(`UPDATE settings SET value = ?1 WHERE key = 'install' AND value = ?2`)
			.bind(JSON.stringify({ accountId: install.accountId, workerName: install.workerName }), JSON.stringify(install))
			.run();
		const stored = await getInstall(c.env.DIRECTORY);
		if (!stored || stored.setup) throw new Error("setup completion wasn't saved");
		return c.body(null, 204);
	});

function claimed(setup: NonNullable<Install["setup"]>) {
	return { domain: setup.domain, address: setup.address, moveMail: setup.moveMail };
}
