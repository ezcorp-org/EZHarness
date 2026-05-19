/**
 * Unit tests for the panel-persistence orchestration extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W4 of the chat-page
 * split).
 *
 * The orchestration is exposed as three plain functions
 * (`restorePanelsForConv`, `resolvePendingAgent`, `persistPanelSnapshot`)
 * plus a `attachPanelPersistence` rune-host wrapper. We test the inner
 * functions directly so the suite doesn't have to stand up a Svelte
 * effect scope — that's the simplification the spec explicitly allows.
 *
 * `panel-persistence.ts` (the underlying read/write helpers) is mocked
 * so we can assert exact calls without touching `localStorage`.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import type {
	AgentCallState,
	AssignmentStatus,
	TaskPanelTask,
	TaskSnapshot,
} from "$lib/stores.svelte.js";
import type { SubConvoRecord } from "$lib/sub-convo-agent-state.js";

// ── Mocks ────────────────────────────────────────────────────────────────

const readChatPanelsMock = mock(
	(_convId: string) => null as ReturnType<typeof import("$lib/panel-persistence.js")["readChatPanels"]>,
);
const writeChatPanelsMock = mock(
	(_convId: string, _state: Record<string, unknown>) => {},
);

mock.module("$lib/panel-persistence.js", () => ({
	readChatPanels: readChatPanelsMock,
	writeChatPanels: writeChatPanelsMock,
}));

afterAll(() => mock.restore());

// Now safe to import the SUT.
const {
	restorePanelsForConv,
	resolvePendingAgent,
	persistPanelSnapshot,
} = await import("../panel-persistence.svelte.ts");
type PanelPersistenceHost = import("../panel-persistence.svelte.ts").PanelPersistenceHost;

// ── Helpers ──────────────────────────────────────────────────────────────

interface HostState {
	convId: string;
	searchParams: URLSearchParams;
	settingsOpen: boolean;
	obsOpen: boolean;
	diffPanelOpen: boolean;
	toolsOpen: boolean;
	taskLogsOpen: boolean;
	taskLogsTask: TaskPanelTask | null;
	agentDetailId: string | null;
	selectedAgent: AgentCallState | null;
	taskSnapshot: TaskSnapshot | null;
	subConversations: SubConvoRecord[];
	assignments: Map<string, { status: AssignmentStatus; resultPreview?: string }>;
	streamingAgentCalls: Record<string, AgentCallState[]>;
	convSwitchCount: number;
}

function makeHost(initial: Partial<HostState> = {}): {
	host: PanelPersistenceHost;
	state: HostState;
} {
	const state: HostState = {
		convId: "conv-1",
		searchParams: new URLSearchParams(),
		settingsOpen: false,
		obsOpen: false,
		diffPanelOpen: false,
		toolsOpen: false,
		taskLogsOpen: false,
		taskLogsTask: null,
		agentDetailId: null,
		selectedAgent: null,
		taskSnapshot: null,
		subConversations: [],
		assignments: new Map(),
		streamingAgentCalls: {},
		convSwitchCount: 0,
		...initial,
	};
	const host: PanelPersistenceHost = {
		convId: () => state.convId,
		searchParams: () => state.searchParams,
		settingsOpen: { get: () => state.settingsOpen, set: (v) => { state.settingsOpen = v; } },
		obsOpen: { get: () => state.obsOpen, set: (v) => { state.obsOpen = v; } },
		diffPanelOpen: { get: () => state.diffPanelOpen, set: (v) => { state.diffPanelOpen = v; } },
		toolsOpen: { get: () => state.toolsOpen, set: (v) => { state.toolsOpen = v; } },
		taskLogsOpen: { get: () => state.taskLogsOpen, set: (v) => { state.taskLogsOpen = v; } },
		taskLogsTask: { get: () => state.taskLogsTask, set: (v) => { state.taskLogsTask = v; } },
		agentDetailId: { get: () => state.agentDetailId, set: (v) => { state.agentDetailId = v; } },
		selectedAgent: { get: () => state.selectedAgent, set: (v) => { state.selectedAgent = v; } },
		taskSnapshot: () => state.taskSnapshot,
		subConversations: () => state.subConversations,
		assignmentForSubConvo: (id) => state.assignments.get(id),
		streamingAgentCalls: () => state.streamingAgentCalls,
		onConvSwitch: () => { state.convSwitchCount += 1; },
	};
	return { host, state };
}

function makeTask(id: string): TaskPanelTask {
	return {
		id,
		title: `task ${id}`,
		description: "",
		status: "active",
		subtasks: [],
		assignments: [],
		createdAt: "2024-01-01T00:00:00.000Z",
		priority: 0,
	};
}

function makeAgentCall(subConversationId: string, overrides: Partial<AgentCallState> = {}): AgentCallState {
	return {
		subConversationId,
		agentName: "agent",
		agentConfigId: "cfg-1",
		task: "",
		status: "running",
		startedAt: 0,
		...overrides,
	};
}

beforeEach(() => {
	readChatPanelsMock.mockReset();
	readChatPanelsMock.mockImplementation(() => null);
	writeChatPanelsMock.mockReset();
});

// ── restorePanelsForConv ─────────────────────────────────────────────────

describe("restorePanelsForConv", () => {
	test("no-ops when convId is empty", () => {
		const { host, state } = makeHost({ convId: "" });
		const next = restorePanelsForConv(host, null);
		expect(next).toBeNull();
		expect(readChatPanelsMock).not.toHaveBeenCalled();
		expect(state.convSwitchCount).toBe(0);
	});

	test("no-ops when already restored for the current convId", () => {
		const { host, state } = makeHost({ convId: "conv-1" });
		const next = restorePanelsForConv(host, "conv-1");
		expect(next).toBe("conv-1");
		expect(readChatPanelsMock).not.toHaveBeenCalled();
		expect(state.convSwitchCount).toBe(0);
	});

	test("restores from saved snapshot — pushes booleans into host setters", () => {
		readChatPanelsMock.mockImplementationOnce(() => ({
			obsOpen: false,
			diffPanelOpen: true,
			taskLogsOpen: false,
			taskLogsTaskId: null,
			toolsOpen: true,
			settingsOpen: true,
			selectedAgentSubConvId: null,
		}));
		const { host, state } = makeHost({ convId: "conv-A" });
		const next = restorePanelsForConv(host, null);

		expect(next).toBe("conv-A");
		expect(readChatPanelsMock).toHaveBeenCalledWith("conv-A");
		// onConvSwitch fires exactly once.
		expect(state.convSwitchCount).toBe(1);
		// Slots reflect the saved snapshot.
		expect(state.settingsOpen).toBe(true);
		expect(state.obsOpen).toBe(false);
		expect(state.diffPanelOpen).toBe(true);
		expect(state.toolsOpen).toBe(true);
		// taskLogsOpen stays false because `taskLogsTaskId` is null.
		expect(state.taskLogsOpen).toBe(false);
		expect(state.taskLogsTask).toBeNull();
		// No deep link pending.
		expect(state.agentDetailId).toBeNull();
	});

	test("restores taskLogs only when a matching task exists in the snapshot", () => {
		const t = makeTask("task-7");
		readChatPanelsMock.mockImplementationOnce(() => ({
			obsOpen: false,
			diffPanelOpen: false,
			taskLogsOpen: true,
			taskLogsTaskId: "task-7",
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: null,
		}));
		const { host, state } = makeHost({
			convId: "conv-B",
			taskSnapshot: { conversationId: "conv-B", tasks: [t] },
		});
		restorePanelsForConv(host, null);

		expect(state.taskLogsOpen).toBe(true);
		expect(state.taskLogsTask).toBe(t);
	});

	test("does NOT restore taskLogs when the saved task is no longer in the snapshot", () => {
		readChatPanelsMock.mockImplementationOnce(() => ({
			obsOpen: false,
			diffPanelOpen: false,
			taskLogsOpen: true,
			taskLogsTaskId: "task-missing",
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: null,
		}));
		const { host, state } = makeHost({
			convId: "conv-C",
			taskSnapshot: { conversationId: "conv-C", tasks: [makeTask("task-other")] },
		});
		restorePanelsForConv(host, null);

		expect(state.taskLogsOpen).toBe(false);
		expect(state.taskLogsTask).toBeNull();
	});

	test("seeds agentDetailId from saved selectedAgentSubConvId", () => {
		readChatPanelsMock.mockImplementationOnce(() => ({
			obsOpen: false,
			diffPanelOpen: false,
			taskLogsOpen: false,
			taskLogsTaskId: null,
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: "sub-77",
		}));
		const { host, state } = makeHost({ convId: "conv-D" });
		restorePanelsForConv(host, null);
		expect(state.agentDetailId).toBe("sub-77");
	});

	test("clears all panel-open flags + taskLogs + selectedAgent when no snapshot exists", () => {
		const { host, state } = makeHost({
			convId: "conv-fresh",
			settingsOpen: true,
			obsOpen: true,
			diffPanelOpen: true,
			toolsOpen: true,
			taskLogsOpen: true,
			taskLogsTask: makeTask("leftover"),
			selectedAgent: makeAgentCall("leftover"),
			agentDetailId: "leftover",
		});
		restorePanelsForConv(host, null);

		expect(state.settingsOpen).toBe(false);
		expect(state.obsOpen).toBe(false);
		expect(state.diffPanelOpen).toBe(false);
		expect(state.toolsOpen).toBe(false);
		expect(state.taskLogsOpen).toBe(false);
		expect(state.taskLogsTask).toBeNull();
		expect(state.selectedAgent).toBeNull();
		expect(state.agentDetailId).toBeNull();
	});

	test("`?agent=<id>` deep-link overrides any persisted selectedAgentSubConvId", () => {
		readChatPanelsMock.mockImplementationOnce(() => ({
			obsOpen: false,
			diffPanelOpen: false,
			taskLogsOpen: false,
			taskLogsTaskId: null,
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: "sub-from-storage",
		}));
		const { host, state } = makeHost({
			convId: "conv-E",
			searchParams: new URLSearchParams("agent=sub-from-url"),
		});
		restorePanelsForConv(host, null);
		expect(state.agentDetailId).toBe("sub-from-url");
	});

	test("`?agent=<id>` deep-link works even when no snapshot exists", () => {
		const { host, state } = makeHost({
			convId: "conv-F",
			searchParams: new URLSearchParams("agent=fresh-link"),
		});
		restorePanelsForConv(host, null);
		expect(state.agentDetailId).toBe("fresh-link");
	});

	test("re-restores when convId changes (different from lastRestoredFor)", () => {
		readChatPanelsMock.mockImplementation((id: string) => ({
			obsOpen: id === "conv-2",
			diffPanelOpen: false,
			taskLogsOpen: false,
			taskLogsTaskId: null,
			toolsOpen: false,
			settingsOpen: false,
			selectedAgentSubConvId: null,
		}));
		const { host, state } = makeHost({ convId: "conv-2" });
		const next = restorePanelsForConv(host, "conv-1");
		expect(next).toBe("conv-2");
		expect(state.obsOpen).toBe(true);
		expect(state.convSwitchCount).toBe(1);
	});
});

// ── resolvePendingAgent ──────────────────────────────────────────────────

describe("resolvePendingAgent", () => {
	test("no-ops when agentDetailId is null", () => {
		const { host, state } = makeHost();
		resolvePendingAgent(host);
		expect(state.selectedAgent).toBeNull();
	});

	test("binds from streamingAgentCalls when a matching subConversationId exists", () => {
		const found = makeAgentCall("sub-A", { agentName: "alpha" });
		const { host, state } = makeHost({
			agentDetailId: "sub-A",
			streamingAgentCalls: {
				"run-1": [makeAgentCall("sub-other"), found],
			},
		});
		resolvePendingAgent(host);
		expect(state.selectedAgent).toBe(found);
		expect(state.agentDetailId).toBeNull();
	});

	test("falls back to subConversations + assignment when no streaming match", () => {
		const sc: SubConvoRecord = {
			id: "sub-B",
			parentMessageId: "msg-1",
			agentConfigId: "agent-cfg-1",
			agentName: "beta",
			messageCount: 1,
		};
		const assignmentEntry = { status: "running" as AssignmentStatus, resultPreview: "wip" };
		const { host, state } = makeHost({
			agentDetailId: "sub-B",
			subConversations: [sc],
			assignments: new Map([["sub-B", assignmentEntry]]),
		});
		resolvePendingAgent(host);
		expect(state.selectedAgent).not.toBeNull();
		expect(state.selectedAgent?.subConversationId).toBe("sub-B");
		expect(state.agentDetailId).toBeNull();
	});

	test("leaves agentDetailId pending when neither streaming nor sub-convos contain it", () => {
		const elsewhere: SubConvoRecord = {
			id: "sub-elsewhere",
			agentName: "elsewhere",
			agentConfigId: "cfg",
			parentMessageId: "msg",
		};
		const { host, state } = makeHost({
			agentDetailId: "sub-missing",
			streamingAgentCalls: { "run-1": [makeAgentCall("sub-other")] },
			subConversations: [elsewhere],
		});
		resolvePendingAgent(host);
		expect(state.selectedAgent).toBeNull();
		expect(state.agentDetailId).toBe("sub-missing");
	});

	test("prefers streaming match over sub-convo fallback", () => {
		const streamingHit = makeAgentCall("sub-X", { agentName: "live" });
		const stale: SubConvoRecord = {
			id: "sub-X",
			agentName: "stale",
			agentConfigId: "cfg",
			parentMessageId: "msg",
		};
		const { host, state } = makeHost({
			agentDetailId: "sub-X",
			streamingAgentCalls: { "run-1": [streamingHit] },
			subConversations: [stale],
		});
		resolvePendingAgent(host);
		expect(state.selectedAgent).toBe(streamingHit);
	});
});

// ── persistPanelSnapshot ─────────────────────────────────────────────────

describe("persistPanelSnapshot", () => {
	test("writes the current snapshot under the active convId", () => {
		const t = makeTask("task-z");
		const agent = makeAgentCall("sub-saved");
		const { host } = makeHost({
			convId: "conv-write",
			obsOpen: false,
			diffPanelOpen: true,
			taskLogsOpen: true,
			taskLogsTask: t,
			toolsOpen: true,
			settingsOpen: false,
			selectedAgent: agent,
		});
		persistPanelSnapshot(host);

		expect(writeChatPanelsMock).toHaveBeenCalledTimes(1);
		const [convId, snapshot] = writeChatPanelsMock.mock.calls[0]!;
		expect(convId).toBe("conv-write");
		expect(snapshot).toEqual({
			obsOpen: false,
			diffPanelOpen: true,
			taskLogsOpen: true,
			taskLogsTaskId: "task-z",
			toolsOpen: true,
			settingsOpen: false,
			selectedAgentSubConvId: "sub-saved",
		});
	});

	test("serializes nullable slots as null when unset", () => {
		const { host } = makeHost({ convId: "conv-empty" });
		persistPanelSnapshot(host);
		const [, snapshot] = writeChatPanelsMock.mock.calls[0]!;
		expect(snapshot).toMatchObject({
			taskLogsTaskId: null,
			selectedAgentSubConvId: null,
		});
	});

	test("re-reads slots on each call (so the persist effect always sees latest)", () => {
		const { host, state } = makeHost({ convId: "conv-tick" });
		persistPanelSnapshot(host);
		state.diffPanelOpen = true;
		state.settingsOpen = true;
		persistPanelSnapshot(host);

		expect(writeChatPanelsMock).toHaveBeenCalledTimes(2);
		expect(writeChatPanelsMock.mock.calls[0]![1]).toMatchObject({
			diffPanelOpen: false,
			settingsOpen: false,
		});
		expect(writeChatPanelsMock.mock.calls[1]![1]).toMatchObject({
			diffPanelOpen: true,
			settingsOpen: true,
		});
	});

	test("no-ops when convId is empty", () => {
		const { host } = makeHost({ convId: "" });
		persistPanelSnapshot(host);
		expect(writeChatPanelsMock).not.toHaveBeenCalled();
	});
});

// ── End-to-end (restore → persist round-trip) ───────────────────────────

describe("convo switch flow", () => {
	test("convId change re-restores with the new id's persisted state", () => {
		const persistedById: Record<string, ReturnType<typeof readChatPanelsMock>> = {
			"conv-1": {
				obsOpen: true,
				diffPanelOpen: false,
				taskLogsOpen: false,
				taskLogsTaskId: null,
				toolsOpen: false,
				settingsOpen: false,
				selectedAgentSubConvId: null,
			},
			"conv-2": {
				obsOpen: false,
				diffPanelOpen: true,
				taskLogsOpen: false,
				taskLogsTaskId: null,
				toolsOpen: true,
				settingsOpen: true,
				selectedAgentSubConvId: null,
			},
		};
		readChatPanelsMock.mockImplementation((id: string) => persistedById[id] ?? null);

		const { host, state } = makeHost({ convId: "conv-1" });
		let restoredFor: string | null = null;
		restoredFor = restorePanelsForConv(host, restoredFor);
		expect(restoredFor).toBe("conv-1");
		expect(state.obsOpen).toBe(true);

		// Simulate convId switch.
		state.convId = "conv-2";
		restoredFor = restorePanelsForConv(host, restoredFor);
		expect(restoredFor).toBe("conv-2");
		expect(state.obsOpen).toBe(false);
		expect(state.diffPanelOpen).toBe(true);
		expect(state.toolsOpen).toBe(true);
		expect(state.settingsOpen).toBe(true);
		// onConvSwitch ran once per transition.
		expect(state.convSwitchCount).toBe(2);
	});
});
