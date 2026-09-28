import { zValidator } from "@hono/zod-validator";
import { normalizeAddress } from "#shared";
import { Hono } from "hono";
import { z } from "zod";
import { auth, signInWithoutCode } from "./auth";
import { cloudflare, findInstall, getZone, listZones } from "./cloudflare";
import { addAddress, addDomain, createMailbox } from "./directory";
import { claimInstall, getInstall, releaseInstall } from "./settings";

/**
 * First run, before anyone can sign in: /setup proves the visitor owns this install with a Cloudflare token
 * (see findInstall), then creates them as the first admin with their own mailbox and address, and signs them in.
 * Turning the domain on happens next, through the same admin endpoints the Domains page uses.
 */
export const setup = new Hono<{ Bindings: Env }>();

setup.use("*", async (c, next) => {
	if (await getInstall(c.env.DIRECTORY)) return c.json({ error: "Magnus is already set up. Sign in instead." }, 409);
	await next();
});

const NOT_THIS_INSTALL =
	"That token can't see this Magnus install. Create it in the Cloudflare account Magnus is deployed to, with Workers Scripts · Read.";

export const TokenSchema = z.object({ token: z.string().trim().min(1, "Paste your Cloudflare API token.") });

setup.post("/verify", zValidator("json", TokenSchema), async (c) => {
	const cf = cloudflare(c.req.valid("json").token);
	const install = await findInstall(cf, c.env.CF_VERSION_METADATA.id);
	if (!install) return c.json({ error: NOT_THIS_INSTALL }, 403);
	return c.json({ accountName: install.accountName, zones: await listZones(cf, install.accountId) });
});

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
});

setup.post("/complete", zValidator("json", CompleteSchema), async (c) => {
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
	if (!(await claimInstall(db, { accountId: install.accountId, workerName: install.workerName }))) {
		return c.json({ error: "Someone else just finished setting up Magnus." }, 409);
	}

	let userId: string | null = null;
	try {
		// No headers: a server call, which the admin plugin allows without an admin session.
		({ user: { id: userId } } = await (await auth(c.req.raw)).api.createUser({ body: { email: body.email, name: body.name, role: "admin" } }));
		const mailbox = createMailbox(db, userId, body.name);
		await addDomain(db, zone.name, zone.id);
		await db.batch([...mailbox.statements, ...addAddress(db, `${body.localPart}@${zone.name}`, body.name, [mailbox.id])]);

		const res = c.body(null, 204);
		for (const cookie of await signInWithoutCode(c.req.raw, body.email)) res.headers.append("Set-Cookie", cookie);
		return res;
	} catch (error) {
		// Put things back so setup can run again. Deleting the person takes their membership with them.
		await db.batch([
			db.prepare(`DELETE FROM auth_users WHERE id = ?1`).bind(userId),
			db.prepare(`DELETE FROM mailboxes WHERE id NOT IN (SELECT mailbox_id FROM mailbox_members)`),
			db.prepare(`DELETE FROM domains WHERE name = ?1`).bind(zone.name),
		]);
		await releaseInstall(db);
		throw error;
	}
});
