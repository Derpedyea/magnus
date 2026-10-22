/**
 * Splitting an mbox file into its messages without reading it whole: a Takeout of All mail runs to tens of GB. Each
 * message starts after a `From ` line and ends at the blank line before the next (RFC 4155). Only where each one is
 * and its headers are kept; its bytes are read again when it's sent (mboxBody()).
 */

export interface MboxMessage {
	/** Byte offsets in the file, from just after the message's `From ` line to the blank line before the next one. */
	start: number;
	end: number;
	/** The header block, without the blank line that ends it. */
	headers: string;
	/** Lines starting `From ` in it were written as `>From `, so its bytes aren't the message's until unescaped. */
	escaped: boolean;
}

/**
 * A message's `From ` line: the sender, then the date as asctime() writes it (`From - Mon Jan  1 00:00:00 2024`),
 * perhaps with a zone before the year (Takeout's `From 1848707889910060830@xxx Thu Nov 13 20:20:33 +0000 2025`).
 * Checking the whole date, like mutt's is_from(), keeps a body line a program forgot to escape from splitting its
 * message in two.
 */
const FROM_LINE =
	/^From \S*\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s+(?:(?:[+-]\d{4}|[A-Z]{1,5})\s+)?\d{4}\b/;
/** Enough of a line to tell a `From ` line by: the sender can be a long bounce address. */
const HEAD_BYTES = 512;
/** The Worker refuses a message whose headers run longer (worker/mail/import.ts), so there's no need to keep more. */
const MAX_HEADER_BYTES = 256 * 1024;

const LF = 0x0a;
const F = 0x46;
const CR = 0x0d;
const GT = 0x3e;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();

/** Whether a file is an mbox: one that starts with a `From ` line. Thunderbird's have no extension to go by. */
export async function isMbox(file: Blob): Promise<boolean> {
	return FROM_LINE.test(latin1.decode(await file.slice(0, HEAD_BYTES).arrayBuffer()));
}

/**
 * Every message in an mbox file, in order. `onBytes` hears how much more of the file has been read; `signal` stops
 * reading it, throwing its reason.
 */
export async function* splitMbox(file: Blob, onBytes?: (bytes: number) => void, signal?: AbortSignal): AsyncGenerator<MboxMessage> {
	signal?.throwIfAborted();
	const reader = file.stream().getReader();
	/** Offset of the line being read, and its first bytes. */
	let lineStart = 0;
	const head = new Uint8Array(HEAD_BYTES);
	let headLength = 0;
	/** Where the line before began, when it was blank: the separator before a `From ` line isn't the message's. */
	let blankBefore: number | null = null;
	let message: { start: number; header: Uint8Array[]; headerBytes: number; inHeaders: boolean; escaped: boolean } | null = null;
	const done: MboxMessage[] = [];

	const finish = (end: number) => {
		if (!message) return;
		const stop = blankBefore ?? end;
		if (stop > message.start) done.push({ start: message.start, end: stop, headers: headerText(message.header), escaped: message.escaped });
		message = null;
	};

	const endLine = (lineEnd: number) => {
		const length = lineEnd - lineStart;
		const blank = (length === 1 && head[0] === LF) || (length === 2 && head[0] === CR && head[1] === LF);
		if (isFrom(head, 0, headLength) && FROM_LINE.test(latin1.decode(head.subarray(0, headLength)))) {
			finish(lineStart);
			message = { start: lineEnd, header: [], headerBytes: 0, inHeaders: true, escaped: false };
			blankBefore = null;
		} else {
			if (message && blank) message.inHeaders = false;
			if (message && head[0] === GT && escapedFrom(head, headLength)) message.escaped = true;
			blankBefore = blank ? lineStart : null;
		}
		lineStart = lineEnd;
		headLength = 0;
	};

	/**
	 * Bytes `from`–`to` of `chunk`, part of the line being read, which may go on into the next chunk. Most lines need
	 * only enough to tell whether they're blank; ones starting `F` or `>` may be `From ` lines or escaped ones.
	 */
	const take = (chunk: Uint8Array, from: number, to: number) => {
		const first = headLength ? head[0] : chunk[from];
		const want = first === F || first === GT ? HEAD_BYTES : 2;
		for (let i = from; i < to && headLength < want; i++) head[headLength++] = chunk[i]!;
		if (message?.inHeaders && message.headerBytes < MAX_HEADER_BYTES) {
			message.header.push(chunk.slice(from, to));
			message.headerBytes += to - from;
		}
	};

	let offset = 0;
	for (;;) {
		const { value, done: eof } = await reader.read();
		if (eof) break;
		if (signal?.aborted) {
			await reader.cancel();
			signal.throwIfAborted();
		}
		let at = 0;
		while (at < value.length) {
			const newline = value.indexOf(LF, at);
			const stop = newline === -1 ? value.length : newline + 1;
			take(value, at, stop);
			if (newline !== -1) endLine(offset + stop);
			at = stop;
		}
		offset += value.length;
		onBytes?.(value.length);
		yield* done.splice(0);
	}
	if (offset > lineStart) endLine(offset);
	finish(offset);
	yield* done;
}

/** The header lines kept, up to the blank line that ends them. */
function headerText(parts: Uint8Array[]): string {
	const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return utf8.decode(bytes).replace(/\r?\n\r?\n[^]*$/, "").replace(/\r?\n$/, "");
}

const FROM = [F, 0x72, 0x6f, 0x6d, 0x20];

/** Whether `bytes` from `at` read `From `. */
function isFrom(bytes: Uint8Array, at: number, length = bytes.length): boolean {
	if (at + FROM.length > length) return false;
	return FROM.every((b, i) => bytes[at + i] === b);
}

/** A line mboxrd escaped: `>From `, `>>From `, and so on. */
function escapedFrom(line: Uint8Array, length: number): boolean {
	let at = 0;
	while (at < length && line[at] === GT) at++;
	return at > 0 && isFrom(line, at, length);
}

/**
 * One message's bytes as it was before it went into the file: each `>From ` line loses one `>` (mboxrd). Programs
 * that only escape `From ` lines (mboxo, Thunderbird's) can't tell an escaped line from one that began `>From `, so
 * those lose theirs too, as they would read back in any of them.
 */
export async function mboxBody(file: Blob, message: Pick<MboxMessage, "start" | "end" | "escaped">): Promise<Blob> {
	const slice = file.slice(message.start, message.end);
	if (!message.escaped) return slice;
	const bytes = new Uint8Array(await slice.arrayBuffer());
	const out = new Uint8Array(bytes.length);
	let length = 0;
	for (let at = 0; at < bytes.length; ) {
		const newline = bytes.indexOf(LF, at);
		const stop = newline === -1 ? bytes.length : newline + 1;
		const from = bytes[at] === GT && escapedFrom(bytes.subarray(at, stop), stop - at) ? at + 1 : at;
		out.set(bytes.subarray(from, stop), length);
		length += stop - from;
		at = stop;
	}
	return new Blob([out.subarray(0, length)]);
}
