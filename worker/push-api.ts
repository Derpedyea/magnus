import { zValidator } from "@hono/zod-validator";
import { PushSubscriptionSchema } from "#shared/schemas";
import { Hono } from "hono";
import type { AppEnv } from "./api";
import { currentSessionId } from "./auth";
import { vapidKeys } from "./push";

const SIGN_IN_AGAIN = "Sign in again to turn on notifications";

/**
 * Notifications on this browser, for the session it's signed in with. A session is one browser, so it has at most one
 * subscription, and ending the session (signing out, suspension, removal) deletes it.
 */
export const pushRoutes = new Hono<AppEnv>()
	/** The key browsers subscribe with, and where this session gets notifications now, if it does. */
	.get("/", async (c) => {
		const sessionId = await currentSessionId(c.req.raw);
		const row = sessionId
			? await c.env.DIRECTORY.prepare(`SELECT endpoint FROM push_subscriptions WHERE session_id = ?1`).bind(sessionId).first<{ endpoint: string }>()
			: null;
		return c.json({ publicKey: (await vapidKeys(c.env.DIRECTORY)).publicKey, endpoint: row?.endpoint ?? null });
	})

	/** Turns notifications on here. A browser another session had moves to this one: it's who's signed in on it now. */
	.put("/", zValidator("json", PushSubscriptionSchema), async (c) => {
		const { endpoint, keys } = c.req.valid("json");
		const sessionId = await currentSessionId(c.req.raw);
		if (!sessionId) return c.json({ error: SIGN_IN_AGAIN }, 401);
		const db = c.env.DIRECTORY;
		// The insert lands only while the session is live and the person's own (not an admin impersonating them), checked
		// in the same write, since the session cookie is cached for minutes after it's revoked.
		const [, saved] = await db.batch([
			db.prepare(`DELETE FROM push_subscriptions WHERE session_id = ?1 AND endpoint <> ?2`).bind(sessionId, endpoint),
			db
				.prepare(
					`INSERT INTO push_subscriptions (endpoint, session_id, p256dh, auth, origin)
					 SELECT ?1, id, ?3, ?4, ?5 FROM auth_sessions WHERE id = ?2 AND expiresAt > ?6 AND impersonatedBy IS NULL
					 ON CONFLICT (endpoint) DO UPDATE SET session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin`,
				)
				.bind(endpoint, sessionId, keys.p256dh, keys.auth, new URL(c.req.url).origin, new Date().toISOString()),
		]);
		if (!saved?.meta.changes) return c.json({ error: SIGN_IN_AGAIN }, 401);
		return c.body(null, 204);
	})

	.delete("/", async (c) => {
		const sessionId = await currentSessionId(c.req.raw);
		if (sessionId) await c.env.DIRECTORY.prepare(`DELETE FROM push_subscriptions WHERE session_id = ?1`).bind(sessionId).run();
		return c.body(null, 204);
	});
