import { afterEach, describe, expect, it, vi } from "vitest";
import { postOneClick, unsubscribePlan } from "./unsubscribe";

vi.mock("cloudflare:workers", () => ({ env: {} }));

afterEach(() => vi.unstubAllGlobals());

const LIST = "<mailto:leave+t0k3n@news.test?subject=unsubscribe>, <https://news.test/u/opaque>";
const SIGNATURE = "v=1; a=rsa-sha256; d=news.test; s=s1; h=From:To:Subject:List-Unsubscribe:\tList-Unsubscribe-Post; bh=x; b=AbCd EfGh==";

/** Headers as PostalMime gives them, with Email Routing's stamp on top. */
function headers(options: { stamped?: string | null; signature?: string; list?: string[]; post?: string[] } = {}) {
	const { stamped = "dkim=pass header.d=news.test header.b=AbCdEfGh; dmarc=pass header.from=news.test", signature = SIGNATURE, list = [LIST], post = ["List-Unsubscribe=One-Click"] } = options;
	return [
		...(stamped === null ? [] : [{ key: "authentication-results", value: `mx.cloudflare.net; ${stamped}` }, { key: "x-cf-spamh-score", value: "1" }]),
		{ key: "dkim-signature", value: signature },
		...list.map((value) => ({ key: "list-unsubscribe", value })),
		...post.map((value) => ({ key: "list-unsubscribe-post", value })),
	];
}

describe("unsubscribePlan", () => {
	it("offers one-click only when a passing DKIM signature covers both headers", () => {
		const mail = { to: ["leave+t0k3n@news.test"], subject: "unsubscribe", body: "Unsubscribe" };
		expect(unsubscribePlan(headers())).toEqual({ oneClick: "https://news.test/u/opaque", mail, page: "https://news.test/u/opaque" });
		const without = (options: Parameters<typeof headers>[0]) => unsubscribePlan(headers(options))?.oneClick;
		expect(without({ signature: SIGNATURE.replace(":\tList-Unsubscribe-Post", "") })).toBeNull();
		expect(without({ stamped: "dkim=fail header.d=news.test; dmarc=fail" })).toBeNull();
		// A signature the stamp didn't pass, beside one it did.
		expect(without({ stamped: "dkim=pass header.d=news.test header.b=Other123" })).toBeNull();
		expect(without({ stamped: "dkim=pass header.d=other.test" })).toBeNull();
		// Verdicts below Email Routing's own headers are the sender's to write.
		expect(without({ stamped: null })).toBeNull();
		expect(without({ list: ["<https://evil.test/u>", LIST] })).toBeNull();
		expect(without({ post: ["List-Unsubscribe=One-Click&extra=1"] })).toBeNull();
	});

	it("keeps only web pages and mail, and nothing when neither is offered", () => {
		expect(unsubscribePlan(headers({ stamped: null, list: ["<javascript:alert(1)>, <http://news.test/leave>"] }))).toEqual({ oneClick: null, mail: null, page: "http://news.test/leave" });
		expect(unsubscribePlan(headers({ list: ["<ftp://news.test/x>, <mailto:not-an-address>"] }))).toBeNull();
		expect(unsubscribePlan([])).toBeNull();
	});
});

describe("postOneClick", () => {
	it("posts RFC 8058's one key/value, with nothing to identify anyone, and doesn't follow redirects", async () => {
		const calls: [string, RequestInit][] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push([url, init]);
			return new Response(null, { status: calls.length === 1 ? 200 : 302 });
		});
		expect(await postOneClick("https://news.test/u/opaque")).toBe(true);
		expect(await postOneClick("https://news.test/u/opaque")).toBe(false);
		expect(calls[0]?.[1]).toMatchObject({
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: "List-Unsubscribe=One-Click",
			redirect: "manual",
		});
	});
});
