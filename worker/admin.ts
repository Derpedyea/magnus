import { zValidator } from "@hono/zod-validator";
import { blockPattern, normalizeAddress, STEP_IDS } from "#shared";
import { type Context, Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "./api";
import { auth, isAdminNow } from "./auth";
import { type Cloudflare, cloudflare, CloudflareError, findInstall, getZone, listZones } from "./cloudflare";
import { type DomainContext, domainStatus, runStep } from "./connect";
import {
	addAddress,
	addDomain,
	addressExists,
	blockSender,
	createMailbox,
	deleteMailboxes,
	deleteMailboxStatements,
	getDirectory,
	getDomain,
	removeAddress,
	removeDomain,
	setCatchAll,
	soleMailboxes,
	unblockSender,
} from "./directory";
import { forgetCloudflareToken, getInstall, loadCloudflareToken, saveCloudflareToken } from "./settings";
import { LocalPartSchema, NOT_THIS_INSTALL, TokenSchema } from "./setup";

async function install(c: Context<AppEnv>) {
	const found = await getInstall(c.env.DIRECTORY);
	if (!found) throw new Error("admin request before setup");
	return found;
}

/** The page asks for a token when the directory says none is saved, so this only fails if it was just forgotten. */
async function savedCloudflare(c: Context<AppEnv>): Promise<Cloudflare> {
	const token = await loadCloudflareToken(c.env);
	if (!token) throw new CloudflareError("Paste a Cloudflare API token first.");
	return cloudflare(token);
}

async function domainContext(c: Context<AppEnv>): Promise<DomainContext | null> {
	const domain = await getDomain(c.env.DIRECTORY, c.req.param("domain") ?? "");
	if (!domain?.zoneId) return null;
	return { cf: await savedCloudflare(c), db: c.env.DIRECTORY, install: await install(c), domain: domain.name, zoneId: domain.zoneId };
}

const AddressInput = z.object({ localPart: LocalPartSchema, domain: z.string().min(1) });

const BlockPatternSchema = z.string().transform((input, ctx) => {
	const pattern = blockPattern(input);
	if (!pattern) ctx.addIssue({ code: "custom", message: "Enter an address or a domain." });
	return pattern ?? z.NEVER;
});

/**
 * Domains, people, addresses, and blocked senders, for admins. Role changes and suspensions go straight from the
 * browser to Better Auth's admin plugin (/api/auth/admin/*); what's here also touches mailboxes or Cloudflare.
 */
export const admin = new Hono<AppEnv>()
	.use("*", async (c, next) => {
		if (!(await isAdminNow(c.req.raw))) return c.json({ error: "Only admins can do that." }, 403);
		await next();
	})

	.get("/directory", async (c) => c.json(await getDirectory(c.env.DIRECTORY)))

	// ─── Domains (Cloudflare calls use the saved token) ───────────────────────────

	/** Saves a token once it's shown to belong to the account this install runs in, replacing any saved before. */
	.put("/cloudflare-token", zValidator("json", TokenSchema), async (c) => {
		const { token } = c.req.valid("json");
		const found = await findInstall(cloudflare(token), c.env.CF_VERSION_METADATA.id);
		if (found?.accountId !== (await install(c)).accountId) return c.json({ error: NOT_THIS_INSTALL }, 403);
		await saveCloudflareToken(c.env, token);
		return c.body(null, 204);
	})

	.delete("/cloudflare-token", async (c) => {
		await forgetCloudflareToken(c.env);
		return c.body(null, 204);
	})

	.get("/zones", async (c) => {
		const { accountId } = await install(c);
		return c.json({ zones: await listZones(await savedCloudflare(c), accountId) });
	})

	.post("/domains", zValidator("json", z.object({ zoneId: z.string().min(1) })), async (c) => {
		const zone = await getZone(await savedCloudflare(c), (await install(c)).accountId, c.req.valid("json").zoneId);
		if (!zone) return c.json({ error: "That domain isn't in this Cloudflare account." }, 404);
		await addDomain(c.env.DIRECTORY, zone.name, zone.id);
		return c.json({ name: zone.name }, 201);
	})

	.post("/domains/:domain/status", async (c) => {
		const ctx = await domainContext(c);
		return ctx ? c.json(await domainStatus(ctx)) : c.json({ error: "Not found" }, 404);
	})

	.post(
		"/domains/:domain/steps/:step",
		zValidator("param", z.object({ domain: z.string(), step: z.enum(STEP_IDS) })),
		zValidator("json", z.object({ moveMail: z.boolean().optional() })),
		async (c) => {
			const ctx = await domainContext(c);
			return ctx ? c.json(await runStep(ctx, c.req.valid("param").step, { moveMail: c.req.valid("json").moveMail })) : c.json({ error: "Not found" }, 404);
		},
	)

	.patch("/domains/:domain", zValidator("json", z.object({ catchAllMailboxId: z.string().nullable() })), async (c) => {
		await setCatchAll(c.env.DIRECTORY, c.req.param("domain"), c.req.valid("json").catchAllMailboxId);
		return c.body(null, 204);
	})

	.delete("/domains/:domain", async (c) => {
		await removeDomain(c.env.DIRECTORY, c.req.param("domain"));
		return c.body(null, 204);
	})

	// ─── People ───────────────────────────────────────────────────────────────────

	.post(
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
			const address = body.address && `${body.address.localPart}@${body.address.domain}`;
			// Better Auth commits the person before their mailbox and address are made, so rule out what would predictably fail.
			if (body.address && !(await getDomain(db, body.address.domain))) return c.json({ error: "That domain isn't in Magnus." }, 404);
			if (address && (await addressExists(db, address))) return c.json({ error: "That address is already taken." }, 409);
			// With the headers, Better Auth checks the caller may create users and set roles; without, it trusts the server.
			const { user } = await (await auth(c.req.raw)).api.createUser({
				body: { email: body.email, name: body.name, role: body.isAdmin ? "admin" : "user" },
				headers: c.req.raw.headers,
			});
			const mailbox = createMailbox(db, user.id, body.name);
			try {
				await db.batch([...mailbox.statements, ...(address ? addAddress(db, address, body.name, [mailbox.id]) : [])]);
			} catch (error) {
				// Another admin just took the address, or D1 failed. Undo both sides so nothing blocks a retry: D1 can report
				// a failure for writes it applied, and if the batch did roll back, removing the mailbox finds nothing. One batch,
				// so a failure here can't leave the person without the rest.
				await db.batch([...deleteMailboxStatements(db, [mailbox.id]), db.prepare(`DELETE FROM auth_users WHERE id = ?1`).bind(user.id)]);
				// Mail its address took in the meantime may have reached the mailbox already (see ingest).
				c.executionCtx.waitUntil(c.env.MAILBOX.getByName(mailbox.id).destroy());
				if (address && (await addressExists(db, address))) return c.json({ error: "That address is already taken." }, 409);
				throw error;
			}
			return c.json({ id: user.id }, 201);
		},
	)

	/** Their own mailboxes go too, mail and all, along with addresses that delivered only there. */
	.delete("/people/:id", async (c) => {
		const id = c.req.param("id");
		if (id === c.var.user.id) return c.json({ error: "You can't remove yourself." }, 400);
		const db = c.env.DIRECTORY;
		const mailboxIds = await soleMailboxes(db, id);
		// Cascades to their sessions, sign-in methods, and memberships.
		await db.prepare(`DELETE FROM auth_users WHERE id = ?1`).bind(id).run();
		await deleteMailboxes(db, mailboxIds);
		c.executionCtx.waitUntil(Promise.all(mailboxIds.map((mailboxId) => c.env.MAILBOX.getByName(mailboxId).destroy())));
		return c.body(null, 204);
	})

	// ─── Addresses ────────────────────────────────────────────────────────────────

	.post(
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
	)

	.delete("/addresses/:address", async (c) => {
		await removeAddress(c.env.DIRECTORY, c.req.param("address"));
		return c.body(null, 204);
	})

	// ─── Blocked senders ──────────────────────────────────────────────────────────

	/** Refused at SMTP time from now on, for every mailbox. Mail already received stays. */
	.post("/blocked-senders", zValidator("json", z.object({ pattern: BlockPatternSchema })), async (c) => {
		await blockSender(c.env.DIRECTORY, c.req.valid("json").pattern);
		return c.body(null, 204);
	})

	.delete("/blocked-senders/:pattern", async (c) => {
		await unblockSender(c.env.DIRECTORY, c.req.param("pattern"));
		return c.body(null, 204);
	});
