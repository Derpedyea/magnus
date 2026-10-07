import { describe, expect, it } from "vitest";
import { fromBase64Url, toBase64Url } from "#shared";
import { encryptPayload, keyPair, rawKey, vapidAuthorization } from "./push";

// RFC 8291 §5 and Appendix A.
const RFC = {
	plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
	senderPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body:
		"DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
		"mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
		"pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

describe("encryptPayload", () => {
	it("encrypts the RFC 8291 example to the RFC's bytes", async () => {
		const ecdh = { name: "ECDH", namedCurve: "P-256" };
		const point = fromBase64Url(RFC.senderPublic);
		const jwk = { kty: "EC", crv: "P-256", x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33)), d: RFC.senderPrivate };
		const sender = {
			privateKey: await crypto.subtle.importKey("jwk", jwk, ecdh, true, ["deriveBits"]),
			publicKey: await crypto.subtle.importKey("raw", point, ecdh, true, []),
		};
		const body = await encryptPayload({ p256dh: RFC.receiverPublic, auth: RFC.auth }, fromBase64Url(RFC.plaintext), sender, fromBase64Url(RFC.salt));
		expect(toBase64Url(body)).toBe(RFC.body);
	});
});

describe("vapidAuthorization", () => {
	it("signs a token for the push service's origin that the public key it sends verifies", async () => {
		const algorithm = { name: "ECDSA", namedCurve: "P-256" };
		const pair = await keyPair(algorithm, ["sign", "verify"]);
		const publicKey = toBase64Url(await rawKey(pair.publicKey));
		const now = Date.UTC(2030, 0, 1);
		const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", "https://mail.example.com", { publicKey, privateKey: pair.privateKey }, now);

		const [, token = "", k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
		expect(k).toBe(publicKey);
		const [head = "", claims = "", signature = ""] = token.split(".");
		const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
		expect(decode(head)).toEqual({ typ: "JWT", alg: "ES256" });
		expect(decode(claims)).toEqual({ aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://mail.example.com" });
		const key = await crypto.subtle.importKey("raw", fromBase64Url(k ?? ""), algorithm, false, ["verify"]);
		const signed = new TextEncoder().encode(`${head}.${claims}`);
		expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(signature), signed)).toBe(true);
	});
});
