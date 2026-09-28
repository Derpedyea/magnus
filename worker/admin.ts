import { zValidator } from "@hono/zod-validator";
import { normalizeAddress, STEP_IDS } from "#shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./api";
import { auth } from "./auth";
import { cloudflare, getZone, listZones } from "./cloudflare";
import { type DomainContext, domainStatus, runStep } from "./connect";
import { addAddress, addDomain, createMailbox, deleteMailboxes, getDirectory, getDomain, removeAddress, removeDomain, setCatchAll, soleMailboxes } from "./directory";
import { getInstall } from "./settings";
import { LocalPartSchema, TokenSchema } from "./setup";

/**
 * Domains, people, and addresses, for admins. Role changes and suspensions go straight from the browser to
 * Better Auth's admin plugin (/api/auth/admin/*); what's here also touches mailboxes or Cloudflare.
 */
export const admin = new Hono<AppEnv>();

admin.use("*", async (c, next) => {
	if (!c.var.user.isAdmin) return c.json({ error: "Only admins can do that." }, 403);
	await next();
});

admin.get("/directory", async (c) => c.json(await getDirectory(c.env.DIRECTORY)));

// ─── Domains (Cloudflare calls carry the pasted token) ────────────────────────

async function install(c: Context<AppEnv>) {
	const found = await getInstall(c.env.DIRECTORY);
	if (!found) throw new Error("admin request before setup");
	return found;
}

admin.post("/zones", zValidator("json", TokenSchema), async (c) => {
	const { accountId } = await install(c);
	return c.json({ zones: await listZones(cloudflare(c.req.valid("json").token), accountId) });
});

admin.post("/domains", zValidator("json", TokenSchema.extend({ zoneId: z.string().min(1) })), async (c) => {
	const { token, zoneId } = c.req.valid("json");
	const zone = await getZone(cloudflare(token), (await install(c)).accountId, zoneId);
	if (!zone) return c.json({ error: "That domain isn't in this Cloudflare account." }, 404);
	await addDomain(c.env.DIRECTORY, zone.name, zone.id);
	return c.json({ name: zone.name }, 201);
});

async function domainContext(c: Context<AppEnv>, token: string): Promise<DomainContext | null> {
	const domain = await getDomain(c.env.DIRECTORY, c.req.param("domain") ?? "");
	if (!domain?.zoneId) return null;
	return { cf: cloudflare(token), db: c.env.DIRECTORY, install: await install(c), domain: domain.name, zoneId: domain.zoneId };
}

admin.post("/domains/:domain/status", zValidator("json", TokenSchema), async (c) => {
	const ctx = await domainContext(c, c.req.valid("json").token);
	return ctx ? c.json(await domainStatus(ctx)) : c.json({ error: "Not found" }, 404);
});

admin.post(
	"/domains/:domain/steps/:step",
	zValidator("param", z.object({ domain: z.string(), step: z.enum(STEP_IDS) })),
	zValidator("json", TokenSchema.extend({ moveMail: z.boolean().optional() })),
	async (c) => {
		const { token, moveMail } = c.req.valid("json");
		const ctx = await domainContext(c, token);
		return ctx ? c.json(await runStep(ctx, c.req.valid("param").step, { moveMail })) : c.json({ error: "Not found" }, 404);
	},
);

admin.patch("/domains/:domain", zValidator("json", z.object({ catchAllMailboxId: z.string().nullable() })), async (c) => {
	await setCatchAll(c.env.DIRECTORY, c.req.param("domain"), c.req.valid("json").catchAllMailboxId);
	return c.body(null, 204);
});

admin.delete("/domains/:domain", async (c) => {
	await removeDomain(c.env.DIRECTORY, c.req.param("domain"));
	return c.body(null, 204);
});

// ─── People ───────────────────────────────────────────────────────────────────

const AddressInput = z.object({ localPart: LocalPartSchema, domain: z.string().min(1) });

admin.post(
	"/people",
	zValidator(
		"json",
		z.object({
			name: z.string().trim().min(1).max(100),
			email: z.email().transform(normalizeAddress),
			isAdmin: z.boolean(),
			/** Their first address, delivered to their new mailbox. */
			address: AddressInput.optional(),
		}),
	),
	async (c) => {
		const body = c.req.valid("json");
		const db = c.env.DIRECTORY;
		const { user } = await (await auth(c.req.raw)).api.createUser({
			body: { email: body.email, name: body.name, role: body.isAdmin ? "admin" : "user" },
		});
		const mailbox = createMailbox(db, user.id, body.name);
		const address = body.address ? addAddress(db, `${body.address.localPart}@${body.address.domain}`, body.name, [mailbox.id]) : [];
		await db.batch([...mailbox.statements, ...address]);
		return c.json({ id: user.id }, 201);
	},
);

/** Their own mailboxes go too, mail and all, along with addresses that delivered only there. */
admin.delete("/people/:id", async (c) => {
	const id = c.req.param("id");
	if (id === c.var.user.id) return c.json({ error: "You can't remove yourself." }, 400);
	const db = c.env.DIRECTORY;
	const mailboxIds = await soleMailboxes(db, id);
	// Cascades to their sessions, sign-in methods, and memberships.
	await db.prepare(`DELETE FROM auth_users WHERE id = ?1`).bind(id).run();
	await deleteMailboxes(db, mailboxIds);
	c.executionCtx.waitUntil(Promise.all(mailboxIds.map((mailboxId) => c.env.MAILBOX.getByName(mailboxId).destroy())));
	return c.body(null, 204);
});

// ─── Addresses ────────────────────────────────────────────────────────────────

admin.post(
	"/addresses",
	zValidator(
		"json",
		AddressInput.extend({
			displayName: z.string().trim().max(100).optional(),
			/** More than one makes it a group address: each gets a copy. */
			mailboxIds: z.array(z.string()).min(1),
		}),
	),
	async (c) => {
		const body = c.req.valid("json");
		const address = `${body.localPart}@${body.domain}`;
		await c.env.DIRECTORY.batch(addAddress(c.env.DIRECTORY, address, body.displayName || null, body.mailboxIds));
		return c.json({ address }, 201);
	},
);

admin.delete("/addresses/:address", async (c) => {
	await removeAddress(c.env.DIRECTORY, c.req.param("address"));
	return c.body(null, 204);
});
