/**
 * Unit tests for the `startStreaming` re-attach guard added to
 * `web/src/lib/stores.svelte.ts` (around lines 313-336).
 *
 * The bug being tested: switching to another chat conversation and back
 * caused the streaming response to "pause" / lose its rendered state.
 *
 * Root cause: every call to `startStreaming(runId, conversationId)`
 * unconditionally wiped accumulated state — `streamingThinking[runId]`,
 * `streamingContentBlocks[runId]`, `streamingAgentCalls[runId]`, and
 * replaced the per-run `ContentBlockBuilder` — even when the runId was
 * already attached. The chat page's convId-effect re-fires
 * `startStreaming` on every conv mount, so returning to the original
 * conversation wiped its in-flight state and the render froze on the
 * last snapshot.
 *
 * The fix: if `streamingRunToConversation[runId]` is already set AND
 * the per-run `ContentBlockBuilder` exists, treat the call as a re-
 * attach — preserve every shred of accumulated state, only fix up the
 * conversation mapping if it changed (future-proofing the call from a
 * different convId), and return `true`.
 *
 * The `startStreaming` body is replicated verbatim below from
 * stores.svelte.ts so logic regressions surface here. Same pattern as
 * `web/src/lib/__tests__/streaming-store.test.ts` and
 * `web/src/__tests__/streaming-tool-calls-status.test.ts`.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { ContentBlockBuilder, type ContentBlock } from "$lib/content-blocks.js";

// ── Replicated store shape (subset relevant to startStreaming) ────────────

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
	};
}

// ── Replicated `startStreaming` body — verbatim from stores.svelte.ts ─────
// Lines 313-338 of web/src/lib/stores.svelte.ts at the time the fix landed.
// `blockBuilders` is module-private in the real store; it's inlined here.

function makeStartStreaming(blockBuilders: Map<string, ContentBlockBuilder>) {
	return function startStreaming(
		store: StoreShape,
		runId: string,
		conversationId: string,
	): boolean {
		// If the run already completed/errored before we got here, don't start streaming
		if (store.completedBeforeStream.has(runId)) {
			store.completedBeforeStream = new Set(
				[...store.completedBeforeStream].filter((id) => id !== runId),
			);
			return false;
		}
		// Re-attach: the runId is already streaming (EventSource + store survived a
		// SPA navigation, and the chat page's convId effect re-fired on return).
		// Preserve all accumulated tokens, thinking, content blocks, agent pills,
		// and the ContentBlockBuilder — only (re-)assert the conversation mapping.
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
	};
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("startStreaming: re-attach idempotency (convo-switch fix)", () => {
	let store: StoreShape;
	let blockBuilders: Map<string, ContentBlockBuilder>;
	let startStreaming: ReturnType<typeof makeStartStreaming>;

	beforeEach(() => {
		store = makeStore();
		blockBuilders = new Map();
		startStreaming = makeStartStreaming(blockBuilders);
	});

	describe("first attach (brand-new run)", () => {
		test("initializes streaming state and returns true", () => {
			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(true);
			expect(store.streamingMessages["run-1"]).toBe("");
			expect(store.streamingThinking["run-1"]).toBe("");
			expect(store.streamingContentBlocks["run-1"]).toEqual([]);
			expect(store.streamingAgentCalls["run-1"]).toEqual([]);
			expect(store.streamingRunToConversation["run-1"]).toBe("conv-1");
			expect(blockBuilders.has("run-1")).toBe(true);
		});

		test("preserves any pre-buffered tokens from early-arriving rAF flushes", () => {
			// Tokens may arrive into streamingMessages before startStreaming runs
			// (race between SSE token and the POST that returned the runId).
			store.streamingMessages = { "run-1": "early " };

			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(true);
			expect(store.streamingMessages["run-1"]).toBe("early ");
			expect(store.streamingRunToConversation["run-1"]).toBe("conv-1");
			expect(blockBuilders.has("run-1")).toBe(true);
		});
	});

	describe("re-attach on SAME conversation (the regression guard)", () => {
		test("preserves accumulated text, thinking, content blocks, agent pills", () => {
			// First attach + accumulate state.
			startStreaming(store, "run-1", "conv-1");
			const builder = blockBuilders.get("run-1")!;
			builder.appendText("hello part one ");
			builder.pushAgentRef();
			builder.appendText("more text after agent ");
			store.streamingMessages = { "run-1": "hello part one more text after agent " };
			store.streamingThinking = { "run-1": "deep thoughts" };
			store.streamingContentBlocks = { "run-1": builder.snapshot() };
			store.streamingAgentCalls = {
				"run-1": [
					{
						subConversationId: "sub-1",
						agentName: "coder",
						agentConfigId: "cfg-1",
						task: "do thing",
						status: "running",
						startedAt: 1,
					},
				],
			};
			store.streamingToolCalls = {
				"run-1": [
					{ toolName: "Bash", status: "running", startedAt: 2, input: {} },
				],
			};

			// Snapshot expected values BEFORE re-attach.
			const expectedMessages = store.streamingMessages["run-1"];
			const expectedThinking = store.streamingThinking["run-1"];
			const expectedBlocks = store.streamingContentBlocks["run-1"];
			const expectedAgents = store.streamingAgentCalls["run-1"];
			const expectedTools = store.streamingToolCalls["run-1"];
			const expectedBuilder = blockBuilders.get("run-1");

			// User leaves and comes back — convId-effect re-fires.
			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(true);
			// EVERY shred of accumulated state survives, byte-for-byte.
			expect(store.streamingMessages["run-1"]).toBe(expectedMessages);
			expect(store.streamingThinking["run-1"]).toBe(expectedThinking);
			expect(store.streamingContentBlocks["run-1"]).toBe(expectedBlocks);
			expect(store.streamingAgentCalls["run-1"]).toBe(expectedAgents);
			expect(store.streamingToolCalls["run-1"]).toBe(expectedTools);
			// And — critically — the SAME builder instance, not a fresh one.
			expect(blockBuilders.get("run-1")).toBe(expectedBuilder);
		});

		test("conversation mapping is unchanged when convId matches existing mapping", () => {
			startStreaming(store, "run-1", "conv-1");
			const before = store.streamingRunToConversation;

			startStreaming(store, "run-1", "conv-1");

			// Identity equality — guard didn't even allocate a new map.
			expect(store.streamingRunToConversation).toBe(before);
		});
	});

	describe("re-attach with a DIFFERENT conversationId (future-proof corner)", () => {
		test("preserves state but updates the mapping to the new convId", () => {
			startStreaming(store, "run-1", "conv-A");
			blockBuilders.get("run-1")!.appendText("midstream text ");
			store.streamingMessages = { "run-1": "midstream text " };
			store.streamingAgentCalls = {
				"run-1": [
					{
						subConversationId: "s1",
						agentName: "x",
						agentConfigId: "c1",
						task: "t",
						status: "running",
						startedAt: 1,
					},
				],
			};
			const expectedMessages = store.streamingMessages["run-1"];
			const expectedAgents = store.streamingAgentCalls["run-1"];
			const builderBefore = blockBuilders.get("run-1");

			// Same runId now bound to conv-B.
			const ok = startStreaming(store, "run-1", "conv-B");

			expect(ok).toBe(true);
			// State preserved.
			expect(store.streamingMessages["run-1"]).toBe(expectedMessages);
			expect(store.streamingAgentCalls["run-1"]).toBe(expectedAgents);
			expect(blockBuilders.get("run-1")).toBe(builderBefore);
			// Mapping updated.
			expect(store.streamingRunToConversation["run-1"]).toBe("conv-B");
		});
	});

	describe("completedBeforeStream short-circuit (the fast-fail branch)", () => {
		test("returns false and clears the flag — guard does not break this branch", () => {
			store.completedBeforeStream = new Set(["run-1"]);

			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(false);
			expect(store.completedBeforeStream.has("run-1")).toBe(false);
			// And no streaming state should have been initialized as a side-effect.
			expect(store.streamingMessages["run-1"]).toBeUndefined();
			expect(store.streamingRunToConversation["run-1"]).toBeUndefined();
			expect(blockBuilders.has("run-1")).toBe(false);
			expect(store.streamingContentBlocks["run-1"]).toBeUndefined();
			expect(store.streamingAgentCalls["run-1"]).toBeUndefined();
		});

		test("only clears the specific runId from completedBeforeStream", () => {
			store.completedBeforeStream = new Set(["run-1", "run-2"]);

			startStreaming(store, "run-1", "conv-1");

			expect(store.completedBeforeStream.has("run-1")).toBe(false);
			expect(store.completedBeforeStream.has("run-2")).toBe(true);
		});
	});

	describe("re-attach guard does NOT misfire on partial state", () => {
		test("conv mapping set but no builder → treated as fresh attach (initializes)", () => {
			// Defensive: if the builder map ever falls out of sync with the
			// conv mapping (e.g., builder was somehow deleted), the guard
			// must NOT short-circuit — it must run the init branch so a
			// fresh builder gets created.
			store.streamingRunToConversation = { "run-1": "conv-1" };
			// blockBuilders intentionally empty.

			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(true);
			expect(blockBuilders.has("run-1")).toBe(true);
			expect(store.streamingContentBlocks["run-1"]).toEqual([]);
			expect(store.streamingAgentCalls["run-1"]).toEqual([]);
		});

		test("builder set but no conv mapping → treated as fresh attach", () => {
			// Symmetric defensive case: builder leaked from a stop without
			// a conv mapping (shouldn't happen, but the guard requires BOTH
			// conditions to match before short-circuiting).
			blockBuilders.set("run-1", new ContentBlockBuilder());

			const ok = startStreaming(store, "run-1", "conv-1");

			expect(ok).toBe(true);
			// A fresh builder replaces the orphan.
			expect(store.streamingRunToConversation["run-1"]).toBe("conv-1");
			expect(store.streamingContentBlocks["run-1"]).toEqual([]);
		});
	});
});
