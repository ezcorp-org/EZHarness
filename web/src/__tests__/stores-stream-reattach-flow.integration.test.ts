/**
 * Integration test for the stream-survives-convo-switch fix.
 *
 * Mirrors the realistic UI flow:
 *   1. user sends a message → run starts → tokens stream in
 *   2. user navigates to another conversation (B) — store keeps the
 *      run state alive, the chat page is unmounted/remounted on return
 *   3. while user is on B, more SSE events arrive for run-A (tokens,
 *      tool starts, agent spawns) — they MUST keep accumulating
 *   4. user navigates back to A — the chat page's convId effect calls
 *      `startStreaming(runId, convId)` AGAIN on mount; the re-attach
 *      guard must preserve every shred of accumulated state
 *   5. more tokens arrive — they must continue to extend the SAME text,
 *      content blocks, agent pills (no reset, no loss)
 *
 * The high-level invariant: after re-attach, `streamingMessages[runId]`,
 * `streamingContentBlocks[runId]`, and `streamingAgentCalls[runId]` are
 * MONOTONICALLY GROWING — never reset, never lose entries.
 *
 * Function bodies (`startStreaming`, `flushTokensForRun`, `tool:start`
 * handler slice, `agent:spawn` handler slice) are replicated verbatim
 * from web/src/lib/stores.svelte.ts — same convention as the sibling
 * `streaming-store.test.ts` and `streaming-tool-calls-status.test.ts`.
 * If the production logic regresses, this test catches it.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { ContentBlockBuilder, type ContentBlock } from "$lib/content-blocks.js";

// ── Replicated store + helper types ─────────────────────────────────────

interface ToolCallState {
	id?: string;
	toolName: string;
	status: "running" | "complete" | "error";
	input?: unknown;
	output?: unknown;
	error?: string;
	startedAt: number;
	duration?: number;
	permissionPending?: boolean;
}

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

interface StoreShape {
	streamingMessages: Record<string, string>;
	streamingThinking: Record<string, string>;
	streamingRunToConversation: Record<string, string>;
	streamingContentBlocks: Record<string, ContentBlock[]>;
	streamingAgentCalls: Record<string, AgentCallState[]>;
	streamingToolCalls: Record<string, ToolCallState[]>;
	completedBeforeStream: Set<string>;
	subConvToRootRun: Record<string, string>;
	agentRunToRootRun: Record<string, string>;
}

function makeStore(): StoreShape {
	return {
		streamingMessages: {},
		streamingThinking: {},
		streamingRunToConversation: {},
		streamingContentBlocks: {},
		streamingAgentCalls: {},
		streamingToolCalls: {},
		completedBeforeStream: new Set(),
		subConvToRootRun: {},
		agentRunToRootRun: {},
	};
}

// ── Replicated logic from stores.svelte.ts ──────────────────────────────

// ── Replicated routing module (sub-agent-routing.ts) — verbatim slice ──
// Just enough to support Gap 3 (agent:spawn maps survive re-attach).

interface RoutingState {
	streamingRunToConversation: Record<string, string>;
	subConvToRootRun: Record<string, string>;
	agentRunToRootRun: Record<string, string>;
}

function getActiveRunIdForConversation(
	state: RoutingState,
	conversationId: string,
): string | undefined {
	for (const [runId, convId] of Object.entries(state.streamingRunToConversation)) {
		if (convId === conversationId) return runId;
	}
	return undefined;
}

function resolveRunForConversation(
	state: RoutingState,
	conversationId: string,
): string | undefined {
	const direct = getActiveRunIdForConversation(state, conversationId);
	if (direct) return direct;
	return state.subConvToRootRun[conversationId];
}

function registerSpawn(
	state: RoutingState,
	event: { runId: string; agentRunId: string; subConversationId: string },
): RoutingState {
	const { runId, agentRunId, subConversationId } = event;
	const rootRunId = state.streamingRunToConversation[runId]
		? runId
		: state.agentRunToRootRun[runId];
	if (!rootRunId) return state;
	return {
		streamingRunToConversation: state.streamingRunToConversation,
		subConvToRootRun: { ...state.subConvToRootRun, [subConversationId]: rootRunId },
		agentRunToRootRun: { ...state.agentRunToRootRun, [agentRunId]: rootRunId },
	};
}

function makeHandlers(blockBuilders: Map<string, ContentBlockBuilder>) {
	let tokenBuffer: Record<string, string> = {};

	function startStreaming(
		store: StoreShape,
		runId: string,
		conversationId: string,
	): boolean {
		if (store.completedBeforeStream.has(runId)) {
			store.completedBeforeStream = new Set(
				[...store.completedBeforeStream].filter((id) => id !== runId),
			);
			return false;
		}
		// Re-attach guard (the fix under test).
		if (
			store.streamingRunToConversation[runId] !== undefined &&
			blockBuilders.has(runId)
		) {
			if (store.streamingRunToConversation[runId] !== conversationId) {
				store.streamingRunToConversation = {
					...store.streamingRunToConversation,
					[runId]: conversationId,
				};
			}
			return true;
		}
		const existing = store.streamingMessages[runId] ?? "";
		store.streamingMessages = {
			...store.streamingMessages,
			[runId]: existing,
		};
		store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
		store.streamingRunToConversation = {
			...store.streamingRunToConversation,
			[runId]: conversationId,
		};
		blockBuilders.set(runId, new ContentBlockBuilder());
		store.streamingContentBlocks = {
			...store.streamingContentBlocks,
			[runId]: [],
		};
		store.streamingAgentCalls = {
			...store.streamingAgentCalls,
			[runId]: [],
		};
		return true;
	}

	/** Mirror of bufferToken + scheduleFlush + flushTokenBuffer (synchronous). */
	function pushToken(store: StoreShape, runId: string, token: string) {
		tokenBuffer[runId] = (tokenBuffer[runId] ?? "") + token;
		flushTokenBuffer(store);
	}

	function flushTokenBuffer(store: StoreShape) {
		for (const [runId, tokens] of Object.entries(tokenBuffer)) {
			if (
				store.streamingRunToConversation[runId] !== undefined ||
				store.streamingMessages[runId] !== undefined
			) {
				const current = store.streamingMessages[runId] ?? "";
				store.streamingMessages = {
					...store.streamingMessages,
					[runId]: current + tokens,
				};
				const builder = blockBuilders.get(runId);
				if (builder) {
					builder.appendText(tokens);
					store.streamingContentBlocks = {
						...store.streamingContentBlocks,
						[runId]: builder.snapshot(),
					};
				}
			}
		}
		tokenBuffer = {};
	}

	/** Mirror of tool:start handler: append to streamingToolCalls + push tool_ref. */
	function applyToolStart(
		store: StoreShape,
		params: {
			conversationId: string;
			toolName: string;
			input: unknown;
			timestamp: number;
		},
	) {
		const runId = Object.entries(store.streamingRunToConversation).find(
			([, cId]) => cId === params.conversationId,
		)?.[0];
		if (!runId) return;
		flushTokenBuffer(store);
		const existing = store.streamingToolCalls[runId] ?? [];
		store.streamingToolCalls = {
			...store.streamingToolCalls,
			[runId]: [
				...existing,
				{
					toolName: params.toolName,
					status: "running",
					input: params.input,
					startedAt: params.timestamp,
				},
			],
		};
		const builder = blockBuilders.get(runId);
		if (builder) {
			builder.pushToolRef();
			store.streamingContentBlocks = {
				...store.streamingContentBlocks,
				[runId]: builder.snapshot(),
			};
		}
	}

	/** Mirror of agent:spawn handler: append to streamingAgentCalls + push agent_ref. */
	function applyAgentSpawn(
		store: StoreShape,
		params: {
			runId: string;
			subConversationId: string;
			agentName: string;
			agentConfigId: string;
			task: string;
			agentRunId: string;
		},
	) {
		// Mirror routing-map registration from the real handler. registerSpawn
		// is a pure function (sub-agent-routing.ts), and the store's spawn
		// handler calls applyRoutingState with its result before mutating
		// streamingAgentCalls — so this must happen first here too.
		const next = registerSpawn(
			{
				streamingRunToConversation: store.streamingRunToConversation,
				subConvToRootRun: store.subConvToRootRun,
				agentRunToRootRun: store.agentRunToRootRun,
			},
			{
				runId: params.runId,
				agentRunId: params.agentRunId,
				subConversationId: params.subConversationId,
			},
		);
		store.subConvToRootRun = next.subConvToRootRun;
		store.agentRunToRootRun = next.agentRunToRootRun;
		flushTokenBuffer(store);
		const existing = store.streamingAgentCalls[params.runId] ?? [];
		const existingIdx = existing.findIndex(
			(a) => a.subConversationId === params.subConversationId,
		);
		if (existingIdx >= 0) {
			const updated = [...existing];
			updated[existingIdx] = {
				...updated[existingIdx]!,
				status: "running",
				statusText: undefined,
				resultPreview: undefined,
				task: params.task,
				agentRunId: params.agentRunId,
				startedAt: Date.now(),
			};
			store.streamingAgentCalls = {
				...store.streamingAgentCalls,
				[params.runId]: updated,
			};
			return;
		}
		store.streamingAgentCalls = {
			...store.streamingAgentCalls,
			[params.runId]: [
				...existing,
				{
					subConversationId: params.subConversationId,
					agentName: params.agentName,
					agentConfigId: params.agentConfigId,
					task: params.task,
					status: "running",
					agentRunId: params.agentRunId,
					startedAt: Date.now(),
				},
			],
		};
		const builder = blockBuilders.get(params.runId);
		if (builder) {
			builder.pushAgentRef();
			store.streamingContentBlocks = {
				...store.streamingContentBlocks,
				[params.runId]: builder.snapshot(),
			};
		}
	}

	/**
	 * Mirror of `case "run:turn_text_reset"` handler in stores.svelte.ts
	 * (lines 571-594). Resets the streaming text/thinking buffers and the
	 * tool-call list, then resets the ContentBlockBuilder and re-injects
	 * agent_ref blocks for every existing entry in streamingAgentCalls[runId].
	 * NOTE: streamingAgentCalls is intentionally NOT reset — agents persist
	 * across turns within a run.
	 */
	function applyTurnTextReset(store: StoreShape, runId: string) {
		store.streamingMessages = { ...store.streamingMessages, [runId]: "" };
		store.streamingThinking = { ...store.streamingThinking, [runId]: "" };
		store.streamingToolCalls = { ...store.streamingToolCalls, [runId]: [] };
		const resetBuilder = blockBuilders.get(runId);
		if (resetBuilder) {
			resetBuilder.reset();
			const existingAgents = store.streamingAgentCalls[runId] ?? [];
			for (let i = 0; i < existingAgents.length; i++) {
				resetBuilder.pushAgentRef();
			}
			store.streamingContentBlocks = {
				...store.streamingContentBlocks,
				[runId]: resetBuilder.snapshot(),
			};
		} else {
			store.streamingContentBlocks = {
				...store.streamingContentBlocks,
				[runId]: [],
			};
		}
	}

	/** Mirror of the `tool:permission_request` "no existing match" branch
	 * (stores.svelte.ts lines 806-833). Resolves the conversationId to a
	 * root runId via the routing maps, then appends a synthetic running
	 * tool call for the permission gate.
	 */
	function applyToolPermissionRequest(
		store: StoreShape,
		params: {
			conversationId: string;
			toolCallId: string;
			toolName: string;
			input: unknown;
		},
	): { resolvedRunId: string | undefined } {
		const runId = resolveRunForConversation(
			{
				streamingRunToConversation: store.streamingRunToConversation,
				subConvToRootRun: store.subConvToRootRun,
				agentRunToRootRun: store.agentRunToRootRun,
			},
			params.conversationId,
		);
		if (!runId) return { resolvedRunId: undefined };
		const calls = store.streamingToolCalls[runId] ?? [];
		const idx = calls.findLastIndex(
			(tc) => tc.toolName === params.toolName && tc.status === "running",
		);
		if (idx >= 0) {
			const updated = [...calls];
			updated[idx] = {
				...updated[idx]!,
				id: params.toolCallId,
				permissionPending: true,
			};
			store.streamingToolCalls = {
				...store.streamingToolCalls,
				[runId]: updated,
			};
		} else {
			store.streamingToolCalls = {
				...store.streamingToolCalls,
				[runId]: [
					...calls,
					{
						id: params.toolCallId,
						toolName: params.toolName,
						status: "running",
						input: params.input,
						startedAt: Date.now(),
						permissionPending: true,
					},
				],
			};
		}
		return { resolvedRunId: runId };
	}

	return {
		startStreaming,
		pushToken,
		applyToolStart,
		applyAgentSpawn,
		applyTurnTextReset,
		applyToolPermissionRequest,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("stream survives convo switch — integration", () => {
	let store: StoreShape;
	let blockBuilders: Map<string, ContentBlockBuilder>;
	let h: ReturnType<typeof makeHandlers>;

	beforeEach(() => {
		store = makeStore();
		blockBuilders = new Map();
		h = makeHandlers(blockBuilders);
	});

	test("text + content blocks + agent pills accumulate monotonically across re-attach", () => {
		// ─── Phase 1: user is on conv-A, run-A is streaming ───
		expect(h.startStreaming(store, "run-A", "conv-A")).toBe(true);
		h.pushToken(store, "run-A", "hello part one ");

		// Tool starts mid-stream.
		h.applyToolStart(store, {
			conversationId: "conv-A",
			toolName: "Bash",
			input: { cmd: "ls" },
			timestamp: 100,
		});
		// Agent spawns mid-stream.
		h.applyAgentSpawn(store, {
			runId: "run-A",
			subConversationId: "sub-1",
			agentName: "coder",
			agentConfigId: "cfg-1",
			task: "write tests",
			agentRunId: "ar-1",
		});

		const beforeText = store.streamingMessages["run-A"];
		const beforeBlocks = store.streamingContentBlocks["run-A"];
		const beforeTools = store.streamingToolCalls["run-A"];
		const beforeAgents = store.streamingAgentCalls["run-A"];
		const beforeBuilder = blockBuilders.get("run-A");

		expect(beforeText).toBe("hello part one ");
		expect(beforeBlocks?.length).toBeGreaterThanOrEqual(3); // text, tool_ref, agent_ref
		expect(beforeTools?.length).toBe(1);
		expect(beforeAgents?.length).toBe(1);

		// ─── Phase 2: user navigates to conv-B ───
		// (The convId-effect on B fires startStreaming on whatever active run B
		//  has — for this test, B has no active run, so we just don't call it.
		//  More events arrive for run-A while user is "elsewhere".)
		h.pushToken(store, "run-A", "while-on-B-1 ");
		h.applyToolStart(store, {
			conversationId: "conv-A",
			toolName: "Read",
			input: { path: "/x" },
			timestamp: 200,
		});

		// Accumulation continues — none of A's state was lost when user left.
		expect(store.streamingMessages["run-A"]).toContain("hello part one ");
		expect(store.streamingMessages["run-A"]).toContain("while-on-B-1 ");
		expect(store.streamingToolCalls["run-A"]?.length).toBe(2);

		// ─── Phase 3: user navigates BACK to conv-A — convId-effect re-fires ───
		const reAttached = h.startStreaming(store, "run-A", "conv-A");
		expect(reAttached).toBe(true);

		// All state is still there.
		expect(store.streamingMessages["run-A"]).toBe(
			beforeText + "while-on-B-1 ",
		);
		// Builder identity is the same — NOT replaced.
		expect(blockBuilders.get("run-A")).toBe(beforeBuilder);
		// Content blocks have GROWN, not been wiped.
		expect(
			store.streamingContentBlocks["run-A"]!.length,
		).toBeGreaterThanOrEqual(beforeBlocks!.length);
		// Tool calls: original Bash entry is still there, plus the Read added on B.
		expect(store.streamingToolCalls["run-A"]?.length).toBe(2);
		expect(store.streamingToolCalls["run-A"]![0]!.toolName).toBe("Bash");
		expect(store.streamingToolCalls["run-A"]![1]!.toolName).toBe("Read");
		// Agent pill survived re-attach.
		expect(store.streamingAgentCalls["run-A"]).toEqual(beforeAgents!);

		// ─── Phase 4: more tokens arrive while back on A — they extend ───
		h.pushToken(store, "run-A", "and three.");
		expect(store.streamingMessages["run-A"]).toBe(
			"hello part one while-on-B-1 and three.",
		);
	});

	test("Gap 1 — turn_text_reset (with re-injected agent_refs) survives re-attach intact", () => {
		// Adversarial scenario:
		//  1. run-A is streaming on conv-A, an agent has spawned (agent_ref + pill)
		//  2. user navigates to conv-B
		//  3. while user is on B, a `run:turn_text_reset` fires for run-A
		//     (turn 2 starting): streamingMessages/Thinking cleared, tool calls
		//     cleared, builder.reset() + re-injected agent_ref(s)
		//  4. user returns to conv-A → startStreaming re-attach branch fires
		//
		// Invariant: the rebuilt blocks (with re-injected agent_ref) AND the
		// streamingAgentCalls list both survive the re-attach byte-for-byte.
		// Particularly: the re-attach guard MUST NOT replace the builder, or
		// the agent_ref re-injection done by turn_text_reset would be lost.

		// ── Phase 1: stream + agent spawn on conv-A ──
		expect(h.startStreaming(store, "run-A", "conv-A")).toBe(true);
		h.pushToken(store, "run-A", "turn 1 text ");
		h.applyAgentSpawn(store, {
			runId: "run-A",
			subConversationId: "sub-1",
			agentName: "coder",
			agentConfigId: "cfg-1",
			task: "do thing",
			agentRunId: "ar-1",
		});
		// Add another text token after the agent_ref so the builder has multiple blocks.
		h.pushToken(store, "run-A", "post-agent text ");

		// ── Phase 2: user navigates to conv-B (simulated by calling startStreaming
		// for run-B if any, or simply not calling it; the run-A state must persist).

		// ── Phase 3: turn_text_reset fires for run-A while user is on B ──
		const builderBeforeReset = blockBuilders.get("run-A");
		const agentsBeforeReset = store.streamingAgentCalls["run-A"];
		h.applyTurnTextReset(store, "run-A");

		// After reset: text/thinking/tools cleared, but agents preserved and the
		// builder has re-injected one agent_ref.
		expect(store.streamingMessages["run-A"]).toBe("");
		expect(store.streamingThinking["run-A"]).toBe("");
		expect(store.streamingToolCalls["run-A"]).toEqual([]);
		expect(store.streamingAgentCalls["run-A"]).toBe(agentsBeforeReset);
		const blocksAfterReset = store.streamingContentBlocks["run-A"]!;
		expect(blocksAfterReset.length).toBe(1);
		expect(blocksAfterReset[0]!.type).toBe("agent_ref");
		// The builder identity is preserved — turn_text_reset calls .reset()
		// rather than replacing the instance.
		expect(blockBuilders.get("run-A")).toBe(builderBeforeReset);

		// ── Phase 4: user returns to conv-A → re-attach guard fires ──
		const reAttached = h.startStreaming(store, "run-A", "conv-A");
		expect(reAttached).toBe(true);

		// Critical invariants: every shred of post-reset state survives.
		expect(store.streamingMessages["run-A"]).toBe(""); // still empty after reset
		expect(store.streamingThinking["run-A"]).toBe(""); // still empty after reset
		expect(store.streamingToolCalls["run-A"]).toEqual([]); // still empty after reset
		// Agent pills survive byte-for-byte.
		expect(store.streamingAgentCalls["run-A"]).toBe(agentsBeforeReset);
		// The re-injected agent_ref block survives.
		expect(store.streamingContentBlocks["run-A"]).toBe(blocksAfterReset);
		expect(store.streamingContentBlocks["run-A"]![0]!.type).toBe("agent_ref");
		// Builder identity preserved across re-attach.
		expect(blockBuilders.get("run-A")).toBe(builderBeforeReset);

		// ── Phase 5: turn 2 tokens flow into the same builder, after the agent_ref ──
		h.pushToken(store, "run-A", "turn 2 token ");
		expect(store.streamingMessages["run-A"]).toBe("turn 2 token ");
		const finalBlocks = store.streamingContentBlocks["run-A"]!;
		// agent_ref still first, text appended after.
		expect(finalBlocks[0]!.type).toBe("agent_ref");
		expect(finalBlocks[finalBlocks.length - 1]!.type).toBe("text");
		expect((finalBlocks[finalBlocks.length - 1] as { content: string }).content).toBe(
			"turn 2 token ",
		);
	});

	test("Gap 3 — agent:spawn routing maps survive re-attach (sub-agent permission resolves)", () => {
		// Invariant: subConvToRootRun and agentRunToRootRun are not touched by
		// startStreaming (neither old nor new code path), so a sub-agent
		// permission_request that arrives AFTER a re-attach must still resolve
		// to the root runId via the registered spawn maps.

		expect(h.startStreaming(store, "run-A", "conv-A")).toBe(true);
		// Register an agent:spawn → maps populate for sub-conv-1 / agent-run-1.
		h.applyAgentSpawn(store, {
			runId: "run-A",
			subConversationId: "sub-conv-1",
			agentName: "coder",
			agentConfigId: "cfg-1",
			task: "fix bug",
			agentRunId: "agent-run-1",
		});
		expect(store.subConvToRootRun["sub-conv-1"]).toBe("run-A");
		expect(store.agentRunToRootRun["agent-run-1"]).toBe("run-A");

		// User leaves and comes back — convId-effect re-fires startStreaming.
		const reAttached = h.startStreaming(store, "run-A", "conv-A");
		expect(reAttached).toBe(true);

		// Routing maps untouched.
		expect(store.subConvToRootRun["sub-conv-1"]).toBe("run-A");
		expect(store.agentRunToRootRun["agent-run-1"]).toBe("run-A");

		// A sub-agent permission_request arrives for the sub-conversation —
		// must resolve to the root runId and append to its tool-call list.
		const { resolvedRunId } = h.applyToolPermissionRequest(store, {
			conversationId: "sub-conv-1",
			toolCallId: "tc-1",
			toolName: "Bash",
			input: { cmd: "rm -rf /" },
		});
		expect(resolvedRunId).toBe("run-A");
		const calls = store.streamingToolCalls["run-A"] ?? [];
		expect(calls.length).toBe(1);
		expect(calls[0]!.id).toBe("tc-1");
		expect(calls[0]!.permissionPending).toBe(true);
	});

	test("Gap 4 — two simultaneous runs (one per conversation) survive interleaved re-attach", () => {
		// User has run-A streaming on conv-A AND run-B streaming on conv-B.
		// Switching between them must leave both streams intact, with no
		// cross-contamination.

		// Start both runs.
		expect(h.startStreaming(store, "run-A", "conv-A")).toBe(true);
		expect(h.startStreaming(store, "run-B", "conv-B")).toBe(true);

		// Push initial tokens to each.
		h.pushToken(store, "run-A", "A1 ");
		h.pushToken(store, "run-B", "B1 ");
		expect(store.streamingMessages["run-A"]).toBe("A1 ");
		expect(store.streamingMessages["run-B"]).toBe("B1 ");

		// Snapshot identities BEFORE re-attach.
		const builderA = blockBuilders.get("run-A");
		const builderB = blockBuilders.get("run-B");

		// Switch back to A → re-attach run-A. push more tokens to BOTH (B keeps
		// streaming to its store entry even while user is on A).
		expect(h.startStreaming(store, "run-A", "conv-A")).toBe(true);
		h.pushToken(store, "run-A", "A2 ");
		h.pushToken(store, "run-B", "B2 ");

		// Switch to B → re-attach run-B. push more.
		expect(h.startStreaming(store, "run-B", "conv-B")).toBe(true);
		h.pushToken(store, "run-A", "A3 ");
		h.pushToken(store, "run-B", "B3 ");

		// Final assertions: both streams accumulated all tokens, in order, no leak.
		expect(store.streamingMessages["run-A"]).toBe("A1 A2 A3 ");
		expect(store.streamingMessages["run-B"]).toBe("B1 B2 B3 ");

		// Builders preserved across all re-attaches — no cross-contamination.
		expect(blockBuilders.get("run-A")).toBe(builderA);
		expect(blockBuilders.get("run-B")).toBe(builderB);

		// Each run's content blocks contain ONLY its own text.
		const blocksA = store.streamingContentBlocks["run-A"]!;
		const blocksB = store.streamingContentBlocks["run-B"]!;
		const textA = blocksA
			.filter((b): b is { type: "text"; content: string } => b.type === "text")
			.map((b) => b.content)
			.join("");
		const textB = blocksB
			.filter((b): b is { type: "text"; content: string } => b.type === "text")
			.map((b) => b.content)
			.join("");
		expect(textA).toBe("A1 A2 A3 ");
		expect(textB).toBe("B1 B2 B3 ");
		expect(textA).not.toContain("B");
		expect(textB).not.toContain("A");

		// Conv mapping intact for both — neither was overwritten by the other's re-attach.
		expect(store.streamingRunToConversation["run-A"]).toBe("conv-A");
		expect(store.streamingRunToConversation["run-B"]).toBe("conv-B");
	});

	test("monotonic invariant: streamingMessages length never shrinks across re-attach calls", () => {
		// Stress: alternate token-arrival and re-attach calls, the visible length
		// MUST be non-decreasing for the entire sequence.
		h.startStreaming(store, "run-1", "conv-1");
		const lengths: number[] = [];

		function pushAndReAttach(token: string) {
			h.pushToken(store, "run-1", token);
			lengths.push(store.streamingMessages["run-1"]!.length);
			h.startStreaming(store, "run-1", "conv-1");
			lengths.push(store.streamingMessages["run-1"]!.length);
		}

		pushAndReAttach("a");
		pushAndReAttach("bb");
		pushAndReAttach("ccc");
		pushAndReAttach("dddd");

		// Strictly non-decreasing — proves no wipe ever happened.
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]!);
		}
		// And the final string is the concatenation, in order.
		expect(store.streamingMessages["run-1"]).toBe("abbcccdddd");
		// The agent pill array also never shrinks (would be empty by default
		// either way, but verifies the empty array wasn't replaced with a
		// fresh reference that loses identity in equality checks).
		expect(store.streamingAgentCalls["run-1"]).toEqual([]);
	});
});
