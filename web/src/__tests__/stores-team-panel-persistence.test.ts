/**
 * Integration tests for teamPanel persistence wiring in stores.svelte.ts.
 *
 * The real store helpers (openTeamPanel/closeTeamPanel/openTeamDrillDown/
 * closeTeamDrillDown) live inside a class that uses Svelte 5 runes — same
 * reason as stores-agent-complete-routing.test.ts, we can't import the
 * real module at test time. Instead, we mirror the helper logic against a
 * plain `teamPanel` object and run it through the real
 * `writeTeamPanel`/`readTeamPanel` functions to prove the persistence
 * wiring (load → mutate → persist → reload → restore) is correct.
 *
 * The handlers this mirrors live in stores.svelte.ts around lines 461-480.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	readTeamPanel,
	writeTeamPanel,
	type TeamPanelState,
} from "$lib/panel-persistence.js";

// ── In-memory localStorage shim ──

let storage: Map<string, string>;

function setupStorage() {
	storage = new Map();
	(globalThis as { localStorage?: unknown }).localStorage = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => { storage.set(k, v); },
		removeItem: (k: string) => { storage.delete(k); },
		key: (i: number) => Array.from(storage.keys())[i] ?? null,
		clear: () => storage.clear(),
		get length() { return storage.size; },
	} as Storage;
}

function teardownStorage() {
	delete (globalThis as { localStorage?: unknown }).localStorage;
}

// ── Test double: mirrors the store's teamPanel slice + helpers ──

const DEFAULT_STATE: TeamPanelState = {
	open: false,
	agentConfigId: null,
	teamName: null,
	conversationId: null,
	drillDownAgent: null,
};

function makeStore() {
	// Mirrors `teamPanel = $state(readTeamPanel() ?? { ...defaults })`
	// from stores.svelte.ts:189-194 (post-persistence wiring).
	const teamPanel: TeamPanelState = readTeamPanel() ?? { ...DEFAULT_STATE };
	return {
		get teamPanel() { return teamPanel; },
		// Mirrors stores.svelte.ts openTeamPanel
		openTeamPanel(conversationId: string, agentConfigId: string, teamName: string) {
			Object.assign(teamPanel, {
				open: true,
				agentConfigId,
				teamName,
				conversationId,
				drillDownAgent: null,
			});
			writeTeamPanel(teamPanel);
		},
		closeTeamPanel() {
			Object.assign(teamPanel, { ...DEFAULT_STATE });
			writeTeamPanel(teamPanel);
		},
		openTeamDrillDown(subConversationId: string, agentName: string, turnIndex?: number) {
			teamPanel.drillDownAgent = { subConversationId, agentName, turnIndex };
			writeTeamPanel(teamPanel);
		},
		closeTeamDrillDown() {
			teamPanel.drillDownAgent = null;
			writeTeamPanel(teamPanel);
		},
	};
}

// ─────────────────────────────────────────────
// Initialization from storage
// ─────────────────────────────────────────────

describe("teamPanel: initial load from storage", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("starts with defaults when storage is empty", () => {
		const store = makeStore();
		expect(store.teamPanel).toEqual(DEFAULT_STATE);
	});

	test("restores fully persisted state on first load", () => {
		const persisted: TeamPanelState = {
			open: true,
			agentConfigId: "cfg-9",
			teamName: "Eng",
			conversationId: "conv-9",
			drillDownAgent: { subConversationId: "sub-9", agentName: "coder", turnIndex: 4 },
		};
		writeTeamPanel(persisted);

		const store = makeStore();
		expect(store.teamPanel).toEqual(persisted);
	});

	test("restores even when only partially populated (closed but with conversationId)", () => {
		// Edge case: panel was closed but we want to remember last conv binding.
		const partial: TeamPanelState = {
			open: false,
			agentConfigId: "cfg-1",
			teamName: "Eng",
			conversationId: "conv-1",
			drillDownAgent: null,
		};
		writeTeamPanel(partial);

		const store = makeStore();
		expect(store.teamPanel).toEqual(partial);
	});

	test("falls back to defaults when storage holds garbage", () => {
		storage.set("ezcorp-panel-team", "{not-json");
		const store = makeStore();
		expect(store.teamPanel).toEqual(DEFAULT_STATE);
	});
});

// ─────────────────────────────────────────────
// openTeamPanel
// ─────────────────────────────────────────────

describe("teamPanel: openTeamPanel persistence", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("mutates state and writes to storage", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");

		expect(store.teamPanel.open).toBe(true);
		expect(store.teamPanel.conversationId).toBe("conv-1");
		expect(store.teamPanel.agentConfigId).toBe("cfg-1");
		expect(store.teamPanel.teamName).toBe("Eng");
		expect(store.teamPanel.drillDownAgent).toBeNull();

		// And it's persisted exactly
		expect(readTeamPanel()).toEqual({
			open: true,
			agentConfigId: "cfg-1",
			teamName: "Eng",
			conversationId: "conv-1",
			drillDownAgent: null,
		});
	});

	test("clears any previous drill-down when opening a new panel", () => {
		writeTeamPanel({
			open: true,
			agentConfigId: "old-cfg",
			teamName: "Old",
			conversationId: "old-conv",
			drillDownAgent: { subConversationId: "sub-old", agentName: "x", turnIndex: 2 },
		});
		const store = makeStore();
		store.openTeamPanel("conv-new", "cfg-new", "New");

		expect(store.teamPanel.drillDownAgent).toBeNull();
		expect(readTeamPanel()?.drillDownAgent).toBeNull();
	});

	test("survives a simulated page refresh — opening then re-loading restores", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");

		// Simulate refresh: brand new store instance reading from storage.
		const reloaded = makeStore();
		expect(reloaded.teamPanel.open).toBe(true);
		expect(reloaded.teamPanel.conversationId).toBe("conv-1");
		expect(reloaded.teamPanel.agentConfigId).toBe("cfg-1");
		expect(reloaded.teamPanel.teamName).toBe("Eng");
	});
});

// ─────────────────────────────────────────────
// closeTeamPanel
// ─────────────────────────────────────────────

describe("teamPanel: closeTeamPanel persistence", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("clears state and persists the closed shape", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.closeTeamPanel();

		expect(store.teamPanel).toEqual(DEFAULT_STATE);
		expect(readTeamPanel()).toEqual(DEFAULT_STATE);
	});

	test("survives refresh — closing persists across reload", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.closeTeamPanel();

		const reloaded = makeStore();
		expect(reloaded.teamPanel.open).toBe(false);
		expect(reloaded.teamPanel.conversationId).toBeNull();
	});
});

// ─────────────────────────────────────────────
// openTeamDrillDown
// ─────────────────────────────────────────────

describe("teamPanel: openTeamDrillDown persistence", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("sets drillDownAgent and persists", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.openTeamDrillDown("sub-1", "coder", 5);

		expect(store.teamPanel.drillDownAgent).toEqual({
			subConversationId: "sub-1",
			agentName: "coder",
			turnIndex: 5,
		});
		expect(readTeamPanel()?.drillDownAgent).toEqual({
			subConversationId: "sub-1",
			agentName: "coder",
			turnIndex: 5,
		});
	});

	test("turnIndex is optional", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.openTeamDrillDown("sub-1", "coder");

		expect(store.teamPanel.drillDownAgent?.turnIndex).toBeUndefined();
		// readTeamPanel normalizes undefined turnIndex back to undefined
		expect(readTeamPanel()?.drillDownAgent?.turnIndex).toBeUndefined();
	});

	test("preserves the parent panel binding (open + conversationId + team)", () => {
		const store = makeStore();
		store.openTeamPanel("conv-7", "cfg-7", "QA");
		store.openTeamDrillDown("sub-7", "tester", 0);

		expect(store.teamPanel.open).toBe(true);
		expect(store.teamPanel.conversationId).toBe("conv-7");
		expect(store.teamPanel.agentConfigId).toBe("cfg-7");
		expect(store.teamPanel.teamName).toBe("QA");
	});

	test("survives refresh — drill-down restores with parent binding", () => {
		const store = makeStore();
		store.openTeamPanel("conv-7", "cfg-7", "QA");
		store.openTeamDrillDown("sub-7", "tester", 3);

		const reloaded = makeStore();
		expect(reloaded.teamPanel.open).toBe(true);
		expect(reloaded.teamPanel.conversationId).toBe("conv-7");
		expect(reloaded.teamPanel.drillDownAgent).toEqual({
			subConversationId: "sub-7",
			agentName: "tester",
			turnIndex: 3,
		});
	});
});

// ─────────────────────────────────────────────
// closeTeamDrillDown
// ─────────────────────────────────────────────

describe("teamPanel: closeTeamDrillDown persistence", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("clears drillDownAgent only — does not close the panel", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.openTeamDrillDown("sub-1", "coder", 1);
		store.closeTeamDrillDown();

		expect(store.teamPanel.drillDownAgent).toBeNull();
		expect(store.teamPanel.open).toBe(true); // still open!
		expect(store.teamPanel.conversationId).toBe("conv-1");
	});

	test("persists the cleared drill-down across refresh", () => {
		const store = makeStore();
		store.openTeamPanel("conv-1", "cfg-1", "Eng");
		store.openTeamDrillDown("sub-1", "coder", 1);
		store.closeTeamDrillDown();

		const reloaded = makeStore();
		expect(reloaded.teamPanel.drillDownAgent).toBeNull();
		expect(reloaded.teamPanel.open).toBe(true);
	});
});

// ─────────────────────────────────────────────
// Realistic interaction sequences
// ─────────────────────────────────────────────

describe("teamPanel: realistic flows survive refresh at every checkpoint", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("open → drill → refresh → drill state preserved", () => {
		const s1 = makeStore();
		s1.openTeamPanel("conv-1", "cfg-1", "Eng");
		s1.openTeamDrillDown("sub-1", "coder", 4);

		const s2 = makeStore();
		expect(s2.teamPanel.open).toBe(true);
		expect(s2.teamPanel.drillDownAgent?.subConversationId).toBe("sub-1");
		expect(s2.teamPanel.drillDownAgent?.turnIndex).toBe(4);
	});

	test("open → drill → back-to-team → refresh → overview preserved", () => {
		const s1 = makeStore();
		s1.openTeamPanel("conv-1", "cfg-1", "Eng");
		s1.openTeamDrillDown("sub-1", "coder", 4);
		s1.closeTeamDrillDown();

		const s2 = makeStore();
		expect(s2.teamPanel.open).toBe(true);
		expect(s2.teamPanel.drillDownAgent).toBeNull();
		expect(s2.teamPanel.conversationId).toBe("conv-1");
	});

	test("close fully clears across refresh — no stale binding", () => {
		const s1 = makeStore();
		s1.openTeamPanel("conv-1", "cfg-1", "Eng");
		s1.openTeamDrillDown("sub-1", "coder", 4);
		s1.closeTeamPanel();

		const s2 = makeStore();
		expect(s2.teamPanel).toEqual(DEFAULT_STATE);
	});

	test("switching teams clears drill-down — both views consistent across refresh", () => {
		const s1 = makeStore();
		s1.openTeamPanel("conv-A", "cfg-A", "Team A");
		s1.openTeamDrillDown("sub-A", "alice", 1);

		// User switches to a different team without closing
		s1.openTeamPanel("conv-B", "cfg-B", "Team B");

		const s2 = makeStore();
		expect(s2.teamPanel.conversationId).toBe("conv-B");
		expect(s2.teamPanel.teamName).toBe("Team B");
		expect(s2.teamPanel.drillDownAgent).toBeNull();
	});
});
