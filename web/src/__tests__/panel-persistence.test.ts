import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
	readTeamPanel,
	writeTeamPanel,
	readChatPanels,
	writeChatPanels,
	readScroll,
	writeScroll,
	readExpandedTools,
	writeExpandedTools,
	readExtPanel,
	writeExtPanel,
	type TeamPanelState,
	type ChatPanelState,
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

// ── Sample fixtures ──

const FULL_TEAM_STATE: TeamPanelState = {
	open: true,
	agentConfigId: "agent-cfg-1",
	teamName: "Engineering",
	conversationId: "conv-1",
	drillDownAgent: { subConversationId: "sub-1", agentName: "coder", turnIndex: 3 },
};

const DEFAULT_CHAT_STATE: ChatPanelState = {
	obsOpen: true,
	diffPanelOpen: true,
	taskLogsOpen: true,
	taskLogsTaskId: "task-99",
	toolsOpen: true,
	settingsOpen: true,
	selectedAgentSubConvId: "sub-7",
};

// ─────────────────────────────────────────────
// readTeamPanel / writeTeamPanel
// ─────────────────────────────────────────────

describe("readTeamPanel", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("returns null when nothing stored", () => {
		expect(readTeamPanel()).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		storage.set("ezcorp-panel-team", "{not-json");
		expect(readTeamPanel()).toBeNull();
	});

	test("returns null when payload is not an object", () => {
		storage.set("ezcorp-panel-team", JSON.stringify("a-string"));
		expect(readTeamPanel()).toBeNull();
	});

	test("returns null when 'open' is missing or wrong type", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({ agentConfigId: "x" }));
		expect(readTeamPanel()).toBeNull();
		storage.set("ezcorp-panel-team", JSON.stringify({ open: "yes" }));
		expect(readTeamPanel()).toBeNull();
	});

	test("returns the stored shape exactly when well-formed", () => {
		storage.set("ezcorp-panel-team", JSON.stringify(FULL_TEAM_STATE));
		expect(readTeamPanel()).toEqual(FULL_TEAM_STATE);
	});

	test("returns minimal shape when only 'open' is set", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({ open: false }));
		expect(readTeamPanel()).toEqual({
			open: false,
			agentConfigId: null,
			teamName: null,
			conversationId: null,
			drillDownAgent: null,
		});
	});

	test("coerces non-string id fields to null", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true, agentConfigId: 123, teamName: false, conversationId: null,
		}));
		expect(readTeamPanel()).toEqual({
			open: true,
			agentConfigId: null,
			teamName: null,
			conversationId: null,
			drillDownAgent: null,
		});
	});

	test("drops drillDownAgent when subConversationId or agentName missing", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true,
			drillDownAgent: { subConversationId: "sub-1" }, // missing agentName
		}));
		expect(readTeamPanel()?.drillDownAgent).toBeNull();

		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true,
			drillDownAgent: { agentName: "x" }, // missing subConversationId
		}));
		expect(readTeamPanel()?.drillDownAgent).toBeNull();
	});

	test("turnIndex is undefined when missing or non-numeric", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true,
			drillDownAgent: { subConversationId: "s", agentName: "a" },
		}));
		expect(readTeamPanel()?.drillDownAgent?.turnIndex).toBeUndefined();

		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true,
			drillDownAgent: { subConversationId: "s", agentName: "a", turnIndex: "5" },
		}));
		expect(readTeamPanel()?.drillDownAgent?.turnIndex).toBeUndefined();
	});

	test("turnIndex preserved when numeric", () => {
		storage.set("ezcorp-panel-team", JSON.stringify({
			open: true,
			drillDownAgent: { subConversationId: "s", agentName: "a", turnIndex: 7 },
		}));
		expect(readTeamPanel()?.drillDownAgent?.turnIndex).toBe(7);
	});
});

describe("writeTeamPanel", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("persists the state under ezcorp-panel-team", () => {
		writeTeamPanel(FULL_TEAM_STATE);
		expect(JSON.parse(storage.get("ezcorp-panel-team")!)).toEqual(FULL_TEAM_STATE);
	});

	test("overwrites previous value", () => {
		writeTeamPanel({ ...FULL_TEAM_STATE, open: true });
		writeTeamPanel({ ...FULL_TEAM_STATE, open: false });
		const round = readTeamPanel();
		expect(round?.open).toBe(false);
	});

	test("round-trips through readTeamPanel for the full shape", () => {
		writeTeamPanel(FULL_TEAM_STATE);
		expect(readTeamPanel()).toEqual(FULL_TEAM_STATE);
	});

	test("round-trips a closed/empty state", () => {
		const closed: TeamPanelState = {
			open: false,
			agentConfigId: null,
			teamName: null,
			conversationId: null,
			drillDownAgent: null,
		};
		writeTeamPanel(closed);
		expect(readTeamPanel()).toEqual(closed);
	});
});

// ─────────────────────────────────────────────
// readChatPanels / writeChatPanels
// ─────────────────────────────────────────────

describe("readChatPanels", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("returns null when nothing stored for the conversation", () => {
		expect(readChatPanels("conv-A")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		storage.set("ezcorp-panel-chat:conv-A", "not-json");
		expect(readChatPanels("conv-A")).toBeNull();
	});

	test("scopes per-conversation: A's state does not leak to B", () => {
		writeChatPanels("conv-A", DEFAULT_CHAT_STATE);
		expect(readChatPanels("conv-A")).toEqual(DEFAULT_CHAT_STATE);
		expect(readChatPanels("conv-B")).toBeNull();
	});

	test("returns full shape with defaults filled in for missing fields", () => {
		storage.set("ezcorp-panel-chat:conv-A", JSON.stringify({ obsOpen: true }));
		expect(readChatPanels("conv-A")).toEqual({
			obsOpen: true,
			diffPanelOpen: false,
			taskLogsOpen: false,
			taskLogsTaskId: null,
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: null,
		});
	});

	test("ignores extra unknown fields", () => {
		storage.set("ezcorp-panel-chat:conv-A", JSON.stringify({
			...DEFAULT_CHAT_STATE,
			somethingExtra: 42,
			ignored: { nested: true },
		}));
		expect(readChatPanels("conv-A")).toEqual(DEFAULT_CHAT_STATE);
	});

	test("coerces non-boolean booleans to defaults", () => {
		storage.set("ezcorp-panel-chat:conv-A", JSON.stringify({
			obsOpen: "true", // string, not bool
			diffPanelOpen: 1, // number, not bool
		}));
		const got = readChatPanels("conv-A");
		expect(got?.obsOpen).toBe(false);
		expect(got?.diffPanelOpen).toBe(false);
	});
});

describe("writeChatPanels", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("persists under conversation-scoped key", () => {
		writeChatPanels("conv-XYZ", DEFAULT_CHAT_STATE);
		expect(storage.has("ezcorp-panel-chat:conv-XYZ")).toBe(true);
	});

	test("round-trips full state", () => {
		writeChatPanels("conv-1", DEFAULT_CHAT_STATE);
		expect(readChatPanels("conv-1")).toEqual(DEFAULT_CHAT_STATE);
	});

	test("two conversations are independent", () => {
		const stateA: ChatPanelState = { ...DEFAULT_CHAT_STATE, obsOpen: true, diffPanelOpen: false };
		const stateB: ChatPanelState = { ...DEFAULT_CHAT_STATE, obsOpen: false, diffPanelOpen: true };
		writeChatPanels("A", stateA);
		writeChatPanels("B", stateB);
		expect(readChatPanels("A")?.obsOpen).toBe(true);
		expect(readChatPanels("A")?.diffPanelOpen).toBe(false);
		expect(readChatPanels("B")?.obsOpen).toBe(false);
		expect(readChatPanels("B")?.diffPanelOpen).toBe(true);
	});
});

// ─────────────────────────────────────────────
// readScroll / writeScroll
// ─────────────────────────────────────────────

describe("readScroll", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("returns null when nothing stored", () => {
		expect(readScroll("team:conv-1")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		storage.set("ezcorp-panel-scroll:team:conv-1", "not-json");
		expect(readScroll("team:conv-1")).toBeNull();
	});

	test("returns timeline + drill numbers when present", () => {
		writeScroll("team:conv-1", { timeline: 250, drill: 80 });
		expect(readScroll("team:conv-1")).toEqual({ timeline: 250, drill: 80 });
	});

	test("partial scroll (only timeline)", () => {
		writeScroll("team:conv-1", { timeline: 100 });
		expect(readScroll("team:conv-1")).toEqual({ timeline: 100 });
	});

	test("ignores non-numeric values", () => {
		storage.set("ezcorp-panel-scroll:team:conv-1", JSON.stringify({
			timeline: "100",
			drill: null,
		}));
		expect(readScroll("team:conv-1")).toEqual({});
	});

	test("scroll keys are independent per scope key", () => {
		writeScroll("team:conv-A", { timeline: 1 });
		writeScroll("team:conv-B", { timeline: 2 });
		expect(readScroll("team:conv-A")?.timeline).toBe(1);
		expect(readScroll("team:conv-B")?.timeline).toBe(2);
	});
});

describe("writeScroll", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("overwrites previous scroll", () => {
		writeScroll("team:conv-1", { timeline: 100, drill: 50 });
		writeScroll("team:conv-1", { timeline: 999 });
		expect(readScroll("team:conv-1")).toEqual({ timeline: 999 });
	});
});

// ─────────────────────────────────────────────
// readExpandedTools / writeExpandedTools
// ─────────────────────────────────────────────

describe("readExpandedTools", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("returns empty array when nothing stored", () => {
		expect(readExpandedTools("conv-1")).toEqual([]);
	});

	test("returns empty array when malformed", () => {
		storage.set("ezcorp-panel-team-expanded:conv-1", "not-json");
		expect(readExpandedTools("conv-1")).toEqual([]);
	});

	test("returns empty array when stored value is not an array", () => {
		storage.set("ezcorp-panel-team-expanded:conv-1", JSON.stringify({ tool: "x" }));
		expect(readExpandedTools("conv-1")).toEqual([]);
	});

	test("filters out non-string entries", () => {
		storage.set("ezcorp-panel-team-expanded:conv-1", JSON.stringify(["good", 1, null, "also-good"]));
		expect(readExpandedTools("conv-1")).toEqual(["good", "also-good"]);
	});

	test("round-trips via writeExpandedTools", () => {
		writeExpandedTools("conv-1", ["tool-a", "tool-b", "tool-c"]);
		expect(readExpandedTools("conv-1")).toEqual(["tool-a", "tool-b", "tool-c"]);
	});

	test("empty array round-trips as empty", () => {
		writeExpandedTools("conv-1", []);
		expect(readExpandedTools("conv-1")).toEqual([]);
	});

	test("scoped per conversation", () => {
		writeExpandedTools("conv-A", ["tool-a"]);
		writeExpandedTools("conv-B", ["tool-b"]);
		expect(readExpandedTools("conv-A")).toEqual(["tool-a"]);
		expect(readExpandedTools("conv-B")).toEqual(["tool-b"]);
	});
});

// ─────────────────────────────────────────────
// readExtPanel / writeExtPanel
// ─────────────────────────────────────────────

describe("readExtPanel / writeExtPanel", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("returns null when nothing stored", () => {
		expect(readExtPanel("conv-1", "ext-foo")).toBeNull();
	});

	test("returns null for malformed JSON", () => {
		storage.set("ezcorp-panel-ext:conv-1:ext-foo", "{");
		expect(readExtPanel("conv-1", "ext-foo")).toBeNull();
	});

	test("returns null when 'expanded' is missing or wrong type", () => {
		storage.set("ezcorp-panel-ext:conv-1:ext-foo", JSON.stringify({}));
		expect(readExtPanel("conv-1", "ext-foo")).toBeNull();
		storage.set("ezcorp-panel-ext:conv-1:ext-foo", JSON.stringify({ expanded: "yes" }));
		expect(readExtPanel("conv-1", "ext-foo")).toBeNull();
	});

	test("round-trips expanded=true", () => {
		writeExtPanel("conv-1", "ext-foo", { expanded: true });
		expect(readExtPanel("conv-1", "ext-foo")).toEqual({ expanded: true });
	});

	test("round-trips expanded=false", () => {
		writeExtPanel("conv-1", "ext-foo", { expanded: false });
		expect(readExtPanel("conv-1", "ext-foo")).toEqual({ expanded: false });
	});

	test("scoped per (conversation, extension) pair", () => {
		writeExtPanel("conv-A", "ext-1", { expanded: true });
		writeExtPanel("conv-A", "ext-2", { expanded: false });
		writeExtPanel("conv-B", "ext-1", { expanded: false });
		expect(readExtPanel("conv-A", "ext-1")?.expanded).toBe(true);
		expect(readExtPanel("conv-A", "ext-2")?.expanded).toBe(false);
		expect(readExtPanel("conv-B", "ext-1")?.expanded).toBe(false);
		expect(readExtPanel("conv-B", "ext-2")).toBeNull();
	});
});

// ─────────────────────────────────────────────
// SSR safety (no localStorage)
// ─────────────────────────────────────────────

describe("SSR safety (no localStorage)", () => {
	beforeEach(teardownStorage);
	afterEach(teardownStorage);

	test("all reads return null/empty", () => {
		expect(readTeamPanel()).toBeNull();
		expect(readChatPanels("conv-1")).toBeNull();
		expect(readScroll("k")).toBeNull();
		expect(readExpandedTools("conv-1")).toEqual([]);
		expect(readExtPanel("conv-1", "ext")).toBeNull();
	});

	test("all writes are no-ops, no throws", () => {
		expect(() => writeTeamPanel(FULL_TEAM_STATE)).not.toThrow();
		expect(() => writeChatPanels("c", DEFAULT_CHAT_STATE)).not.toThrow();
		expect(() => writeScroll("k", { timeline: 1 })).not.toThrow();
		expect(() => writeExpandedTools("c", ["t"])).not.toThrow();
		expect(() => writeExtPanel("c", "e", { expanded: true })).not.toThrow();
	});
});

// ─────────────────────────────────────────────
// Storage failure handling (quota / disabled)
// ─────────────────────────────────────────────

describe("storage write failure", () => {
	afterEach(teardownStorage);

	test("writeTeamPanel swallows quota errors", () => {
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: () => null,
			setItem: () => { throw new Error("QuotaExceeded"); },
			removeItem: () => {},
			key: () => null,
			clear: () => {},
			length: 0,
		} as Storage;
		expect(() => writeTeamPanel(FULL_TEAM_STATE)).not.toThrow();
	});

	test("writeChatPanels swallows quota errors", () => {
		(globalThis as { localStorage?: unknown }).localStorage = {
			getItem: () => null,
			setItem: () => { throw new Error("QuotaExceeded"); },
			removeItem: () => {},
			key: () => null,
			clear: () => {},
			length: 0,
		} as Storage;
		expect(() => writeChatPanels("c", DEFAULT_CHAT_STATE)).not.toThrow();
	});
});

// ─────────────────────────────────────────────
// Key namespace isolation
// ─────────────────────────────────────────────

describe("key namespace", () => {
	beforeEach(setupStorage);
	afterEach(teardownStorage);

	test("all keys live under the ezcorp-panel-* prefix", () => {
		writeTeamPanel(FULL_TEAM_STATE);
		writeChatPanels("c-1", DEFAULT_CHAT_STATE);
		writeScroll("team:c-1", { timeline: 10 });
		writeExpandedTools("c-1", ["t"]);
		writeExtPanel("c-1", "ext-1", { expanded: true });

		const keys = [...storage.keys()];
		expect(keys.length).toBe(5);
		for (const k of keys) {
			expect(k.startsWith("ezcorp-panel-")).toBe(true);
		}
	});

	test("the same conversation id under different helpers does not collide", () => {
		writeChatPanels("conv-1", DEFAULT_CHAT_STATE);
		writeExpandedTools("conv-1", ["t-1"]);
		writeScroll("team:conv-1", { timeline: 99 });
		// All three coexist — verify each round-trips independently.
		expect(readChatPanels("conv-1")).toEqual(DEFAULT_CHAT_STATE);
		expect(readExpandedTools("conv-1")).toEqual(["t-1"]);
		expect(readScroll("team:conv-1")?.timeline).toBe(99);
	});
});
