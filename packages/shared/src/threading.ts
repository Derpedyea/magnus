const SUBJECT_PREFIX_RE = /^\s*((re|fw|fwd|aw|sv|wg|antw|tr)(\[\d+\])?\s*:\s*)+/i;

/** "Re: FWD: re[2]:  Hello  world" → "hello world". Used as the threading fallback key. */
export function normalizeSubject(subject: string | null | undefined): string {
	return (subject ?? "").replace(SUBJECT_PREFIX_RE, "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

/** Extract `<id@host>` tokens from Message-ID / In-Reply-To / References header values. */
export function parseMessageIds(header: string | null | undefined): string[] {
	if (!header) return [];
	const ids = header.match(/<[^<>\s]+>/g);
	if (ids) return ids;
	// Some senders omit the angle brackets on a single id.
	const bare = header.trim();
	return bare && !/\s/.test(bare) ? [`<${bare}>`] : [];
}

export function ensureAngleBrackets(id: string): string {
	const trimmed = id.trim();
	return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

/** Cloudflare Email Service rejects any single header value over 2,048 bytes. */
export const MAX_HEADER_VALUE_BYTES = 2048;

/**
 * Build a References header for a reply: parent's references + parent id.
 * When it would exceed the header limit, keep the thread root and the most recent ids
 * (RFC 5322 §3.6.4 allows trimming the middle).
 */
export function buildReferences(parentReferences: string[], parentMessageId: string | null): string[] {
	const refs = [...parentReferences];
	if (parentMessageId && !refs.includes(parentMessageId)) refs.push(parentMessageId);
	if (refs.length === 0) return refs;

	const byteLength = (ids: string[]) => new TextEncoder().encode(ids.join(" ")).length;
	if (byteLength(refs) <= MAX_HEADER_VALUE_BYTES) return refs;

	const [root, ...rest] = refs as [string, ...string[]];
	const tail: string[] = [];
	for (let i = rest.length - 1; i >= 0; i--) {
		const candidate = [root, rest[i]!, ...tail];
		if (byteLength(candidate) > MAX_HEADER_VALUE_BYTES) break;
		tail.unshift(rest[i]!);
	}
	return [root, ...tail];
}

/** Plain-text preview: drop quoted replies and collapse whitespace. */
export function makeSnippet(text: string | null | undefined, max = 200): string {
	if (!text) return "";
	const unquoted = text
		.split(/\r?\n/)
		.filter((line) => !line.startsWith(">"))
		.join(" ");
	const collapsed = unquoted.replaceAll(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
