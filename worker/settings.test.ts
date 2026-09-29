import { describe, expect, it } from "vitest";
import { seal, unseal } from "./settings";

describe("seal", () => {
	it("round-trips through the stored form, and only opens with its own key", async () => {
		const { key, sealed } = await seal("cf-token-ÿ✓");
		expect(sealed.data).not.toContain("cf-token");
		await expect(unseal(key, sealed)).resolves.toBe("cf-token-ÿ✓");
		const other = await seal("cf-token-ÿ✓");
		await expect(unseal(other.key, sealed)).rejects.toThrow();
	});
});
