import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cloudflare } from "./cloudflare";

vi.mock("cloudflare:workers", () => ({ env: {} }));

afterEach(() => vi.unstubAllGlobals());

describe("cloudflare", () => {
	it("accepts a success whose errors are null, as the Queues API sends", async () => {
		const body = { success: true, errors: null, messages: [], result: [{ queue_id: "q1" }] };
		vi.stubGlobal("fetch", async () => Response.json(body));
		await expect(cloudflare("token").get(z.array(z.object({ queue_id: z.string() })), "queues", "/accounts/a/queues")).resolves.toEqual([
			{ queue_id: "q1" },
		]);
	});
});
