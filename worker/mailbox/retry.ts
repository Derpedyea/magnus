import { type Address, normalizeAddress } from "#shared";

interface Addressing {
	to: Address[];
	cc: Address[];
	bcc: Address[];
}

/**
 * Who a retry goes to. A message that never left (`refused` null) goes to everyone again; one that did goes only
 * to the recipients whose servers refused it, so nobody who got it gets it twice. Each keeps the field it was in,
 * except that a copy with nobody left in To addresses its Cc'd recipients there: they're the only people it
 * names. Bcc'd recipients stay hidden from each other.
 */
export function retryAddressing(sent: Addressing, refused: ReadonlySet<string> | null): Addressing & { recipients: Set<string> } {
	const recipients = new Set(
		[...sent.to, ...sent.cc, ...sent.bcc].map((a) => normalizeAddress(a.address)).filter((a) => !refused || refused.has(a)),
	);
	const again = (list: Address[]) => list.filter((a) => recipients.has(normalizeAddress(a.address)));
	const to = again(sent.to);
	const cc = again(sent.cc);
	return { to: to.length ? to : cc, cc: to.length ? cc : [], bcc: again(sent.bcc), recipients };
}
