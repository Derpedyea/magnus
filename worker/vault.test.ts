import { describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, importKey } from "./vault";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const newKey = () => importKey(crypto.getRandomValues(new Uint8Array(32)));

describe("encrypt", () => {
	it("round-trips through the stored form, and only opens with its own key", async () => {
		const key = await newKey();
		const sealed = await encrypt(key, "cf-token-ÿ✓");
		expect(sealed.data).not.toContain("cf-token");
		await expect(decrypt(key, sealed)).resolves.toBe("cf-token-ÿ✓");
		await expect(decrypt(await newKey(), sealed)).rejects.toThrow();
	});
});
