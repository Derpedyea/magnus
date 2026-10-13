/** "1 message", "2,481 messages". */
export function plural(n: number, noun: string): string {
	return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

/** "a, b, and c". */
export const LIST = new Intl.ListFormat("en", { type: "conjunction" });
