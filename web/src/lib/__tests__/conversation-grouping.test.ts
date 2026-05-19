import { test, expect, describe } from "bun:test";
import { groupConversations, unreadForkCount } from "../conversation-grouping";
import type { Conversation } from "../api.js";

const NOW = new Date("2026-04-28T12:00:00Z").getTime();

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
	return {
		id: partial.id,
		projectId: "p1",
		title: partial.title ?? partial.id,
		model: null,
		provider: null,
		systemPrompt: null,
		agentConfigId: null,
		modeId: null,
		test: null,
		parentConversationId: partial.parentConversationId ?? null,
		parentMessageId: partial.parentMessageId ?? null,
		forkedFromConversationId: partial.forkedFromConversationId ?? null,
		forkedFromMessageId: partial.forkedFromMessageId ?? null,
		createdAt: partial.createdAt ?? new Date(NOW - 1000).toISOString(),
		updatedAt: partial.updatedAt ?? new Date(NOW - 1000).toISOString(),
	};
}

const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("groupConversations", () => {
	test("returns no groups for empty input", () => {
		expect(groupConversations([], { now: NOW })).toEqual([]);
	});

	test("places lone root in correct recency bucket", () => {
		const groups = groupConversations(
			[conv({ id: "a", updatedAt: hoursAgo(2) })],
			{ now: NOW },
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.label).toBe("Today");
		expect(groups[0]!.families).toHaveLength(1);
		expect(groups[0]!.families[0]!.root.id).toBe("a");
		expect(groups[0]!.families[0]!.forks).toHaveLength(0);
	});

	test("nests a fork under its parent and removes it from top level", () => {
		const groups = groupConversations(
			[
				conv({ id: "parent", updatedAt: hoursAgo(5) }),
				conv({ id: "fork-a", forkedFromConversationId: "parent", updatedAt: hoursAgo(1), createdAt: hoursAgo(1) }),
			],
			{ now: NOW },
		);
		// One bucket, one family — fork is NOT a top-level entry.
		expect(groups).toHaveLength(1);
		expect(groups[0]!.families).toHaveLength(1);
		const fam = groups[0]!.families[0]!;
		expect(fam.root.id).toBe("parent");
		expect(fam.forks.map((f) => f.id)).toEqual(["fork-a"]);
	});

	test("flattens forks-of-forks under the ultimate root", () => {
		const groups = groupConversations(
			[
				conv({ id: "root", updatedAt: daysAgo(10) }),
				conv({ id: "f1", forkedFromConversationId: "root", createdAt: daysAgo(8), updatedAt: daysAgo(8) }),
				conv({ id: "f2", forkedFromConversationId: "f1", createdAt: daysAgo(2), updatedAt: daysAgo(2) }),
			],
			{ now: NOW },
		);
		const allFams = groups.flatMap((g) => g.families);
		expect(allFams).toHaveLength(1);
		const fam = allFams[0]!;
		expect(fam.root.id).toBe("root");
		// Both f1 and f2 listed under root, sorted by createdAt ASC.
		expect(fam.forks.map((f) => f.id)).toEqual(["f1", "f2"]);
	});

	test("family bucket is driven by family-max updatedAt (a fresh fork bumps a stale parent into Today)", () => {
		const groups = groupConversations(
			[
				conv({ id: "old-parent", updatedAt: daysAgo(60) }), // would be "Older"
				conv({ id: "fresh-fork", forkedFromConversationId: "old-parent", updatedAt: hoursAgo(1), createdAt: daysAgo(1) }),
			],
			{ now: NOW },
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.label).toBe("Today");
		expect(groups[0]!.families[0]!.root.id).toBe("old-parent");
	});

	test("forks within a family are sorted by createdAt ASC", () => {
		const groups = groupConversations(
			[
				conv({ id: "p", updatedAt: hoursAgo(10) }),
				conv({ id: "later", forkedFromConversationId: "p", createdAt: hoursAgo(2), updatedAt: hoursAgo(2) }),
				conv({ id: "earlier", forkedFromConversationId: "p", createdAt: hoursAgo(8), updatedAt: hoursAgo(8) }),
			],
			{ now: NOW },
		);
		expect(groups[0]!.families[0]!.forks.map((f) => f.id)).toEqual(["earlier", "later"]);
	});

	test("orphaned fork (parent missing from loaded set) renders as its own root with rootIsOrphanedFork=true", () => {
		const groups = groupConversations(
			[
				conv({ id: "loose-fork", forkedFromConversationId: "missing-parent", updatedAt: hoursAgo(3) }),
			],
			{ now: NOW },
		);
		expect(groups).toHaveLength(1);
		const fam = groups[0]!.families[0]!;
		expect(fam.root.id).toBe("loose-fork");
		expect(fam.forks).toHaveLength(0);
		expect(fam.rootIsOrphanedFork).toBe(true);
	});

	test("families within a bucket are sorted by familyUpdatedAt DESC", () => {
		const groups = groupConversations(
			[
				conv({ id: "a", updatedAt: hoursAgo(10) }),
				conv({ id: "b", updatedAt: hoursAgo(2) }),
				conv({ id: "c", updatedAt: hoursAgo(6) }),
			],
			{ now: NOW },
		);
		expect(groups[0]!.label).toBe("Today");
		expect(groups[0]!.families.map((f) => f.root.id)).toEqual(["b", "c", "a"]);
	});

	test("buckets split correctly across day/week/month/older boundaries", () => {
		const groups = groupConversations(
			[
				conv({ id: "today", updatedAt: hoursAgo(2) }),
				conv({ id: "week", updatedAt: daysAgo(3) }),
				conv({ id: "month", updatedAt: daysAgo(15) }),
				conv({ id: "older", updatedAt: daysAgo(60) }),
			],
			{ now: NOW },
		);
		expect(groups.map((g) => g.label)).toEqual([
			"Today",
			"Previous 7 Days",
			"Previous 30 Days",
			"Older",
		]);
		expect(groups[0]!.families[0]!.root.id).toBe("today");
		expect(groups[1]!.families[0]!.root.id).toBe("week");
		expect(groups[2]!.families[0]!.root.id).toBe("month");
		expect(groups[3]!.families[0]!.root.id).toBe("older");
	});

	test("cycle in fork chain does not infinite-loop (defensive)", () => {
		// Synthetic: A says it forked from B, B says it forked from A.
		const a = conv({ id: "a", forkedFromConversationId: "b", updatedAt: hoursAgo(1) });
		const b = conv({ id: "b", forkedFromConversationId: "a", updatedAt: hoursAgo(2) });
		const groups = groupConversations([a, b], { now: NOW });
		// Should not throw / hang; produces some grouping (exact shape doesn't matter — defensive coverage).
		expect(groups.length).toBeGreaterThan(0);
	});
});

describe("unreadForkCount", () => {
	test("counts forks where the predicate returns true", () => {
		const fam = {
			root: conv({ id: "p" }),
			forks: [conv({ id: "f1" }), conv({ id: "f2" }), conv({ id: "f3" })],
			familyUpdatedAt: NOW,
			rootIsOrphanedFork: false,
		};
		const unread = new Set(["f1", "f3", "p"]); // p is on root, doesn't count
		expect(unreadForkCount(fam, (id) => unread.has(id))).toBe(2);
	});

	test("returns 0 when no forks are unread", () => {
		const fam = {
			root: conv({ id: "p" }),
			forks: [conv({ id: "f1" })],
			familyUpdatedAt: NOW,
			rootIsOrphanedFork: false,
		};
		expect(unreadForkCount(fam, () => false)).toBe(0);
	});
});
