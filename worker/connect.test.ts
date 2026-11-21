import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudflare } from "./cloudflare";
import { type DomainContext, routingStatus } from "./connect";

vi.mock("cloudflare:workers", () => ({ env: {} }));

afterEach(() => vi.unstubAllGlobals());

const CLOUDFLARE_MX = ["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"];

/** Email Routing on, with the status Cloudflare reports and the zone's MX records as [name, host]. */
function zone(status: string, mx: [string, string][]): DomainContext {
	vi.stubGlobal("fetch", async (input: string) => {
		const url = new URL(input);
		if (url.pathname.endsWith("/email/routing")) return Response.json({ success: true, result: { enabled: true, status } });
		if (url.pathname.endsWith("/dns_records")) {
			return Response.json({ success: true, result: mx.map(([name, content], i) => ({ id: `mx-${i}`, type: "MX", name, content })) });
		}
		throw new Error(`unexpected fetch ${input}`);
	});
	return { cf: cloudflare("token"), domain: "example.com", zoneId: "zone" } as DomainContext;
}

describe("routingStatus", () => {
	it("is done once the domain's MX records are Cloudflare's, even if Cloudflare flags another record", async () => {
		// Seen on a domain moved from Proton: MX in place, apex SPF still Proton's → "misconfigured/locked".
		const ctx = zone("misconfigured/locked", CLOUDFLARE_MX.map((host) => ["example.com", host]));
		expect(await routingStatus(ctx)).toEqual({ state: "done" });
	});

	it("waits while only Email Sending's cf-bounce MX records point at Cloudflare", async () => {
		const ctx = zone("unconfigured", CLOUDFLARE_MX.map((host) => ["cf-bounce.example.com", host]));
		expect((await routingStatus(ctx)).state).toBe("pending");
	});
});
