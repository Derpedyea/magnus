const PREFIX = "magnus:drafts:";

export const draftJournalKey = (userId: string) => `${PREFIX}${userId}`;

export function clearDraftJournals() {
	const keys: string[] = [];
	for (let index = 0; index < localStorage.length; index++) {
		const key = localStorage.key(index);
		if (key?.startsWith(PREFIX)) keys.push(key);
	}
	for (const key of keys) localStorage.removeItem(key);
}
