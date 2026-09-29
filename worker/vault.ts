import { DurableObject } from "cloudflare:workers";

/**
 * Encrypts the saved Cloudflare token (settings.ts keeps the ciphertext in D1) and holds the key, which never leaves
 * this object. Reading a Durable Object's storage from outside takes edit access to this Worker, which could deploy
 * code to read any secret anyway; D1 and R2 can be read with much narrower tokens. One instance, named "vault".
 *
 * The key is stored as raw bytes, since workerd can't persist a CryptoKey, and imported non-extractable for each use.
 */
export class Vault extends DurableObject<Env> {
	async seal(plaintext: string): Promise<Sealed> {
		return encrypt(await importKey(this.#rawKey(true)), plaintext);
	}

	/** Null when there's no key (see forget), or the text wasn't sealed with this one. */
	async unseal(sealed: Sealed): Promise<string | null> {
		const raw = this.#rawKey(false);
		return raw ? decrypt(await importKey(raw), sealed).catch(() => null) : null;
	}

	/** Anything sealed so far can't be opened again, apart from through Durable Objects' 30-day point-in-time recovery. */
	forget(): void {
		this.ctx.storage.kv.delete(KEY);
	}

	// Synchronous storage, so two seals at once can't each create a key.
	#rawKey(create: true): Uint8Array<ArrayBuffer>;
	#rawKey(create: boolean): Uint8Array<ArrayBuffer> | null;
	#rawKey(create: boolean): Uint8Array<ArrayBuffer> | null {
		const stored: unknown = this.ctx.storage.kv.get(KEY);
		if (stored instanceof Uint8Array) return new Uint8Array(stored);
		if (!create) return null;
		const fresh = crypto.getRandomValues(new Uint8Array(32));
		this.ctx.storage.kv.put(KEY, fresh);
		return fresh;
	}
}

const KEY = "key";

/** AES-256-GCM output, base64, as stored in D1. */
export interface Sealed {
	iv: string;
	data: string;
}

export const importKey = (raw: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

export async function encrypt(key: CryptoKey, plaintext: string): Promise<Sealed> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
	return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

export async function decrypt(key: CryptoKey, sealed: Sealed): Promise<string> {
	const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, key, fromBase64(sealed.data));
	return new TextDecoder().decode(data);
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
