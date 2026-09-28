import { env } from "cloudflare:workers";

/**
 * Optional settings. Magnus needs none of them; set them with `wrangler secret put`, or in .dev.vars locally.
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   both set: adds "Continue with Google"
 *   DEV_USER_EMAIL                           local dev: signs this person in on localhost without a code
 *   CLOUDFLARE_API_BASE                      local dev: sends Cloudflare API calls to a fake, to test setup
 *
 * Read by name rather than through Env: `wrangler types` only sees them when .dev.vars happens to have them.
 */
export function optional(name: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "DEV_USER_EMAIL" | "CLOUDFLARE_API_BASE"): string | undefined {
	const value: unknown = Reflect.get(env, name);
	return typeof value === "string" && value !== "" ? value : undefined;
}
