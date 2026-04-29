/**
 * Pure grouping helpers for the sidebar conversation list.
 *
 * Two responsibilities:
 *   1. Group forks under their ultimate root (forks-of-forks flatten upward)
 *      so the sidebar can render a one-level collapsible tree.
 *   2. Bucket families by recency using the family's most-recent updatedAt
 *      (so a stale parent with a fresh fork still appears in "Today").
 *
 * Kept free of Svelte runes / stores so it can be unit-tested in isolation.
 */

import type { Conversation } from "./api.js";

export type ConversationFamily = {
	root: Conversation;
	/** Forks attributed to this root, sorted by createdAt ASC (read top-down). */
	forks: Conversation[];
	/** Max(updatedAt) across root + all forks, ms epoch. Drives bucketing. */
	familyUpdatedAt: number;
	/**
	 * True when the root itself has no parent in the loaded set but is a fork
	 * of something we couldn't resolve (parent paginated off, or deleted with
	 * SET NULL). UI may show a "↳ forked from …" caption.
	 */
	rootIsOrphanedFork: boolean;
};

export type ConversationGroup = {
	label: string;
	families: ConversationFamily[];
};

const DAY_MS = 86_400_000;

/** Climb forkedFromConversationId until we hit a conv with no loaded parent. */
function ultimateRoot(start: Conversation, byId: Map<string, Conversation>): Conversation {
	let cur = start;
	const visited = new Set<string>();
	while (cur.forkedFromConversationId) {
		if (visited.has(cur.id)) break; // defensive: cycle guard
		visited.add(cur.id);
		const parent = byId.get(cur.forkedFromConversationId);
		if (!parent) break; // orphan — treat current as root
		cur = parent;
	}
	return cur;
}

export function groupConversations(
	conversations: Conversation[],
	opts: { now: number },
): ConversationGroup[] {
	const byId = new Map<string, Conversation>();
	for (const c of conversations) byId.set(c.id, c);

	// Build families keyed by ultimate-root id.
	const families = new Map<string, ConversationFamily>();
	for (const conv of conversations) {
		const root = ultimateRoot(conv, byId);
		let fam = families.get(root.id);
		if (!fam) {
			fam = {
				root,
				forks: [],
				familyUpdatedAt: 0,
				rootIsOrphanedFork: !!root.forkedFromConversationId,
			};
			families.set(root.id, fam);
		}
		if (conv.id !== root.id) fam.forks.push(conv);
	}

	// Finalize each family: sort forks, compute familyUpdatedAt.
	for (const fam of families.values()) {
		fam.forks.sort(
			(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
		const allTimes = [fam.root, ...fam.forks].map((c) => new Date(c.updatedAt).getTime());
		fam.familyUpdatedAt = Math.max(...allTimes);
	}

	// Bucket by familyUpdatedAt and sort within bucket DESC.
	const today: ConversationFamily[] = [];
	const week: ConversationFamily[] = [];
	const month: ConversationFamily[] = [];
	const older: ConversationFamily[] = [];

	for (const fam of families.values()) {
		const age = opts.now - fam.familyUpdatedAt;
		if (age < DAY_MS) today.push(fam);
		else if (age < 7 * DAY_MS) week.push(fam);
		else if (age < 30 * DAY_MS) month.push(fam);
		else older.push(fam);
	}

	const byUpdatedDesc = (a: ConversationFamily, b: ConversationFamily) =>
		b.familyUpdatedAt - a.familyUpdatedAt;
	today.sort(byUpdatedDesc);
	week.sort(byUpdatedDesc);
	month.sort(byUpdatedDesc);
	older.sort(byUpdatedDesc);

	const groups: ConversationGroup[] = [];
	if (today.length) groups.push({ label: "Today", families: today });
	if (week.length) groups.push({ label: "Previous 7 Days", families: week });
	if (month.length) groups.push({ label: "Previous 30 Days", families: month });
	if (older.length) groups.push({ label: "Older", families: older });
	return groups;
}

/** Count forks (loaded into this family) marked unread by the given predicate. */
export function unreadForkCount(
	family: ConversationFamily,
	isUnread: (id: string) => boolean,
): number {
	let n = 0;
	for (const f of family.forks) if (isUnread(f.id)) n++;
	return n;
}
