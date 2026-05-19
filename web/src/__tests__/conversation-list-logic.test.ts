import { test, expect, describe } from "bun:test";

// ── Pure logic extracted from ConversationList.svelte ────────────────────────
//
// The component contains two non-trivial pure functions (relativeTime and the
// grouped-by-recency derivation) plus a filtered/merged search result builder.
// All are replicated here verbatim for pinning and documentation.

// ── relativeTime ─────────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
	const diff = Date.now() - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	return `${days}d ago`;
}

describe("relativeTime", () => {
	function isoSecondsAgo(secs: number): string {
		return new Date(Date.now() - secs * 1000).toISOString();
	}

	test("returns 'just now' for timestamps less than 1 minute ago", () => {
		expect(relativeTime(isoSecondsAgo(30))).toBe("just now");
	});

	test("returns 'just now' for timestamps 59 seconds ago", () => {
		expect(relativeTime(isoSecondsAgo(59))).toBe("just now");
	});

	test("returns minutes ago for 1 minute", () => {
		expect(relativeTime(isoSecondsAgo(60))).toBe("1m ago");
	});

	test("returns minutes ago for 5 minutes", () => {
		expect(relativeTime(isoSecondsAgo(5 * 60))).toBe("5m ago");
	});

	test("returns minutes ago for 59 minutes", () => {
		expect(relativeTime(isoSecondsAgo(59 * 60))).toBe("59m ago");
	});

	test("returns hours ago for exactly 1 hour", () => {
		expect(relativeTime(isoSecondsAgo(60 * 60))).toBe("1h ago");
	});

	test("returns hours ago for 3 hours", () => {
		expect(relativeTime(isoSecondsAgo(3 * 60 * 60))).toBe("3h ago");
	});

	test("returns hours ago for 23 hours", () => {
		expect(relativeTime(isoSecondsAgo(23 * 60 * 60))).toBe("23h ago");
	});

	test("returns days ago for exactly 1 day", () => {
		expect(relativeTime(isoSecondsAgo(24 * 60 * 60))).toBe("1d ago");
	});

	test("returns days ago for 7 days", () => {
		expect(relativeTime(isoSecondsAgo(7 * 24 * 60 * 60))).toBe("7d ago");
	});

	test("returns days ago for 30 days", () => {
		expect(relativeTime(isoSecondsAgo(30 * 24 * 60 * 60))).toBe("30d ago");
	});

	test("handles a future timestamp as 'just now' (0 mins floor)", () => {
		// A timestamp 10 seconds in the future gives diff < 0; floor(-0.16) = 0 < 1
		const future = new Date(Date.now() + 10_000).toISOString();
		expect(relativeTime(future)).toBe("just now");
	});
});

// ── groupConversations ────────────────────────────────────────────────────────

interface ConvStub {
	id: string;
	title: string;
	updatedAt: string;
}

type Group = { label: string; items: ConvStub[] };

function groupConversations(conversations: ConvStub[]): Group[] {
	const now = Date.now();
	const DAY = 86_400_000;
	const today: ConvStub[] = [];
	const week: ConvStub[] = [];
	const month: ConvStub[] = [];
	const older: ConvStub[] = [];

	const sorted = [...conversations].sort(
		(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
	);

	for (const conv of sorted) {
		const age = now - new Date(conv.updatedAt).getTime();
		if (age < DAY) today.push(conv);
		else if (age < 7 * DAY) week.push(conv);
		else if (age < 30 * DAY) month.push(conv);
		else older.push(conv);
	}

	const groups: Group[] = [];
	if (today.length) groups.push({ label: "Today", items: today });
	if (week.length) groups.push({ label: "Previous 7 Days", items: week });
	if (month.length) groups.push({ label: "Previous 30 Days", items: month });
	if (older.length) groups.push({ label: "Older", items: older });
	return groups;
}

function hoursAgoIso(h: number): string {
	return new Date(Date.now() - h * 3_600_000).toISOString();
}
function daysAgoIso(d: number): string {
	return hoursAgoIso(d * 24);
}

describe("groupConversations", () => {
	test("returns empty array for no conversations", () => {
		expect(groupConversations([])).toEqual([]);
	});

	test("places a recent conversation into Today", () => {
		const groups = groupConversations([
			{ id: "1", title: "A", updatedAt: hoursAgoIso(2) },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Today");
		expect(groups[0].items[0].id).toBe("1");
	});

	test("places a 2-day-old conversation into Previous 7 Days", () => {
		const groups = groupConversations([
			{ id: "1", title: "A", updatedAt: daysAgoIso(2) },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Previous 7 Days");
	});

	test("places a 10-day-old conversation into Previous 30 Days", () => {
		const groups = groupConversations([
			{ id: "1", title: "A", updatedAt: daysAgoIso(10) },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Previous 30 Days");
	});

	test("places a 40-day-old conversation into Older", () => {
		const groups = groupConversations([
			{ id: "1", title: "A", updatedAt: daysAgoIso(40) },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Older");
	});

	test("creates multiple groups with correct labels in order", () => {
		const conversations: ConvStub[] = [
			{ id: "old", title: "Old", updatedAt: daysAgoIso(40) },
			{ id: "month", title: "Month", updatedAt: daysAgoIso(15) },
			{ id: "week", title: "Week", updatedAt: daysAgoIso(3) },
			{ id: "today", title: "Today", updatedAt: hoursAgoIso(1) },
		];
		const groups = groupConversations(conversations);
		const labels = groups.map((g) => g.label);
		expect(labels).toEqual(["Today", "Previous 7 Days", "Previous 30 Days", "Older"]);
	});

	test("omits empty groups (no week-old items)", () => {
		const conversations: ConvStub[] = [
			{ id: "today", title: "Today", updatedAt: hoursAgoIso(1) },
			{ id: "old", title: "Old", updatedAt: daysAgoIso(40) },
		];
		const groups = groupConversations(conversations);
		const labels = groups.map((g) => g.label);
		expect(labels).toContain("Today");
		expect(labels).toContain("Older");
		expect(labels).not.toContain("Previous 7 Days");
		expect(labels).not.toContain("Previous 30 Days");
	});

	test("sorts conversations within a group by updatedAt descending", () => {
		const conversations: ConvStub[] = [
			{ id: "older-today", title: "B", updatedAt: hoursAgoIso(5) },
			{ id: "newer-today", title: "A", updatedAt: hoursAgoIso(1) },
		];
		const groups = groupConversations(conversations);
		expect(groups[0].items[0].id).toBe("newer-today");
		expect(groups[0].items[1].id).toBe("older-today");
	});

	test("handles all conversations in the same group", () => {
		const conversations: ConvStub[] = [
			{ id: "1", title: "C", updatedAt: hoursAgoIso(3) },
			{ id: "2", title: "A", updatedAt: hoursAgoIso(1) },
			{ id: "3", title: "B", updatedAt: hoursAgoIso(2) },
		];
		const groups = groupConversations(conversations);
		expect(groups).toHaveLength(1);
		expect(groups[0].label).toBe("Today");
		// sorted newest first
		expect(groups[0].items.map((c) => c.id)).toEqual(["2", "3", "1"]);
	});

	test("does not mutate the original array", () => {
		const original: ConvStub[] = [
			{ id: "b", title: "B", updatedAt: hoursAgoIso(2) },
			{ id: "a", title: "A", updatedAt: hoursAgoIso(1) },
		];
		const copy = [...original];
		groupConversations(original);
		expect(original).toEqual(copy);
	});
});

// ── filteredConversations (search merge logic) ───────────────────────────────

interface Conversation {
	id: string;
	title: string;
	projectId: string;
	model: string | null;
	provider: string | null;
	systemPrompt: string | null;
	agentConfigId: string | null;
	test: boolean | null;
	createdAt: string;
	updatedAt: string;
}

interface SearchResult {
	id: string;
	title: string;
	snippet: string;
	updatedAt: string;
}

type SearchableConversation = Conversation & { snippet?: string };

function filteredConversations(
	searchOpen: boolean,
	searchQuery: string,
	conversations: Conversation[],
	searchResults: SearchResult[],
	projectId: string,
): SearchableConversation[] {
	if (!searchOpen || searchQuery.length === 0) return [];
	const q = searchQuery.toLowerCase();
	// Title matches from local list
	const titleMatches = conversations.filter((c) =>
		c.title.toLowerCase().includes(q),
	);
	// Merge with API results (content matches not already title-matched)
	const titleIds = new Set(titleMatches.map((c) => c.id));
	const contentMatches: SearchableConversation[] = searchResults
		.filter((r) => !titleIds.has(r.id))
		.map((r) => {
			const conv = conversations.find((c) => c.id === r.id);
			return {
				id: r.id,
				projectId,
				title: r.title,
				model: conv?.model ?? null,
				provider: conv?.provider ?? null,
				systemPrompt: conv?.systemPrompt ?? null,
				agentConfigId: conv?.agentConfigId ?? null,
				test: conv?.test ?? null,
				createdAt: conv?.createdAt ?? r.updatedAt,
				updatedAt: r.updatedAt,
				snippet: r.snippet,
			};
		});
	return [...titleMatches, ...contentMatches];
}

const baseConv = (overrides: Partial<Conversation> & { id: string; title: string }): Conversation => ({
	projectId: "proj-1",
	model: null,
	provider: null,
	systemPrompt: null,
	agentConfigId: null,
	test: null,
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...overrides,
});

describe("filteredConversations", () => {
	test("returns empty array when search is not open", () => {
		const convs = [baseConv({ id: "1", title: "hello" })];
		expect(filteredConversations(false, "hello", convs, [], "proj-1")).toEqual([]);
	});

	test("returns empty array when query is empty", () => {
		const convs = [baseConv({ id: "1", title: "hello" })];
		expect(filteredConversations(true, "", convs, [], "proj-1")).toEqual([]);
	});

	test("returns title matches for query", () => {
		const convs = [
			baseConv({ id: "1", title: "Project Alpha" }),
			baseConv({ id: "2", title: "Beta notes" }),
		];
		const results = filteredConversations(true, "alpha", convs, [], "proj-1");
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("1");
	});

	test("matching is case-insensitive", () => {
		const convs = [baseConv({ id: "1", title: "My Project" })];
		expect(filteredConversations(true, "MY PROJECT", convs, [], "proj-1")).toHaveLength(1);
	});

	test("returns empty array when no title matches and no search results", () => {
		const convs = [baseConv({ id: "1", title: "Unrelated" })];
		const results = filteredConversations(true, "alpha", convs, [], "proj-1");
		expect(results).toEqual([]);
	});

	test("merges content-match search results not in title matches", () => {
		const convs = [baseConv({ id: "1", title: "Unrelated" })];
		const searchResults: SearchResult[] = [
			{ id: "2", title: "Another conv", snippet: "...matching content...", updatedAt: new Date().toISOString() },
		];
		const results = filteredConversations(true, "matching", convs, searchResults, "proj-1");
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("2");
		expect(results[0].snippet).toBe("...matching content...");
	});

	test("title matches appear before content matches", () => {
		const convs = [
			baseConv({ id: "title-match", title: "Alpha Project" }),
		];
		const searchResults: SearchResult[] = [
			{ id: "content-match", title: "Other conv", snippet: "has alpha in body", updatedAt: new Date().toISOString() },
		];
		const results = filteredConversations(true, "alpha", convs, searchResults, "proj-1");
		expect(results[0].id).toBe("title-match");
		expect(results[1].id).toBe("content-match");
	});

	test("deduplicates: title match is not duplicated by search result", () => {
		const convs = [baseConv({ id: "1", title: "Alpha Project" })];
		const searchResults: SearchResult[] = [
			// Same id — should be filtered out as it's already in title matches
			{ id: "1", title: "Alpha Project", snippet: "some snippet", updatedAt: new Date().toISOString() },
		];
		const results = filteredConversations(true, "alpha", convs, searchResults, "proj-1");
		expect(results).toHaveLength(1);
	});

	test("content match uses conversation metadata when available in local list", () => {
		const updatedAt = new Date().toISOString();
		const conv = baseConv({ id: "1", title: "Unrelated", model: "claude-3-5-sonnet", provider: "claude", updatedAt });
		const searchResults: SearchResult[] = [
			{ id: "1", title: "Unrelated", snippet: "body match", updatedAt },
		];
		const results = filteredConversations(true, "body", [conv], searchResults, "proj-1");
		// "body" doesn't match the title "Unrelated", so it comes as content match
		expect(results).toHaveLength(1);
		expect(results[0].model).toBe("claude-3-5-sonnet");
		expect(results[0].provider).toBe("claude");
	});

	test("content match falls back to null metadata when conv not in local list", () => {
		const updatedAt = new Date().toISOString();
		const searchResults: SearchResult[] = [
			{ id: "unknown", title: "Remote conv", snippet: "body", updatedAt },
		];
		const results = filteredConversations(true, "body", [], searchResults, "proj-1");
		expect(results).toHaveLength(1);
		expect(results[0].model).toBeNull();
		expect(results[0].provider).toBeNull();
	});

	test("returns multiple title matches", () => {
		const convs = [
			baseConv({ id: "1", title: "Alpha one" }),
			baseConv({ id: "2", title: "Alpha two" }),
			baseConv({ id: "3", title: "Beta" }),
		];
		const results = filteredConversations(true, "alpha", convs, [], "proj-1");
		expect(results).toHaveLength(2);
		const ids = results.map((r) => r.id);
		expect(ids).toContain("1");
		expect(ids).toContain("2");
	});
});

// ── isSearchActive ────────────────────────────────────────────────────────────

function isSearchActive(searchOpen: boolean, searchQuery: string): boolean {
	return searchOpen && searchQuery.length > 0;
}

describe("isSearchActive", () => {
	test("false when not open", () => {
		expect(isSearchActive(false, "query")).toBe(false);
	});

	test("false when open but query is empty", () => {
		expect(isSearchActive(true, "")).toBe(false);
	});

	test("true when open and query has content", () => {
		expect(isSearchActive(true, "alpha")).toBe(true);
	});
});

// ── handleSearchInput debounce guard ─────────────────────────────────────────
// The component guards the API call if query.length < 2.

function shouldTriggerSearch(query: string): boolean {
	return query.length >= 2;
}

describe("shouldTriggerSearch", () => {
	test("false for empty query", () => {
		expect(shouldTriggerSearch("")).toBe(false);
	});

	test("false for single character", () => {
		expect(shouldTriggerSearch("a")).toBe(false);
	});

	test("true for two characters", () => {
		expect(shouldTriggerSearch("ab")).toBe(true);
	});

	test("true for longer query", () => {
		expect(shouldTriggerSearch("hello world")).toBe(true);
	});
});
