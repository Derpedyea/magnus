import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDraftSync } from "./drafts";
import { endSession, onSessionEnd } from "./session";

vi.mock("./api", () => ({
	api: {},
	errorMessage: (error: unknown) => String(error),
	ApiError: class ApiError extends Error {},
}));
vi.mock("./agent", () => ({ newChat: vi.fn() }));
vi.mock("./compose", () => ({ compose: { state: null }, closeDraft: vi.fn() }));
vi.mock("./push", () => ({ forgetDevice: vi.fn(async () => {}) }));
vi.mock("./queries", () => ({ configQuery: { queryKey: ["config"] } }));
vi.mock("@/components/ui/toast-manager", () => ({ toast: { close: vi.fn() } }));

function storage() {
	const data = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		get length() { return data.size; },
		key: (index: number) => [...data.keys()][index] ?? null,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	});
	return data;
}

describe("draft journal session cleanup", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("clears recovery journals when the session ends", async () => {
		const data = storage();
		const context = createDraftSync("alice", () => {});
		context.sync.update("00000000-0000-4000-8000-000000000001", { mailboxId: "mbx", from: "alice@example.com", to: [], cc: [], bcc: [], subject: "Saturday", text: "Secret draft", attachments: [] });
		data.set("magnus:drafts:bob", "other draft");
		const unsubscribe = onSessionEnd(context.endSession);
		const qc = { removeQueries: vi.fn(), getMutationCache: () => ({ clear: vi.fn() }) } as unknown as QueryClient;
		expect(data.get("magnus:drafts:alice")).toContain("Secret draft");

		await endSession(qc);

		expect(data.has("magnus:drafts:alice")).toBe(false);
		expect(data.has("magnus:drafts:bob")).toBe(false);
		// A send failing after sign-out puts its draft back into the stopped sync: nothing reaches storage.
		context.sync.update("00000000-0000-4000-8000-000000000001", { mailboxId: "mbx", from: "alice@example.com", to: [], cc: [], bcc: [], subject: "Saturday", text: "Secret draft, unquoted", attachments: [] });
		expect(data.has("magnus:drafts:alice")).toBe(false);
		unsubscribe();
	});
});
