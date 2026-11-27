import { zValidator } from "@hono/zod-validator";
import { normalizeAddress, PERMISSIONS, STEP_IDS } from "#shared";
import { Hono } from "hono";
import { z } from "zod";
import { currentUser, signInWithoutCode } from "./auth";
import { cloudflare, type Cloudflare, findInstall, getZone, listZones } from "./cloudflare";
import { domainStatus } from "./connect";
import { addAddress, codesWouldLandHere, createMailbox } from "./directory";
import { cloudflareTokenStatement, getInstall, type Install, saveCloudflareToken } from "./settings";

export const NOT_THIS_INSTALL =
	"That token can't see this Magnus install. Create it in the Cloudflare account Magnus is deployed to, with the permissions Magnus asks for.";

const NEEDS_DNS_WRITE = `That token can see this Magnus install, but setup also needs ${PERMISSIONS.dns.label} for the domain.`;
const WRONG_BROWSER = "This browser didn't start setting Magnus up. Open the Worker in that browser to resume.";

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
 * First run, before anyone can sign in: /setup proves the visitor controls this install with a Cloudflare token
 * that can see this Worker version and write the setup domain's DNS, then creates them as the first admin with
 * their own mailbox and address, and signs them in. Account, directory, encrypted token, and resumable setup
 * state commit in one transaction. There is no in-progress lock to strand after a crash. Only the browser that
 * started setup can paste the token again to resume it: /complete stores a hash of its setup cookie.
 */
export const setup = new Hono<{ Bindings: Env }>()
	.use("*", async (c, next) => {
		const install = await getInstall(c.env.DIRECTORY);
		if (install && !install.setup && c.req.path !== "/api/setup/finish") return c.json({ error: "Magnus is already set up. Sign in instead." }, 409);
		c.header("Cache-Control", "no-store");
		await next();
	})

	.post("/verify", zValidator("json", TokenSchema), async (c) => {
		const stored = await getInstall(c.env.DIRECTORY);
		if (stored?.setup && !(await resumesSetup(c.req.raw, stored.setup))) return c.json({ error: WRONG_BROWSER }, 403);
		const cf = cloudflare(c.req.valid("json").token);
		const install = await findInstall(cf, c.env.CF_VERSION_METADATA.id);
		if (!install) return c.json({ error: NOT_THIS_INSTALL }, 403);
		if (stored && (stored.accountId !== install.accountId || stored.workerName !== install.workerName))
			return c.json({ error: NOT_THIS_INSTALL }, 403);
		const zones = await listZones(cf, install.accountId);
		const candidates = stored?.setup ? [stored.setup.zoneId] : zones.map((zone) => zone.id);
		const writes = await Promise.all(candidates.map((zoneId) => canWriteDns(cf, zoneId)));
		if (!writes.some(Boolean)) return c.json({ error: NEEDS_DNS_WRITE }, 403);
		c.header("Set-Cookie", setupCookie(setupSecret(c.req.raw) ?? newSetupSecret()), { append: true });
		if (stored?.setup) {
			await saveCloudflareToken(c.env, c.req.valid("json").token);
			for (const cookie of await signInWithoutCode(c.req.raw, stored.setup.email)) c.header("Set-Cookie", cookie, { append: true });
		}
		return c.json({ accountName: install.accountName, zones, claimed: stored?.setup ? claimed(stored.setup) : null });
	})

	.post("/complete", zValidator("json", CompleteSchema), async (c) => {
		const body = c.req.valid("json");
		const db = c.env.DIRECTORY;
		const existing = await getInstall(db);
		if (existing?.setup && !(await resumesSetup(c.req.raw, existing.setup))) return c.json({ error: WRONG_BROWSER }, 403);
		const secret = setupSecret(c.req.raw) ?? newSetupSecret();
		c.header("Set-Cookie", setupCookie(secret), { append: true });
		const cf = cloudflare(body.token);
		const install = await findInstall(cf, c.env.CF_VERSION_METADATA.id);
		if (!install) return c.json({ error: NOT_THIS_INSTALL }, 403);
		const zone = await getZone(cf, install.accountId, body.zoneId);
		if (!zone) return c.json({ error: "That domain isn't in this Cloudflare account." }, 404);
		if (!(await canWriteDns(cf, zone.id))) return c.json({ error: NEEDS_DNS_WRITE }, 403);
		if (body.email.endsWith(`@${zone.name}`)) {
			return c.json({ error: codesWouldLandHere(zone.name) }, 400);
		}
		const target = {
			domain: zone.name,
			zoneId: zone.id,
			email: body.email,
			address: `${body.localPart}@${zone.name}`,
			moveMail: body.moveMail,
			resumeHash: await hashSetupSecret(secret),
		};
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
			if (!(await resumesSetup(c.req.raw, stored.setup))) return c.json({ error: WRONG_BROWSER }, 403);
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
		if (!(await resumesSetup(c.req.raw, install.setup))) return c.json({ error: WRONG_BROWSER }, 403);
		const { domain, zoneId } = install.setup;
		if (!(await canWriteDns(cf, zoneId))) return c.json({ error: NEEDS_DNS_WRITE }, 403);
		const statuses = await domainStatus({ cf, db: c.env.DIRECTORY, install, domain, zoneId });
		if (!STEP_IDS.every((id) => statuses[id].state === "done"))
			return c.json({ error: "The domain isn't ready yet. Check again to finish setup." }, 409);
		// Compare-and-swap: repeated finish requests are safe and can't overwrite an intervening change.
		await c.env.DIRECTORY.prepare(`UPDATE settings SET value = ?1 WHERE key = 'install' AND value = ?2`)
			.bind(JSON.stringify({ accountId: install.accountId, workerName: install.workerName }), JSON.stringify(install))
			.run();
		const stored = await getInstall(c.env.DIRECTORY);
		if (!stored || stored.setup) throw new Error("setup completion wasn't saved");
		c.header("Set-Cookie", `${SETUP_COOKIE}=; Path=/api/setup; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, { append: true });
		return c.body(null, 204);
	});

function claimed(setup: NonNullable<Install["setup"]>) {
	return { domain: setup.domain, address: setup.address, moveMail: setup.moveMail };
}

/** The certainly missing DNS record whose DELETE is setup's harmless DNS · Edit probe. */
const PROBE_DNS_RECORD = "0".repeat(32);
const canWriteDns = (cf: Cloudflare, zoneId: string) => cf.probeDelete("dns", `/zones/${zoneId}/dns_records/${PROBE_DNS_RECORD}`);

const SETUP_COOKIE = "magnus_setup";
const SETUP_COOKIE_DAYS = 30;

function newSetupSecret(): string {
	return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The setup cookie's value, or null when missing or mangled. */
function setupSecret(request: Request): string | null {
	const value = new RegExp(`(?:^|;\\s*)${SETUP_COOKIE}=([^;]*)`).exec(request.headers.get("Cookie") ?? "")?.[1];
	return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function setupCookie(secret: string): string {
	return `${SETUP_COOKIE}=${secret}; Path=/api/setup; HttpOnly; Secure; SameSite=Strict; Max-Age=${SETUP_COOKIE_DAYS * 24 * 60 * 60}`;
}

async function hashSetupSecret(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether this browser may resume. New setups need the cookie whose hash committed with the account. One started
 * before that hash existed can't know its browser retroactively; there, the owner has to be signed in as its admin.
 */
async function resumesSetup(request: Request, setup: NonNullable<Install["setup"]>): Promise<boolean> {
	const secret = setupSecret(request);
	if (secret && setup.resumeHash && (await hashSetupSecret(secret)) === setup.resumeHash) return true;
	if (setup.resumeHash) return false;
	const signedIn = await currentUser(request);
	return signedIn?.user.isAdmin === true && signedIn.user.email === setup.email;
}
