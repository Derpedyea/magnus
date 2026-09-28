import { describe, expect, it } from "vitest";
import { mailHost } from "./cloudflare";

describe("mailHost", () => {
	it("sees a domain with no MX records as free", () => {
		expect(mailHost([])).toEqual({ kind: "none" });
	});
	it("recognises Email Routing, trailing dot and all", () => {
		expect(mailHost(["route1.mx.cloudflare.net.", "route2.mx.cloudflare.net"])).toEqual({ kind: "cloudflare" });
	});
	it("names known providers, even alongside Cloudflare's records", () => {
		expect(mailHost(["route1.mx.cloudflare.net", "mail.protonmail.ch"])).toEqual({ kind: "other", provider: "Proton" });
		expect(mailHost(["ASPMX.L.GOOGLE.COM"])).toEqual({ kind: "other", provider: "Google" });
	});
	it("names unknown providers by their domain", () => {
		expect(mailHost(["mx1.mail.example-host.com"])).toEqual({ kind: "other", provider: "example-host.com" });
	});
});
