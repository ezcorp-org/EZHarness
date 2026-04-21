import { test, expect, describe } from "bun:test";

// Pure logic extracted from MemoryItem.svelte and MemoryList.svelte

// ── Types (mirrored from MemoryItem.svelte) ──────────────────────────

interface Memory {
	id: string;
	content: string;
	category: string;
	confidence: string;
	status: string;
	projectId: string | null;
	conversationId: string | null;
	messageIds: string[] | null;
	provenance: null | {
		sourceConversationId?: string;
		sourceMessageIds?: string[];
		extractedAt?: string;
		confidence?: string;
		history?: Array<{ action: string; timestamp: string; reason: string; previousContent?: string }>;
	};
	lastAccessedAt: string;
	createdAt: string;
	updatedAt: string;
}

// ── Category / status mappings (from MemoryItem.svelte) ──────────────

const categoryColors: Record<string, string> = {
	preferences: "bg-blue-500/20 text-blue-300",
	technical: "bg-green-500/20 text-green-300",
	biographical: "bg-purple-500/20 text-purple-300",
	decisions_goals: "bg-amber-500/20 text-amber-300",
};

const categoryLabels: Record<string, string> = {
	preferences: "Preferences",
	technical: "Technical",
	biographical: "Biographical",
	decisions_goals: "Decisions & Goals",
};

const statusDots: Record<string, string> = {
	active: "bg-green-500",
	stale: "bg-yellow-500",
	archived: "bg-gray-500",
};

function getCategoryColor(category: string): string {
	return categoryColors[category] ?? "bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]";
}

function getCategoryLabel(category: string): string {
	return categoryLabels[category] ?? category;
}

function getStatusDot(status: string): string {
	return statusDots[status] ?? "bg-gray-500";
}

// ── relativeTime (from MemoryItem.svelte) ────────────────────────────

function relativeTime(dateStr: string, nowMs?: number): string {
	const now = nowMs ?? Date.now();
	const diff = now - new Date(dateStr).getTime();
	const mins = Math.floor(diff / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hrs = Math.floor(mins / 60);
	if (hrs < 24) return `${hrs}h ago`;
	const days = Math.floor(hrs / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

// ── content preview (from MemoryItem.svelte) ─────────────────────────

function contentPreview(content: string): string {
	return `${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`;
}

// ── displayMemories filter (from MemoryList.svelte) ──────────────────
// When a specific memory is being focused via ?focus=, it always appears in the
// list even if the default "hide archived" filter would normally remove it — so
// deep-links from chat always resolve to something.

function filterDisplayMemories(
	memories: Memory[],
	activeStatus: string,
	showArchived: boolean,
	focusMemoryId?: string,
): Memory[] {
	return activeStatus === "" && !showArchived
		? memories.filter((m) => m.status !== "archived" || m.id === focusMemoryId)
		: memories;
}

// ── MemoryItem focus effect (from MemoryItem.svelte) ────────────────
// Mirrors the $effect in MemoryItem that auto-expands + scrolls when the
// `focusMemoryId` prop changes to match this item's id. The effect tracks the
// last seen prop value so re-navigating to the same id after a change re-fires.

interface FocusEffectState {
	memoryId: string;
	lastSeenFocus: string | undefined;
	expanded: boolean;
	scrolled: boolean;
}

function applyFocusEffect(state: FocusEffectState, focusMemoryId: string | undefined): FocusEffectState {
	if (focusMemoryId === state.lastSeenFocus) {
		return state; // no change — do nothing
	}
	const next: FocusEffectState = { ...state, lastSeenFocus: focusMemoryId };
	if (focusMemoryId && focusMemoryId === state.memoryId) {
		next.expanded = true;
		next.scrolled = true;
	}
	return next;
}

// ── saveEdit body builder (from MemoryItem.svelte) ───────────────────

function buildEditBody(
	original: Pick<Memory, "content" | "category" | "confidence">,
	edited: Pick<Memory, "content" | "category" | "confidence">,
): Record<string, string> {
	const body: Record<string, string> = {};
	if (edited.content !== original.content) body.content = edited.content;
	if (edited.category !== original.category) body.category = edited.category;
	if (edited.confidence !== original.confidence) body.confidence = edited.confidence;
	return body;
}

// ── category color mapping ───────────────────────────────────────────

describe("getCategoryColor", () => {
	test("preferences gets blue color", () => {
		expect(getCategoryColor("preferences")).toBe("bg-blue-500/20 text-blue-300");
	});

	test("technical gets green color", () => {
		expect(getCategoryColor("technical")).toBe("bg-green-500/20 text-green-300");
	});

	test("biographical gets purple color", () => {
		expect(getCategoryColor("biographical")).toBe("bg-purple-500/20 text-purple-300");
	});

	test("decisions_goals gets amber color", () => {
		expect(getCategoryColor("decisions_goals")).toBe("bg-amber-500/20 text-amber-300");
	});

	test("unknown category gets fallback color", () => {
		expect(getCategoryColor("unknown")).toBe(
			"bg-[var(--color-surface-tertiary)] text-[var(--color-text-secondary)]",
		);
	});
});

// ── category label mapping ───────────────────────────────────────────

describe("getCategoryLabel", () => {
	test("preferences label", () => {
		expect(getCategoryLabel("preferences")).toBe("Preferences");
	});

	test("technical label", () => {
		expect(getCategoryLabel("technical")).toBe("Technical");
	});

	test("biographical label", () => {
		expect(getCategoryLabel("biographical")).toBe("Biographical");
	});

	test("decisions_goals label", () => {
		expect(getCategoryLabel("decisions_goals")).toBe("Decisions & Goals");
	});

	test("unknown category falls back to the raw value", () => {
		expect(getCategoryLabel("my_custom_cat")).toBe("my_custom_cat");
	});
});

// ── status dot mapping ───────────────────────────────────────────────

describe("getStatusDot", () => {
	test("active gets green dot", () => {
		expect(getStatusDot("active")).toBe("bg-green-500");
	});

	test("stale gets yellow dot", () => {
		expect(getStatusDot("stale")).toBe("bg-yellow-500");
	});

	test("archived gets gray dot", () => {
		expect(getStatusDot("archived")).toBe("bg-gray-500");
	});

	test("unknown status falls back to gray", () => {
		expect(getStatusDot("unknown")).toBe("bg-gray-500");
	});
});

// ── relativeTime ─────────────────────────────────────────────────────

describe("relativeTime", () => {
	const now = new Date("2026-03-26T12:00:00Z").getTime();

	test("just now for less than 1 minute ago", () => {
		const date = new Date(now - 30_000).toISOString(); // 30s ago
		expect(relativeTime(date, now)).toBe("just now");
	});

	test("minutes ago", () => {
		const date = new Date(now - 5 * 60_000).toISOString(); // 5 min ago
		expect(relativeTime(date, now)).toBe("5m ago");
	});

	test("1 minute ago", () => {
		const date = new Date(now - 60_000).toISOString();
		expect(relativeTime(date, now)).toBe("1m ago");
	});

	test("59 minutes ago stays in minutes", () => {
		const date = new Date(now - 59 * 60_000).toISOString();
		expect(relativeTime(date, now)).toBe("59m ago");
	});

	test("hours ago", () => {
		const date = new Date(now - 3 * 60 * 60_000).toISOString(); // 3h ago
		expect(relativeTime(date, now)).toBe("3h ago");
	});

	test("23 hours stays in hours", () => {
		const date = new Date(now - 23 * 60 * 60_000).toISOString();
		expect(relativeTime(date, now)).toBe("23h ago");
	});

	test("days ago", () => {
		const date = new Date(now - 5 * 24 * 60 * 60_000).toISOString(); // 5d ago
		expect(relativeTime(date, now)).toBe("5d ago");
	});

	test("months ago", () => {
		const date = new Date(now - 45 * 24 * 60 * 60_000).toISOString(); // ~45d ago
		expect(relativeTime(date, now)).toBe("1mo ago");
	});

	test("years ago", () => {
		const date = new Date(now - 400 * 24 * 60 * 60_000).toISOString(); // >1yr ago
		expect(relativeTime(date, now)).toBe("1y ago");
	});
});

// ── contentPreview ───────────────────────────────────────────────────

describe("contentPreview", () => {
	test("short content is returned as-is", () => {
		expect(contentPreview("Hello world")).toBe("Hello world");
	});

	test("exactly 100 chars: no ellipsis", () => {
		const content = "a".repeat(100);
		expect(contentPreview(content)).toBe(content);
	});

	test("101 chars: truncated with ellipsis", () => {
		const content = "a".repeat(101);
		expect(contentPreview(content)).toBe("a".repeat(100) + "...");
	});

	test("long content is truncated to 100 chars + ellipsis", () => {
		const content = "x".repeat(200);
		expect(contentPreview(content)).toBe("x".repeat(100) + "...");
	});

	test("empty string returns empty string", () => {
		expect(contentPreview("")).toBe("");
	});
});

// ── filterDisplayMemories ────────────────────────────────────────────

const makeMemory = (id: string, status: string): Memory => ({
	id,
	content: `Memory ${id}`,
	category: "preferences",
	confidence: "high",
	status,
	projectId: null,
	conversationId: null,
	messageIds: null,
	provenance: null,
	lastAccessedAt: "2026-01-01T00:00:00Z",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
});

describe("filterDisplayMemories", () => {
	const memories: Memory[] = [
		makeMemory("1", "active"),
		makeMemory("2", "stale"),
		makeMemory("3", "archived"),
		makeMemory("4", "active"),
	];

	test("hides archived when activeStatus is All and showArchived is false", () => {
		const result = filterDisplayMemories(memories, "", false);
		expect(result.map((m) => m.id)).toEqual(["1", "2", "4"]);
	});

	test("shows archived when showArchived is true and activeStatus is All", () => {
		const result = filterDisplayMemories(memories, "", true);
		expect(result.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
	});

	test("shows all including archived when a specific status filter is active", () => {
		const result = filterDisplayMemories(memories, "archived", false);
		expect(result.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
	});

	test("shows all when activeStatus is 'active' (non-empty status)", () => {
		const result = filterDisplayMemories(memories, "active", false);
		expect(result.length).toBe(4);
	});

	test("returns empty list when memories is empty", () => {
		expect(filterDisplayMemories([], "", false)).toEqual([]);
	});

	test("includes a focused archived memory even though default filter hides archived", () => {
		const result = filterDisplayMemories(memories, "", false, "3");
		expect(result.map((m) => m.id)).toEqual(["1", "2", "3", "4"]);
	});

	test("focus bypass only applies to the focused id — other archived rows stay hidden", () => {
		const mems = [
			makeMemory("1", "active"),
			makeMemory("2", "archived"),
			makeMemory("3", "archived"),
		];
		const result = filterDisplayMemories(mems, "", false, "2");
		expect(result.map((m) => m.id)).toEqual(["1", "2"]);
	});

	test("focus with no matching id behaves like no focus", () => {
		const result = filterDisplayMemories(memories, "", false, "nonexistent");
		expect(result.map((m) => m.id)).toEqual(["1", "2", "4"]);
	});

	test("focus is a no-op when showArchived is already true (no filter applied)", () => {
		const result = filterDisplayMemories(memories, "", true, "3");
		expect(result.length).toBe(4);
	});
});

// ── MemoryItem focus effect ─────────────────────────────────────────

describe("applyFocusEffect", () => {
	const baseState = (): FocusEffectState => ({
		memoryId: "mem-A",
		lastSeenFocus: undefined,
		expanded: false,
		scrolled: false,
	});

	test("undefined focus on mount: no expand, no scroll", () => {
		const next = applyFocusEffect(baseState(), undefined);
		expect(next.expanded).toBe(false);
		expect(next.scrolled).toBe(false);
		expect(next.lastSeenFocus).toBeUndefined();
	});

	test("focus matches this memory on first run: expand + scroll", () => {
		const next = applyFocusEffect(baseState(), "mem-A");
		expect(next.expanded).toBe(true);
		expect(next.scrolled).toBe(true);
		expect(next.lastSeenFocus).toBe("mem-A");
	});

	test("focus targets a different memory: leave this one alone", () => {
		const next = applyFocusEffect(baseState(), "mem-B");
		expect(next.expanded).toBe(false);
		expect(next.scrolled).toBe(false);
		expect(next.lastSeenFocus).toBe("mem-B");
	});

	test("no-op when the focus prop hasn't changed (re-render with same value)", () => {
		const applied = applyFocusEffect(baseState(), "mem-A");
		// User manually collapses — expanded becomes false
		const collapsed = { ...applied, expanded: false, scrolled: false };
		// Effect re-runs with same focus — should NOT re-expand (nothing changed)
		const next = applyFocusEffect(collapsed, "mem-A");
		expect(next).toEqual(collapsed);
	});

	test("re-apply after focus was cleared then re-set to same id", () => {
		// Scenario: navigate to /memories?focus=A, collapse it, navigate to /memories,
		// then back to /memories?focus=A — must re-expand.
		let state = applyFocusEffect(baseState(), "mem-A");
		expect(state.expanded).toBe(true);

		// User manually collapses
		state = { ...state, expanded: false, scrolled: false };

		// Clear focus (navigate away)
		state = applyFocusEffect(state, undefined);
		expect(state.lastSeenFocus).toBeUndefined();
		expect(state.expanded).toBe(false);

		// Re-focus same id — prop transitioned undefined → "mem-A", so re-fire
		state = applyFocusEffect(state, "mem-A");
		expect(state.expanded).toBe(true);
		expect(state.scrolled).toBe(true);
	});

	test("switching focus between different memories triggers only the matching one", () => {
		// Two MemoryItem instances — A and B
		let a = { ...baseState(), memoryId: "mem-A" };
		let b = { ...baseState(), memoryId: "mem-B" };

		// Focus A
		a = applyFocusEffect(a, "mem-A");
		b = applyFocusEffect(b, "mem-A");
		expect(a.expanded).toBe(true);
		expect(b.expanded).toBe(false);

		// Focus B
		a = applyFocusEffect(a, "mem-B");
		b = applyFocusEffect(b, "mem-B");
		expect(a.expanded).toBe(true); // A stays expanded (we never force collapse)
		expect(b.expanded).toBe(true);
	});
});

// ── buildEditBody ────────────────────────────────────────────────────

describe("buildEditBody", () => {
	const original = { content: "original", category: "preferences", confidence: "high" };

	test("empty body when nothing changed", () => {
		expect(buildEditBody(original, { ...original })).toEqual({});
	});

	test("includes only changed content", () => {
		const body = buildEditBody(original, { ...original, content: "updated" });
		expect(body).toEqual({ content: "updated" });
	});

	test("includes only changed category", () => {
		const body = buildEditBody(original, { ...original, category: "technical" });
		expect(body).toEqual({ category: "technical" });
	});

	test("includes only changed confidence", () => {
		const body = buildEditBody(original, { ...original, confidence: "low" });
		expect(body).toEqual({ confidence: "low" });
	});

	test("includes all changed fields", () => {
		const body = buildEditBody(original, { content: "new", category: "technical", confidence: "low" });
		expect(body).toEqual({ content: "new", category: "technical", confidence: "low" });
	});
});

// ── categories defined in MemoryList ────────────────────────────────

describe("MemoryList categories", () => {
	const categories = [
		{ value: "", label: "All" },
		{ value: "preferences", label: "Preferences" },
		{ value: "technical", label: "Technical" },
		{ value: "biographical", label: "Biographical" },
		{ value: "decisions_goals", label: "Decisions & Goals" },
	] as const;

	test("has 5 entries including All", () => {
		expect(categories.length).toBe(5);
	});

	test("first entry is All with empty value", () => {
		expect(categories[0]).toEqual({ value: "", label: "All" });
	});

	test("category values match MemoryItem categoryColors keys", () => {
		const knownKeys = Object.keys(categoryColors);
		for (const cat of categories.slice(1)) {
			expect(knownKeys).toContain(cat.value);
		}
	});
});

// ── statuses defined in MemoryList ──────────────────────────────────

describe("MemoryList statuses", () => {
	const statuses = [
		{ value: "", label: "All" },
		{ value: "active", label: "Active" },
		{ value: "stale", label: "Stale" },
		{ value: "archived", label: "Archived" },
	] as const;

	test("has 4 entries", () => {
		expect(statuses.length).toBe(4);
	});

	test("first entry is All", () => {
		expect(statuses[0].value).toBe("");
	});

	test("status values match statusDots keys (excluding All)", () => {
		const knownKeys = Object.keys(statusDots);
		for (const st of statuses.slice(1)) {
			expect(knownKeys).toContain(st.value);
		}
	});
});
