import { mailHost, PERMISSIONS, type Permission, type Zone } from "#shared";
import { z } from "zod";
import { optional } from "./optional";
import type { Install } from "./settings";

// The few Cloudflare API calls setup and the admin pages make, with the token someone pasted. The token is used
// for the request it arrived with and never stored.

const API = "https://api.cloudflare.com/client/v4";

const Envelope = z.object({
	success: z.boolean(),
	// Some APIs (Queues) answer a success with `"errors": null` rather than an empty list.
	errors: z.array(z.object({ code: z.number(), message: z.string() })).nullish(),
	result: z.unknown(),
});

/** Codes Cloudflare uses for a token it doesn't recognize at all, as opposed to one missing a permission. */
const BAD_TOKEN = new Set([1000, 6003, 6111, 9106, 9109]);

/** A Cloudflare API failure, worded for whoever pasted the token. */
export class CloudflareError extends Error {}

function failure(status: number, errors: { code: number; message: string }[], need: Permission): CloudflareError {
	if (status === 401 || errors.some((e) => BAD_TOKEN.has(e.code))) {
		return new CloudflareError("Cloudflare didn't accept that token. Copy it again from the token page.");
	}
	if (status === 403) return new CloudflareError(`The token needs ${PERMISSIONS[need].label}.`);
	return new CloudflareError(errors[0]?.message ?? `Cloudflare answered ${status}.`);
}

export type Cloudflare = ReturnType<typeof cloudflare>;

export function cloudflare(token: string) {
	const base = optional("CLOUDFLARE_API_BASE") ?? API;

	async function request(method: string, path: string, json?: unknown) {
		const res = await fetch(`${base}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "Content-Type": "application/json" }) },
			body: json === undefined ? undefined : JSON.stringify(json),
		});
		const body = Envelope.safeParse(await res.json().catch(() => null));
		return { status: res.status, ok: res.ok && body.success && body.data.success, body: body.success ? body.data : null };
	}

	async function call<T>(schema: z.ZodType<T>, need: Permission, method: string, path: string, json?: unknown): Promise<T> {
		const res = await request(method, path, json);
		if (!res.ok || !res.body) throw failure(res.status, res.body?.errors ?? [], need);
		return schema.parse(res.body.result);
	}

	return {
		get: <T>(schema: z.ZodType<T>, need: Permission, path: string) => call(schema, need, "GET", path),
		post: <T>(schema: z.ZodType<T>, need: Permission, path: string, json: unknown) => call(schema, need, "POST", path, json),
		put: <T>(schema: z.ZodType<T>, need: Permission, path: string, json: unknown) => call(schema, need, "PUT", path, json),
		delete: (need: Permission, path: string) => call(z.unknown(), need, "DELETE", path),
		/** A GET where any client error other than auth means "no". */
		exists: async (need: Permission, path: string): Promise<boolean> => {
			const res = await request("GET", path);
			if (res.ok) return true;
			if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) return false;
			throw failure(res.status, res.body?.errors ?? [], need);
		},
	};
}

const Named = z.object({ id: z.string(), name: z.string() });

/**
 * Finds this Worker in the token's accounts by the version that's running right now. Only an account that
 * deployed this exact version can see it, so a match proves whoever pasted the token owns this install.
 * Most people keep the default name, but a renamed Worker is found too.
 */
export async function findInstall(cf: Cloudflare, versionId: string): Promise<(Install & { accountName: string }) | null> {
	const accounts = await cf.get(z.array(Named), "scripts", "/accounts?per_page=50");
	for (const account of accounts) {
		const scripts = await cf.get(z.array(z.object({ id: z.string() })), "scripts", `/accounts/${account.id}/workers/scripts`);
		const matches = await Promise.all(
			scripts.map(async ({ id }) =>
				(await cf.exists("scripts", `/accounts/${account.id}/workers/scripts/${encodeURIComponent(id)}/versions/${versionId}`)) ? id : null,
			),
		);
		const workerName = matches.find((id) => id !== null);
		if (workerName) return { accountId: account.id, accountName: account.name, workerName };
	}
	return null;
}

const MxRecord = z.object({ id: z.string(), content: z.string() });

export const mxRecords = (cf: Cloudflare, zoneId: string) => cf.get(z.array(MxRecord), "dns", `/zones/${zoneId}/dns_records?type=MX&per_page=50`);

/** The account's active domains, with who receives their mail today. */
export async function listZones(cf: Cloudflare, accountId: string): Promise<Zone[]> {
	const zones = await cf.get(z.array(Named), "zone", `/zones?account.id=${accountId}&status=active&per_page=50`);
	return Promise.all(zones.map(async (zone) => ({ ...zone, mail: mailHost((await mxRecords(cf, zone.id)).map((r) => r.content)) })));
}

/** Null unless the zone belongs to this install's account. */
export async function getZone(cf: Cloudflare, accountId: string, zoneId: string): Promise<Zone | null> {
	const zone = await cf.get(Named.extend({ account: z.object({ id: z.string() }) }), "zone", `/zones/${zoneId}`);
	if (zone.account.id !== accountId) return null;
	return { id: zone.id, name: zone.name, mail: mailHost((await mxRecords(cf, zone.id)).map((r) => r.content)) };
}
