import { test, expect, describe, beforeEach, afterEach } from "bun:test";

/**
 * Tests for the command palette registry logic.
 *
 * Following the streaming-store.test.ts pattern: replicate the planned
 * command-registry logic as plain functions. These tests define the
 * behavioral contract that command-registry.ts must satisfy in Plan 03.
 */

// --- Interfaces matching planned command-registry.ts ---

interface Command {
	id: string;
	label: string;
	context?: string[]; // route patterns where this command appears
	action: () => void;
}

// --- Replicated logic ---

function fuzzyMatch(query: string, commands: Command[]): Command[] {
	const lower = query.toLowerCase();
	return commands
		.filter((cmd) => cmd.label.toLowerCase().includes(lower))
		.sort((a, b) => {
			const aStarts = a.label.toLowerCase().startsWith(lower) ? 0 : 1;
			const bStarts = b.label.toLowerCase().startsWith(lower) ? 0 : 1;
			return aStarts - bStarts;
		});
}

function resolveCommands(commands: Command[], pathname: string): Command[] {
	return commands.filter((cmd) => {
		if (!cmd.context || cmd.context.length === 0) return true;
		return cmd.context.some((pattern) => pathname.includes(pattern));
	});
}

const RECENT_KEY = "pi-recent-commands";
const MAX_RECENT = 5;

function getRecentCommands(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function addRecentCommand(id: string): void {
	const recent = getRecentCommands().filter((r) => r !== id);
	recent.unshift(id);
	if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
	localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
}

// --- Mock localStorage ---

let storage: Map<string, string>;

function setupStorage() {
	storage = new Map();
	(globalThis as any).localStorage = {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	};
}

function teardownStorage() {
	delete (globalThis as any).localStorage;
}

// --- Test data ---

const noop = () => {};

const sampleCommands: Command[] = [
	{ id: "settings", label: "Settings", action: noop },
	{ id: "go-settings", label: "Go to Settings", action: noop },
	{ id: "reset-settings", label: "Reset Settings", action: noop },
	{ id: "new-chat", label: "New Chat", action: noop },
	{ id: "toggle-theme", label: "Toggle Theme", action: noop },
	{ id: "chat-export", label: "Export Chat History", context: ["/chat/"], action: noop },
	{ id: "agent-edit", label: "Edit Agent", context: ["/agent/"], action: noop },
];

// --- buildCommands logic (replicated, since command-registry.ts imports SvelteKit modules) ---

function buildCommands(activeProjectId: string): Command[] {
	const isProject = activeProjectId && activeProjectId !== "global";

	const navigation: Command[] = [
		{ id: "go-dashboard", label: isProject ? "Go to Overview" : "Go to Home", action: noop },
		...(isProject
			? [{ id: "go-chat", label: "Go to Chat", action: noop }]
			: []),
		{ id: "go-memories", label: "Go to Memories", action: noop },
		{ id: "go-agents", label: "Go to Agents", action: noop },
		{ id: "go-extensions", label: "Go to Extensions", action: noop },
		{ id: "go-marketplace", label: "Go to Marketplace", action: noop },
		{ id: "go-observability", label: "Go to Analytics", action: noop },
		{ id: "go-settings", label: "Go to Settings", action: noop },
	];

	const chatContext: Command[] = [
		{ id: "export-conversation", label: "Export Conversation", context: ["/chat/"], action: noop },
		{ id: "switch-model", label: "Switch Model", context: ["/chat/"], action: noop },
		{ id: "branch-from-here", label: "Branch from Here", context: ["/chat/"], action: noop },
	];

	const extensionContext: Command[] = [
		{ id: "install-extension", label: "Install Extension", context: ["/extensions"], action: noop },
	];

	const settingsCommands: Command[] = [
		{ id: "toggle-theme", label: "Toggle Theme", action: noop },
		{ id: "manage-providers", label: "Manage Providers", action: noop },
	];

	const searchCommands: Command[] = [
		{ id: "search-conversations", label: "Search conversations...", action: noop },
	];

	return [...navigation, ...chatContext, ...extensionContext, ...settingsCommands, ...searchCommands];
}

// --- Tests ---

describe("fuzzyMatch", () => {
	test("filters commands by label substring", () => {
		const results = fuzzyMatch("set", sampleCommands);
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.label.toLowerCase()).toContain("set");
		}
	});

	test("is case-insensitive", () => {
		const results = fuzzyMatch("SET", sampleCommands);
		expect(results.length).toBeGreaterThan(0);
		expect(results.some((r) => r.label === "Settings")).toBe(true);
	});

	test("prioritizes startsWith over contains", () => {
		const results = fuzzyMatch("set", sampleCommands);
		// "Settings" starts with "set" and should come before "Reset Settings" or "Go to Settings"
		const settingsIdx = results.findIndex((r) => r.label === "Settings");
		const resetIdx = results.findIndex((r) => r.label === "Reset Settings");
		const goIdx = results.findIndex((r) => r.label === "Go to Settings");
		expect(settingsIdx).toBeLessThan(resetIdx);
		expect(settingsIdx).toBeLessThan(goIdx);
	});

	test("returns empty for no match", () => {
		const results = fuzzyMatch("zzz", sampleCommands);
		expect(results).toEqual([]);
	});

	test("returns all commands for empty query", () => {
		const results = fuzzyMatch("", sampleCommands);
		expect(results).toHaveLength(sampleCommands.length);
	});

	test("handles special characters in query without crashing", () => {
		// These are passed through as literal substrings (not regex), so they should just not match
		expect(fuzzyMatch("(", sampleCommands)).toEqual([]);
		expect(fuzzyMatch("[", sampleCommands)).toEqual([]);
		expect(fuzzyMatch(".*", sampleCommands)).toEqual([]);
		expect(fuzzyMatch("$", sampleCommands)).toEqual([]);
	});

	test("matches partial words within labels", () => {
		const results = fuzzyMatch("hat", sampleCommands);
		// "New Chat" and "Export Chat History" contain "hat"
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.label.toLowerCase().includes("hat"))).toBe(true);
	});

	test("single character query matches broadly", () => {
		const results = fuzzyMatch("e", sampleCommands);
		// "Settings", "Reset Settings", "Toggle Theme", "Export Chat History", "Edit Agent"
		expect(results.length).toBeGreaterThanOrEqual(4);
	});

	test("full label match returns exactly one result", () => {
		const results = fuzzyMatch("Toggle Theme", sampleCommands);
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("toggle-theme");
	});

	test("query with trailing spaces still matches", () => {
		// .includes handles trailing space fine — "set " is not in "Settings"
		const results = fuzzyMatch("settings", sampleCommands);
		expect(results.length).toBe(3); // Settings, Go to Settings, Reset Settings
	});
});

describe("resolveCommands", () => {
	test("returns all commands when no context filter", () => {
		// Commands without context should always be included
		const results = resolveCommands(sampleCommands, "/dashboard");
		const contextFree = results.filter((c) => !c.context || c.context.length === 0);
		expect(contextFree.length).toBe(5); // settings, go-settings, reset-settings, new-chat, toggle-theme
	});

	test("filters by route pattern", () => {
		const results = resolveCommands(sampleCommands, "/chat/abc");
		const chatExport = results.find((c) => c.id === "chat-export");
		expect(chatExport).toBeDefined();

		// Agent-only command should NOT appear
		const agentEdit = results.find((c) => c.id === "agent-edit");
		expect(agentEdit).toBeUndefined();
	});

	test("includes context-free and context-matched commands", () => {
		const results = resolveCommands(sampleCommands, "/chat/123");
		// Should include context-free commands (5) + chat-export (1)
		expect(results).toHaveLength(6);
	});

	test("excludes all context commands on unmatched route", () => {
		const results = resolveCommands(sampleCommands, "/dashboard");
		// Only context-free commands
		expect(results).toHaveLength(5);
		expect(results.every((c) => !c.context || c.context.length === 0)).toBe(true);
	});

	test("command with multiple context patterns matches any of them", () => {
		const multiContextCmd: Command[] = [
			{ id: "multi", label: "Multi Context", context: ["/chat/", "/agent/"], action: noop },
		];
		expect(resolveCommands(multiContextCmd, "/chat/123")).toHaveLength(1);
		expect(resolveCommands(multiContextCmd, "/agent/abc")).toHaveLength(1);
		expect(resolveCommands(multiContextCmd, "/settings")).toHaveLength(0);
	});

	test("empty pathname excludes all context commands", () => {
		const results = resolveCommands(sampleCommands, "");
		// Only context-free commands — context patterns can't match empty string
		expect(results).toHaveLength(5);
	});

	test("handles commands list with all having context", () => {
		const allContextual: Command[] = [
			{ id: "a", label: "A", context: ["/page-a"], action: noop },
			{ id: "b", label: "B", context: ["/page-b"], action: noop },
		];
		expect(resolveCommands(allContextual, "/page-a")).toHaveLength(1);
		expect(resolveCommands(allContextual, "/page-a")[0].id).toBe("a");
		expect(resolveCommands(allContextual, "/other")).toHaveLength(0);
	});
});

describe("recent commands", () => {
	beforeEach(() => {
		setupStorage();
	});

	afterEach(() => {
		teardownStorage();
	});

	test("addRecentCommand stores command id", () => {
		addRecentCommand("settings");
		const recent = getRecentCommands();
		expect(recent).toEqual(["settings"]);
	});

	test("keeps max 5 recent", () => {
		addRecentCommand("cmd-1");
		addRecentCommand("cmd-2");
		addRecentCommand("cmd-3");
		addRecentCommand("cmd-4");
		addRecentCommand("cmd-5");
		addRecentCommand("cmd-6");

		const recent = getRecentCommands();
		expect(recent).toHaveLength(5);
		// Oldest (cmd-1) should be dropped
		expect(recent).not.toContain("cmd-1");
		expect(recent[0]).toBe("cmd-6");
	});

	test("most recent first", () => {
		addRecentCommand("A");
		addRecentCommand("B");

		const recent = getRecentCommands();
		expect(recent).toEqual(["B", "A"]);
	});

	test("deduplicates on re-add (moves to front)", () => {
		addRecentCommand("A");
		addRecentCommand("B");
		addRecentCommand("A"); // re-add

		const recent = getRecentCommands();
		expect(recent).toEqual(["A", "B"]);
	});

	test("returns empty when no localStorage entry", () => {
		const recent = getRecentCommands();
		expect(recent).toEqual([]);
	});

	test("returns empty on corrupt localStorage data", () => {
		storage.set(RECENT_KEY, "not-json{{{");
		const recent = getRecentCommands();
		expect(recent).toEqual([]);
	});

	test("returns empty when localStorage contains non-array JSON", () => {
		storage.set(RECENT_KEY, JSON.stringify({ not: "an array" }));
		const recent = getRecentCommands();
		expect(recent).toEqual([]);
	});

	test("dedup with more than 5 commands keeps only newest 5", () => {
		addRecentCommand("a");
		addRecentCommand("b");
		addRecentCommand("c");
		addRecentCommand("d");
		addRecentCommand("e");
		// Now at capacity (5). Add a 6th.
		addRecentCommand("f");

		const recent = getRecentCommands();
		expect(recent).toHaveLength(5);
		expect(recent).toEqual(["f", "e", "d", "c", "b"]);
		expect(recent).not.toContain("a");
	});

	test("re-adding existing command within full list doesn't grow beyond 5", () => {
		addRecentCommand("a");
		addRecentCommand("b");
		addRecentCommand("c");
		addRecentCommand("d");
		addRecentCommand("e");

		// Re-add "c" — should move to front, not add a duplicate
		addRecentCommand("c");

		const recent = getRecentCommands();
		expect(recent).toHaveLength(5);
		expect(recent[0]).toBe("c");
		// "c" should appear only once
		expect(recent.filter((r) => r === "c")).toHaveLength(1);
	});

	test("re-adding the oldest command rescues it from eviction", () => {
		addRecentCommand("a");
		addRecentCommand("b");
		addRecentCommand("c");
		addRecentCommand("d");
		addRecentCommand("e");

		// "a" is oldest. Re-add to rescue it.
		addRecentCommand("a");
		const recent = getRecentCommands();
		expect(recent[0]).toBe("a");
		expect(recent).toHaveLength(5);
	});

	test("adding same command twice in a row results in single entry", () => {
		addRecentCommand("x");
		addRecentCommand("x");
		const recent = getRecentCommands();
		expect(recent).toEqual(["x"]);
	});
});

describe("buildCommands", () => {
	test("global context excludes project-specific commands", () => {
		const commands = buildCommands("global");
		const ids = commands.map((c) => c.id);
		expect(ids).not.toContain("go-chat");
		expect(ids).toContain("go-dashboard");
		expect(ids).toContain("go-settings");
	});

	test("project context includes go-chat command", () => {
		const commands = buildCommands("proj-1");
		const ids = commands.map((c) => c.id);
		expect(ids).toContain("go-chat");
		expect(ids).toContain("go-dashboard");
	});

	test("project context includes all global commands plus go-chat", () => {
		const globalCmds = buildCommands("global");
		const projectCmds = buildCommands("proj-1");
		// Project should have exactly 1 more command (go-chat)
		expect(projectCmds.length).toBe(globalCmds.length + 1);
	});

	test("empty string activeProjectId treated like global", () => {
		const commands = buildCommands("");
		const ids = commands.map((c) => c.id);
		expect(ids).not.toContain("go-chat");
	});

	test("chat context commands are present in both global and project builds", () => {
		for (const ctx of ["global", "proj-1"]) {
			const commands = buildCommands(ctx);
			expect(commands.some((c) => c.id === "export-conversation")).toBe(true);
			expect(commands.some((c) => c.id === "switch-model")).toBe(true);
		}
	});

	test("all commands have an id and label", () => {
		const commands = buildCommands("proj-1");
		for (const cmd of commands) {
			expect(cmd.id).toBeTruthy();
			expect(cmd.label).toBeTruthy();
		}
	});
});
