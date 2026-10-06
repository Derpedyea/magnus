/** Base64url without padding (RFC 4648 §5), as Web Push writes keys and VAPID writes tokens. */
export function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Padding is optional. Throws on text that isn't base64. */
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
	return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
