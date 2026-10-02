import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cloudflare } from "./cloudflare";
import { mtaStsPolicy, mtaStsStatus, publishMtaSts } from "./mta-sts";

vi.mock("cloudflare:workers", () => ({ env: {} }));

afterEach(() => vi.unstubAllGlobals());

const POLICY = "version: STSv1\nmode: enforce\nmx: *.mx.cloudflare.net\nmax_age: 86400\n";
const CLOUDFLARE_MX = ["13 route2.mx.cloudflare.net.", "15 route3.mx.cloudflare.net.", "48 route1.mx.cloudflare.net."];

/** DNS-over-HTTPS answers the MX records given; Cloudflare's policy answers with `upstream`. */
function stubInternet(mx: string[], upstream = new Response(POLICY)) {
	const fetched: string[] = [];
	vi.stubGlobal("fetch", async (url: string) => {
		fetched.push(url);
		if (url.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: mx.map((data) => ({ type: 15, data })) });
		if (url === "https://mta-sts.mx.cloudflare.net/.well-known/mta-sts.txt") return upstream;
		throw new Error(`unexpected fetch ${url}`);
	});
	return fetched;
}

const receives = async (domain: string) => domain === "example.com";

describe("mtaStsPolicy", () => {
	it("serves Cloudflare's policy for a domain whose mail comes here", async () => {
		stubInternet(CLOUDFLARE_MX);
		const res = await mtaStsPolicy("mta-sts.example.com", receives);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/plain");
		expect(await res.text()).toBe(POLICY);
	});

	it.each([
		["the domain's mail has moved elsewhere", "mta-sts.example.com", ["10 aspmx.l.google.com."]],
		["Magnus doesn't receive the domain", "mta-sts.example.org", CLOUDFLARE_MX],
		["the host isn't an MTA-STS host", "mail.example.com", CLOUDFLARE_MX],
	])("serves no policy when %s", async (_, host, mx) => {
		const fetched = stubInternet(mx);
		expect((await mtaStsPolicy(host, receives)).status).toBe(404);
		expect(fetched).not.toContain("https://mta-sts.mx.cloudflare.net/.well-known/mta-sts.txt");
	});

	it("passes on Cloudflare's failure rather than inventing a policy", async () => {
		stubInternet(CLOUDFLARE_MX, new Response("down", { status: 503 }));
		expect((await mtaStsPolicy("mta-sts.example.com", receives)).status).toBe(502);
	});
});

const DnsInput = z.object({ type: z.string(), name: z.string(), content: z.string(), proxied: z.boolean() });
const RouteInput = z.object({ pattern: z.string(), script: z.string() });

/** Just enough of Cloudflare's DNS and Workers routes API, keeping what's written so a second run sees it. */
function fakeZone(records: (z.infer<typeof DnsInput> & { id: string })[], routes: (z.infer<typeof RouteInput> & { id: string })[] = []) {
	const writes: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		const method = init?.method ?? "GET";
		const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
		if (method === "GET" && url.pathname.endsWith("/dns_records")) return ok(records.filter((r) => r.name === url.searchParams.get("name")));
		if (method === "GET" && url.pathname.endsWith("/workers/routes")) return ok(routes);
		const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
		if (method === "POST" && url.pathname.endsWith("/dns_records")) {
			const record = DnsInput.parse(body);
			records.push({ ...record, id: `r${records.length + 1}` });
			writes.push(`add ${record.type} ${record.name}`);
		} else if (method === "POST" && url.pathname.endsWith("/workers/routes")) {
			const route = RouteInput.parse(body);
			routes.push({ ...route, id: `w${routes.length + 1}` });
			writes.push(`route ${route.pattern} → ${route.script}`);
		} else if (method === "DELETE") {
			const id = url.pathname.split("/").pop();
			const list = url.pathname.includes("/workers/routes/") ? routes : records;
			const at = list.findIndex((r) => r.id === id);
			const [gone] = list.splice(at, 1);
			writes.push(`delete ${gone && "name" in gone ? gone.name : gone?.pattern}`);
		} else throw new Error(`unexpected ${method} ${url.pathname}`);
		return ok({});
	});
	return writes;
}

const ctx = { cf: cloudflare("token"), install: { accountId: "acc", workerName: "magnus" }, domain: "example.com", zoneId: "zone" };
const OLD_POLICY = { id: "old", type: "TXT", name: "_mta-sts.example.com", content: '"v=STSv1; id=2024"', proxied: false };

describe("the MTA-STS step", () => {
	it("serves the policy before announcing it, and then has nothing left to do", async () => {
		const writes = fakeZone([]);
		expect(await mtaStsStatus(ctx)).toEqual({ state: "todo" });
		expect(await publishMtaSts(ctx, {}, { state: "todo" })).toEqual({ state: "done" });
		expect(writes).toEqual([
			"add AAAA mta-sts.example.com",
			"route mta-sts.example.com/.well-known/mta-sts.txt → magnus",
			"add CNAME _mta-sts.example.com",
		]);
		expect(await mtaStsStatus(ctx)).toEqual({ state: "done" });
	});

	it("leaves another policy alone unless the admin is moving mail here", async () => {
		const writes = fakeZone([{ ...OLD_POLICY }]);
		const before = await mtaStsStatus(ctx);
		expect(before).toEqual({
			state: "failed",
			detail: "example.com already has an MTA-STS policy. Delete the TXT record at _mta-sts.example.com in Cloudflare, then check again.",
		});
		expect(await publishMtaSts(ctx, {}, before)).toBe(before);
		expect(writes).toEqual([]);

		expect(await publishMtaSts(ctx, { moveMail: true }, before)).toEqual({ state: "done" });
		expect(writes[0]).toBe("delete _mta-sts.example.com");
		expect(await mtaStsStatus(ctx)).toEqual({ state: "done" });
	});

	it("moves a policy that's proxied or served by another Worker, and keeps records beside it", async () => {
		const verification = { id: "v", type: "TXT", name: "mta-sts.example.com", content: '"site-verification=abc"', proxied: false };
		const proxiedId = { id: "p", type: "CNAME", name: "_mta-sts.example.com", content: "_mta-sts.mx.cloudflare.net", proxied: true };
		const writes = fakeZone([verification, proxiedId], [{ id: "old-route", pattern: "mta-sts.example.com/.well-known/mta-sts.txt", script: "mta-sts-proxy" }]);
		expect(await mtaStsStatus(ctx)).toMatchObject({
			state: "failed",
			detail: expect.stringContaining("Delete the CNAME record at _mta-sts.example.com and the Workers route mta-sts.example.com/.well-known/mta-sts.txt"),
		});
		expect(await publishMtaSts(ctx, { moveMail: true }, { state: "failed" })).toEqual({ state: "done" });
		expect(writes).toEqual([
			"delete _mta-sts.example.com",
			"delete mta-sts.example.com/.well-known/mta-sts.txt",
			"add AAAA mta-sts.example.com",
			"route mta-sts.example.com/.well-known/mta-sts.txt → magnus",
			"add CNAME _mta-sts.example.com",
		]);
		expect(await mtaStsStatus(ctx)).toEqual({ state: "done" });
	});
});
