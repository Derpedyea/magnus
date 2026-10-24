import { type Address, isValidAddress, stripSubaddress } from "./address";
import type { IngestInput, RuleCondition, RuleInput, RuleTextOp } from "./types";

/**
 * What a rule's conditions read of a message: new mail as the queue hands it over, or mail already here as the mailbox
 * keeps it (Mailbox.previewRule()).
 */
export type RuleFacts = Pick<IngestInput, "from" | "to" | "cc" | "envelopeTo" | "subject" | "text" | "headers"> & {
	attachments: { inline: boolean }[];
	sender: { verified: string | null };
};

/**
 * Whether a message meets a rule's conditions, its AI condition aside: every one, or with `match: "any"`, one. A rule
 * with none, only an AI condition, always does. Text is compared whatever its case, and an address field by its
 * address, its name, or both as `Name <address>`.
 */
export function matchConditions(rule: Pick<RuleInput, "match" | "conditions">, facts: RuleFacts): boolean {
	if (rule.conditions.length === 0) return true;
	const met = (c: RuleCondition) => meets(c, facts) !== (c.not === true);
	return rule.match === "all" ? rule.conditions.every(met) : rule.conditions.some(met);
}

function meets(c: RuleCondition, facts: RuleFacts): boolean {
	const headers = (name: string) => facts.headers.filter((h) => h.name === name).map((h) => h.value);
	switch (c.field) {
		case "has-attachment":
			return facts.attachments.some((a) => !a.inline);
		case "verified-sender":
			return facts.sender.verified !== null;
		case "mailing-list":
			return facts.headers.some((h) => h.name === "list-id" || h.name === "list-unsubscribe");
		case "header": {
			const values = headers(c.name.toLowerCase());
			return c.op === "exists" ? values.length > 0 : compare(values, c.op, c.value ?? "");
		}
		case "from":
			return compare(addressTexts([facts.from]), c.op, c.value);
		case "to":
			return compare(addressTexts(facts.to), c.op, c.value);
		case "cc":
			return compare(addressTexts(facts.cc), c.op, c.value);
		case "recipient": {
			// The address it came to, as written and without its +tag: a rule for me@ catches me+shop@ too. Imported mail can
			// name no address at all.
			const delivered = isValidAddress(facts.envelopeTo) ? [facts.envelopeTo, stripSubaddress(facts.envelopeTo).base] : [];
			return compare([...addressTexts([...facts.to, ...facts.cc]), ...delivered], c.op, c.value);
		}
		case "subject":
			return compare([facts.subject], c.op, c.value);
		case "body":
			return compare([facts.text ?? ""], c.op, c.value);
		case "list-id":
			return compare(headers("list-id"), c.op, c.value);
	}
}

function addressTexts(addresses: Address[]): string[] {
	return addresses.flatMap((a) => (a.name ? [a.address, a.name, `${a.name} <${a.address}>`] : [a.address]));
}

function compare(texts: string[], op: RuleTextOp, value: string): boolean {
	const wanted = value.trim().toLowerCase();
	return texts.some((text) => {
		const t = text.toLowerCase();
		switch (op) {
			case "contains":
				return t.includes(wanted);
			case "is":
				return t.trim() === wanted;
			case "starts-with":
				return t.startsWith(wanted);
			case "ends-with":
				return t.endsWith(wanted);
		}
	});
}
