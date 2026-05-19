import { test, expect, describe, beforeEach } from "bun:test";
import {
	ContentBlockBuilder,
	buildHistoricalBlocks,
	type ContentBlock,
} from "../lib/content-blocks";

// ── Pure logic extracted from stores.svelte.ts and chat page ─────────────────
//
// The store event handlers are imperative mutations on arrays. We extract the
// same logic into pure functions so we can unit-test them without Svelte runtime.

interface AgentCallState {
	subConversationId: string;
	agentName: string;
	agentConfigId: string;
	task: string;
	status: "running" | "complete" | "error";
	statusText?: string;
	resultPreview?: string;
	agentRunId?: string;
	startedAt: number;
}

/** Mirrors `case "agent:spawn"` in stores.svelte.ts */
function applyAgentSpawn(
	existing: AgentCallState[],
	data: {
		subConversationId: string;
		agentName: string;
		agentConfigId: string;
		task: string;
		agentRunId: string;
	},
): AgentCallState[] {
	return [
		...existing,
		{
			subConversationId: data.subConversationId,
			agentName: data.agentName,
			agentConfigId: data.agentConfigId,
			task: data.task,
			status: "running",
			agentRunId: data.agentRunId,
			startedAt: Date.now(),
		},
	];
}

/** Mirrors `case "agent:status"` in stores.svelte.ts */
function applyAgentStatus(
	agents: AgentCallState[],
	subConversationId: string,
	status: string,
): AgentCallState[] {
	return agents.map((a) =>
		a.subConversationId === subConversationId
			? { ...a, statusText: status }
			: a,
	);
}

/** Mirrors `case "agent:complete"` in stores.svelte.ts */
function applyAgentComplete(
	agents: AgentCallState[],
	subConversationId: string,
	success: boolean,
	resultPreview: string,
): AgentCallState[] {
	return agents.map((a) =>
		a.subConversationId === subConversationId
			? {
					...a,
					status: success ? ("complete" as const) : ("error" as const),
					resultPreview,
				}
			: a,
	);
}

// ── getHistoricalAgentCalls (from chat page) ─────────────────────────────────

interface SubConvoRecord {
	id: string;
	agentName: string;
	agentConfigId: string;
	parentMessageId: string;
}

/** Mirrors getHistoricalAgentCalls in +page.svelte */
function getHistoricalAgentCalls(
	messageId: string,
	subConversations: SubConvoRecord[],
): AgentCallState[] | undefined {
	const agentSubConvos = subConversations.filter(
		(sc) => sc.parentMessageId === messageId && sc.agentConfigId,
	);
	if (agentSubConvos.length === 0) return undefined;
	return agentSubConvos.map((sc) => ({
		subConversationId: sc.id,
		agentName: sc.agentName,
		agentConfigId: sc.agentConfigId,
		task: "",
		status: "complete" as const,
		startedAt: 0,
	}));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ContentBlockBuilder with agent refs", () => {
	let builder: ContentBlockBuilder;

	beforeEach(() => {
		builder = new ContentBlockBuilder();
	});

	test("pushAgentRef returns incrementing indices starting from 0", () => {
		expect(builder.pushAgentRef()).toBe(0);
		expect(builder.pushAgentRef()).toBe(1);
		expect(builder.pushAgentRef()).toBe(2);
	});

	test("pushAgentRef inserts agent_ref block into blocks array", () => {
		builder.pushAgentRef();
		expect(builder.blocks).toEqual([{ type: "agent_ref", agentIndex: 0 }]);
	});

	test("agent refs and tool refs have independent indices", () => {
		const toolIdx0 = builder.pushToolRef();
		const agentIdx0 = builder.pushAgentRef();
		const toolIdx1 = builder.pushToolRef();

		expect(toolIdx0).toBe(0);
		expect(agentIdx0).toBe(0);
		expect(toolIdx1).toBe(1);

		expect(builder.blocks).toEqual([
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "agent_ref", agentIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
		]);
	});

	test("reset clears both tool and agent indices", () => {
		builder.pushToolRef();
		builder.pushAgentRef();
		builder.appendText("some text");
		builder.reset();

		expect(builder.blocks).toEqual([]);

		// After reset, indices start from 0 again
		expect(builder.pushToolRef()).toBe(0);
		expect(builder.pushAgentRef()).toBe(0);
	});

	test("snapshot preserves agent_ref blocks", () => {
		builder.appendText("hello");
		builder.pushAgentRef();
		builder.appendText("world");

		const snap = builder.snapshot();
		expect(snap).toEqual([
			{ type: "text", content: "hello" },
			{ type: "agent_ref", agentIndex: 0 },
			{ type: "text", content: "world" },
		]);

		// Snapshot is a copy — mutating original doesn't affect it
		builder.appendText(" more");
		expect(snap[2]).toEqual({ type: "text", content: "world" });
	});
});

describe("buildHistoricalBlocks with agents", () => {
	test("returns text + tool_refs + agent_refs in correct order", () => {
		const blocks = buildHistoricalBlocks("hello", 2, 1);
		expect(blocks).toEqual([
			{ type: "text", content: "hello" },
			{ type: "tool_ref", toolIndex: 0 },
			{ type: "tool_ref", toolIndex: 1 },
			{ type: "agent_ref", agentIndex: 0 },
		]);
	});

	test("returns only text when no tools or agents", () => {
		const blocks = buildHistoricalBlocks("hello", 0, 0);
		expect(blocks).toEqual([{ type: "text", content: "hello" }]);
	});

	test("returns only agent_refs when no tools but agents present", () => {
		const blocks = buildHistoricalBlocks("hello", 0, 2);
		expect(blocks).toEqual([
			{ type: "text", content: "hello" },
			{ type: "agent_ref", agentIndex: 0 },
			{ type: "agent_ref", agentIndex: 1 },
		]);
	});

	test("handles zero agentCallCount (backwards compat)", () => {
		const blocks = buildHistoricalBlocks("hello", 1);
		expect(blocks).toEqual([
			{ type: "text", content: "hello" },
			{ type: "tool_ref", toolIndex: 0 },
		]);
	});

	test("returns empty array when text is empty and no tools or agents", () => {
		const blocks = buildHistoricalBlocks("", 0, 0);
		expect(blocks).toEqual([]);
	});

	test("omits text block when text is empty but has agent refs", () => {
		const blocks = buildHistoricalBlocks("", 0, 1);
		expect(blocks).toEqual([{ type: "agent_ref", agentIndex: 0 }]);
	});
});

describe("AgentCallState lifecycle helpers", () => {
	test("applyAgentSpawn creates AgentCallState with status 'running'", () => {
		const result = applyAgentSpawn([], {
			subConversationId: "sub-1",
			agentName: "researcher",
			agentConfigId: "cfg-1",
			task: "Find relevant papers",
			agentRunId: "run-1",
		});

		expect(result).toHaveLength(1);
		expect(result[0]!.status).toBe("running");
		expect(result[0]!.agentName).toBe("researcher");
		expect(result[0]!.task).toBe("Find relevant papers");
		expect(result[0]!.subConversationId).toBe("sub-1");
		expect(result[0]!.agentRunId).toBe("run-1");
		expect(result[0]!.startedAt).toBeGreaterThan(0);
	});

	test("applyAgentStatus updates statusText on matching subConversationId", () => {
		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
		];

		const result = applyAgentStatus(agents, "sub-1", "Searching databases...");
		expect(result[0]!.statusText).toBe("Searching databases...");
		expect(result[0]!.status).toBe("running");
	});

	test("applyAgentStatus ignores non-matching subConversationId", () => {
		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
		];

		const result = applyAgentStatus(agents, "sub-999", "New status");
		expect(result[0]!.statusText).toBeUndefined();
	});

	test("applyAgentComplete sets status to 'complete' and resultPreview on success", () => {
		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
		];

		const result = applyAgentComplete(
			agents,
			"sub-1",
			true,
			"Found 5 relevant papers",
		);
		expect(result[0]!.status).toBe("complete");
		expect(result[0]!.resultPreview).toBe("Found 5 relevant papers");
	});

	test("applyAgentComplete sets status to 'error' on failure", () => {
		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
		];

		const result = applyAgentComplete(
			agents,
			"sub-1",
			false,
			"Connection timeout",
		);
		expect(result[0]!.status).toBe("error");
		expect(result[0]!.resultPreview).toBe("Connection timeout");
	});

	test("applyAgentComplete only updates the matching agent", () => {
		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
			{
				subConversationId: "sub-2",
				agentName: "coder",
				agentConfigId: "cfg-2",
				task: "fix bug",
				status: "running",
				startedAt: 2000,
			},
		];

		const result = applyAgentComplete(agents, "sub-1", true, "Done");
		expect(result[0]!.status).toBe("complete");
		expect(result[1]!.status).toBe("running");
	});
});

describe("getHistoricalAgentCalls derivation", () => {
	test("returns undefined when no sub-conversations match the messageId", () => {
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				parentMessageId: "msg-other",
			},
		];
		expect(getHistoricalAgentCalls("msg-1", subConvos)).toBeUndefined();
	});

	test("returns AgentCallState array for sub-convos with agentConfigId on matching messageId", () => {
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				parentMessageId: "msg-1",
			},
			{
				id: "sub-2",
				agentName: "coder",
				agentConfigId: "cfg-2",
				parentMessageId: "msg-1",
			},
		];

		const result = getHistoricalAgentCalls("msg-1", subConvos);
		expect(result).toHaveLength(2);
		expect(result![0]!.agentName).toBe("researcher");
		expect(result![0]!.status).toBe("complete");
		expect(result![0]!.subConversationId).toBe("sub-1");
		expect(result![1]!.agentName).toBe("coder");
		expect(result![1]!.subConversationId).toBe("sub-2");
	});

	test("excludes sub-conversations without agentConfigId (user-initiated)", () => {
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				parentMessageId: "msg-1",
			},
			{
				id: "sub-2",
				agentName: "Helper",
				agentConfigId: "",
				parentMessageId: "msg-1",
			},
		];

		const result = getHistoricalAgentCalls("msg-1", subConvos);
		expect(result).toHaveLength(1);
		expect(result![0]!.agentName).toBe("researcher");
	});

	test("maps agentName and agentConfigId correctly", () => {
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-42",
				agentName: "code-reviewer",
				agentConfigId: "cfg-99",
				parentMessageId: "msg-5",
			},
		];

		const result = getHistoricalAgentCalls("msg-5", subConvos);
		expect(result).toHaveLength(1);
		expect(result![0]).toEqual({
			subConversationId: "sub-42",
			agentName: "code-reviewer",
			agentConfigId: "cfg-99",
			task: "",
			status: "complete",
			startedAt: 0,
		});
	});

	test("returns undefined when all matching sub-convos lack agentConfigId", () => {
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-1",
				agentName: "Helper",
				agentConfigId: "",
				parentMessageId: "msg-1",
			},
		];

		expect(getHistoricalAgentCalls("msg-1", subConvos)).toBeUndefined();
	});

	test("returns undefined for empty sub-conversations array", () => {
		expect(getHistoricalAgentCalls("msg-1", [])).toBeUndefined();
	});

	test("does NOT fall back to showing all agents on the last message (no orphan fallback)", () => {
		// Sub-convos with parentMessageId pointing to non-existent messages
		// should NOT appear on any other message
		const subConvos: SubConvoRecord[] = [
			{
				id: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				parentMessageId: "deleted-msg",
			},
			{
				id: "sub-2",
				agentName: "coder",
				agentConfigId: "cfg-2",
				parentMessageId: "deleted-msg-2",
			},
		];

		// Neither msg-1 nor msg-last should pick up these orphans
		expect(getHistoricalAgentCalls("msg-1", subConvos)).toBeUndefined();
		expect(getHistoricalAgentCalls("msg-last", subConvos)).toBeUndefined();
	});

	test("multiple team invocations: each message shows only its own agents", () => {
		// Simulates two separate team invocations in the same conversation
		const subConvos: SubConvoRecord[] = [
			// Team 1 agents — anchored to msg-a
			{ id: "sub-1", agentName: "researcher", agentConfigId: "cfg-1", parentMessageId: "msg-a" },
			{ id: "sub-2", agentName: "coder", agentConfigId: "cfg-2", parentMessageId: "msg-a" },
			// Team 2 agents — anchored to msg-b
			{ id: "sub-3", agentName: "reviewer", agentConfigId: "cfg-3", parentMessageId: "msg-b" },
		];

		const msgA = getHistoricalAgentCalls("msg-a", subConvos);
		expect(msgA).toHaveLength(2);
		expect(msgA!.map(a => a.agentName)).toEqual(["researcher", "coder"]);

		const msgB = getHistoricalAgentCalls("msg-b", subConvos);
		expect(msgB).toHaveLength(1);
		expect(msgB![0]!.agentName).toBe("reviewer");

		// A third message with no agents returns undefined
		expect(getHistoricalAgentCalls("msg-c", subConvos)).toBeUndefined();
	});

	test("same agent in multiple teams shows on correct messages independently", () => {
		// The same agent config used in two different team invocations
		const subConvos: SubConvoRecord[] = [
			{ id: "sub-1", agentName: "shared-agent", agentConfigId: "cfg-1", parentMessageId: "msg-a" },
			{ id: "sub-2", agentName: "shared-agent", agentConfigId: "cfg-1", parentMessageId: "msg-b" },
		];

		const msgA = getHistoricalAgentCalls("msg-a", subConvos);
		expect(msgA).toHaveLength(1);
		expect(msgA![0]!.subConversationId).toBe("sub-1");

		const msgB = getHistoricalAgentCalls("msg-b", subConvos);
		expect(msgB).toHaveLength(1);
		expect(msgB![0]!.subConversationId).toBe("sub-2");
	});
});

// ── turn_text_reset preserving agents ─────────────────────────────────────

/** Mirrors the turn_text_reset handler in stores.svelte.ts */
function applyTurnTextReset(
	builder: ContentBlockBuilder,
	existingAgents: AgentCallState[],
): { blocks: ContentBlock[]; streamingText: string; streamingToolCalls: any[] } {
	builder.reset();
	// Re-inject agent_ref blocks for agents spawned in previous turns
	for (let i = 0; i < existingAgents.length; i++) {
		builder.pushAgentRef();
	}
	return {
		blocks: builder.snapshot(),
		streamingText: "",
		streamingToolCalls: [],
	};
}

describe("turn_text_reset preserves agent calls", () => {
	test("resets streaming text and tool calls but preserves agent_ref blocks", () => {
		const builder = new ContentBlockBuilder();
		// Simulate turn 1: text + agent spawn + more text
		builder.appendText("Let me delegate this.");
		builder.pushAgentRef(); // agent 0
		builder.appendText("Working on it...");
		builder.pushToolRef(); // tool 0

		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "running",
				startedAt: 1000,
			},
		];

		const result = applyTurnTextReset(builder, agents);

		// Streaming text should be empty
		expect(result.streamingText).toBe("");
		// Tool calls should be empty
		expect(result.streamingToolCalls).toEqual([]);
		// Content blocks should have re-injected agent_ref(s)
		expect(result.blocks).toEqual([
			{ type: "agent_ref", agentIndex: 0 },
		]);
	});

	test("re-injects multiple agent_refs when multiple agents exist", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("text");
		builder.pushAgentRef();
		builder.pushAgentRef();

		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "complete",
				startedAt: 1000,
			},
			{
				subConversationId: "sub-2",
				agentName: "coder",
				agentConfigId: "cfg-2",
				task: "fix",
				status: "running",
				startedAt: 2000,
			},
		];

		const result = applyTurnTextReset(builder, agents);

		expect(result.blocks).toEqual([
			{ type: "agent_ref", agentIndex: 0 },
			{ type: "agent_ref", agentIndex: 1 },
		]);
	});

	test("produces empty blocks when no agents exist", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("some text");
		builder.pushToolRef();

		const result = applyTurnTextReset(builder, []);

		expect(result.blocks).toEqual([]);
		expect(result.streamingText).toBe("");
	});

	test("new text appended after reset follows re-injected agent_refs", () => {
		const builder = new ContentBlockBuilder();
		builder.appendText("turn 1 text");
		builder.pushAgentRef();

		const agents: AgentCallState[] = [
			{
				subConversationId: "sub-1",
				agentName: "researcher",
				agentConfigId: "cfg-1",
				task: "search",
				status: "complete",
				startedAt: 1000,
			},
		];

		applyTurnTextReset(builder, agents);

		// Simulate turn 2: new tokens start streaming
		builder.appendText("Based on the research,");

		expect(builder.snapshot()).toEqual([
			{ type: "agent_ref", agentIndex: 0 },
			{ type: "text", content: "Based on the research," },
		]);
	});
});

// ── AgentChip displayStatus derivation ────────────────────────────────────

/** Mirrors the displayStatus derived in AgentChip.svelte */
function deriveDisplayStatus(agent: AgentCallState): string {
	if (agent.status === "running") {
		return agent.statusText ?? "Working...";
	}
	if (agent.status === "error") {
		return "Failed";
	}
	// complete
	if (agent.resultPreview) {
		return agent.resultPreview.length > 60
			? agent.resultPreview.slice(0, 60) + "..."
			: agent.resultPreview;
	}
	return "Done";
}

describe("AgentChip displayStatus derivation", () => {
	test("shows 'Working...' for running agent with no custom statusText", () => {
		expect(
			deriveDisplayStatus({
				subConversationId: "sub-1",
				agentName: "r",
				agentConfigId: "c",
				task: "t",
				status: "running",
				startedAt: 0,
			}),
		).toBe("Working...");
	});

	test("shows custom statusText for running agent", () => {
		expect(
			deriveDisplayStatus({
				subConversationId: "sub-1",
				agentName: "r",
				agentConfigId: "c",
				task: "t",
				status: "running",
				statusText: "Searching databases...",
				startedAt: 0,
			}),
		).toBe("Searching databases...");
	});

	test("shows 'Failed' for error status", () => {
		expect(
			deriveDisplayStatus({
				subConversationId: "sub-1",
				agentName: "r",
				agentConfigId: "c",
				task: "t",
				status: "error",
				resultPreview: "Connection timeout",
				startedAt: 0,
			}),
		).toBe("Failed");
	});

	test("shows resultPreview for completed agent", () => {
		expect(
			deriveDisplayStatus({
				subConversationId: "sub-1",
				agentName: "r",
				agentConfigId: "c",
				task: "t",
				status: "complete",
				resultPreview: "Found 5 papers",
				startedAt: 0,
			}),
		).toBe("Found 5 papers");
	});

	test("truncates long resultPreview to 60 chars with ellipsis", () => {
		const longPreview = "A".repeat(80);
		const result = deriveDisplayStatus({
			subConversationId: "sub-1",
			agentName: "r",
			agentConfigId: "c",
			task: "t",
			status: "complete",
			resultPreview: longPreview,
			startedAt: 0,
		});
		expect(result.length).toBe(63); // 60 + "..."
		expect(result.endsWith("...")).toBe(true);
	});

	test("shows 'Done' for completed agent with no resultPreview", () => {
		expect(
			deriveDisplayStatus({
				subConversationId: "sub-1",
				agentName: "r",
				agentConfigId: "c",
				task: "t",
				status: "complete",
				startedAt: 0,
			}),
		).toBe("Done");
	});
});

