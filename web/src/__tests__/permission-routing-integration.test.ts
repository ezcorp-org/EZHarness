import { describe, test, expect, beforeEach } from "bun:test";
import {
	resolveRunForConversation,
	registerSpawn,
	unregisterSpawn,
	emptyRoutingState,
	type RoutingState,
} from "../lib/sub-agent-routing.js";

/**
 * Integration test for the sub-agent permission routing fix.
 *
 * The real handler lives in `stores.svelte.ts` and uses Svelte 5 runes,
 * which require a runtime we don't have under `bun test`. This test
 * re-implements the handler logic around plain properties but uses the
 * REAL `sub-agent-routing.ts` functions (the unit under integration), so
 * any regression in routing or handler wiring surfaces here.
 *
 * Mirrors the handlers in `stores.svelte.ts` around lines 609–718:
 *   - agent:spawn            → registerSpawn
 *   - agent:complete         → unregisterSpawn
 *   - tool:permission_request→ resolveRunForConversation + (update | create)
 */

// ── Types mirrored from stores.svelte.ts ──────────────────────────────────

interface ToolCallState {
	id?: string;
	toolName: string;
	status: "running" | "complete" | "error";
	input?: unknown;
	output?: unknown;
	error?: string;
	startedAt: number;
	duration?: number;
	extensionId?: string;
	cardType?: string;
	category?: string;
	permissionPending?: boolean;
}

interface AgentSpawnPayload {
	runId: string;
	agentRunId: string;
	subConversationId: string;
}

interface AgentCompletePayload {
	subConversationId: string;
	agentRunId?: string;
}

interface ToolPermissionRequestPayload {
	conversationId: string;
	toolCallId: string;
	toolName: string;
	input: unknown;
	cardType?: string;
	category?: string;
}

// ── Test double for the chat store ────────────────────────────────────────

class TestChatStore {
	// Routing state — owned jointly with sub-agent-routing.ts
	routing: RoutingState = emptyRoutingState();

	// Streaming state — mirrors the real store's per-runId tool call list
	streamingToolCalls: Record<string, ToolCallState[]> = {};

	// Side-effect spy: every call to `console.warn` from the handler is recorded
	warnings: Array<{ message: string; args: unknown[] }> = [];

	/** Mirrors `startStreaming(runId, conversationId)` in the real store. */
	startStreaming(runId: string, conversationId: string): void {
		this.routing = {
			...this.routing,
			streamingRunToConversation: {
				...this.routing.streamingRunToConversation,
				[runId]: conversationId,
			},
		};
		this.streamingToolCalls[runId] = this.streamingToolCalls[runId] ?? [];
	}

	/**
	 * Seeds a running tool call for a runId so we can exercise the
	 * "update existing running tool" branch of the permission handler.
	 */
	seedRunningTool(runId: string, toolCall: Omit<ToolCallState, "status">): void {
		const existing = this.streamingToolCalls[runId] ?? [];
		this.streamingToolCalls[runId] = [
			...existing,
			{ ...toolCall, status: "running" },
		];
	}

	/** Mirrors the `agent:spawn` handler body. */
	handleAgentSpawn(ev: AgentSpawnPayload): void {
		this.routing = registerSpawn(this.routing, ev);
	}

	/** Mirrors the `agent:complete` handler body (routing-cleanup portion). */
	handleAgentComplete(ev: AgentCompletePayload): void {
		this.routing = unregisterSpawn(this.routing, ev);
	}

	/** Mirrors the `tool:permission_request` handler body. */
	handleToolPermissionRequest(ev: ToolPermissionRequestPayload): void {
		const {
			conversationId,
			toolCallId,
			toolName: permToolName,
			input: permInput,
			cardType: permCardType,
			category: permCategory,
		} = ev;

		// Resolve root run — handles both root and sub-agent conversations
		const runId = resolveRunForConversation(this.routing, conversationId);
		if (runId) {
			const calls = this.streamingToolCalls[runId] ?? [];
			// Find latest running call with matching toolName (update in place)
			const idx = calls
				.map((tc, i) => ({ tc, i }))
				.reverse()
				.find(({ tc }) => tc.toolName === permToolName && tc.status === "running")?.i;
			if (idx !== undefined && idx >= 0) {
				const updated = [...calls];
				updated[idx] = {
					...updated[idx]!,
					id: toolCallId,
					permissionPending: true,
					cardType: permCardType,
					category: permCategory,
				};
				this.streamingToolCalls[runId] = updated;
			} else {
				this.streamingToolCalls[runId] = [
					...calls,
					{
						id: toolCallId,
						toolName: permToolName,
						status: "running",
						input: permInput,
						startedAt: Date.now(),
						permissionPending: true,
						cardType: permCardType,
						category: permCategory,
					},
				];
			}
		} else {
			// No root run found — record the warning side effect
			this.warnings.push({
				message: "[permission] Could not resolve root run for conversation",
				args: [conversationId, "tool", permToolName],
			});
		}
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makePermRequest(
	overrides: Partial<ToolPermissionRequestPayload> = {},
): ToolPermissionRequestPayload {
	return {
		conversationId: overrides.conversationId ?? "conv-A",
		toolCallId: overrides.toolCallId ?? "tc-1",
		toolName: overrides.toolName ?? "readFile",
		input: overrides.input ?? { path: "/tmp/x" },
		cardType: overrides.cardType,
		category: overrides.category,
	};
}

describe("sub-agent permission routing integration", () => {
	let store: TestChatStore;

	beforeEach(() => {
		store = new TestChatStore();
	});

	// ── Basic routing ─────────────────────────────────────────────────

	test("root conversation permission request lands on root runId", () => {
		store.startStreaming("run-1", "conv-A");

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "conv-A", toolCallId: "tc-1", toolName: "readFile" }),
		);

		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("tc-1");
		expect(calls[0]!.permissionPending).toBe(true);
		expect(calls[0]!.toolName).toBe("readFile");
		expect(calls[0]!.status).toBe("running");
		// No warning on success
		expect(store.warnings).toHaveLength(0);
	});

	test("sub-agent permission request routes to root runId (THE BUG FIX)", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-B", toolCallId: "tc-2", toolName: "writeFile" }),
		);

		// Tool call MUST land on run-1, not run-2
		expect(store.streamingToolCalls["run-1"]).toHaveLength(1);
		expect(store.streamingToolCalls["run-1"]![0]!.id).toBe("tc-2");
		expect(store.streamingToolCalls["run-1"]![0]!.permissionPending).toBe(true);
		expect(store.streamingToolCalls["run-2"]).toBeUndefined();
		expect(store.warnings).toHaveLength(0);
	});

	test("unknown conversation produces no tool call and emits a warning", () => {
		store.startStreaming("run-1", "conv-A");

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "unknown-conv", toolCallId: "tc-3", toolName: "bash" }),
		);

		expect(store.streamingToolCalls["run-1"]).toEqual([]);
		expect(store.warnings).toHaveLength(1);
		expect(store.warnings[0]!.args).toContain("unknown-conv");
		expect(store.warnings[0]!.args).toContain("bash");
	});

	// ── Cleanup ───────────────────────────────────────────────────────

	test("agent:complete cleans up mappings so later sub-conv events are dropped", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});

		// Verify mapping exists
		expect(resolveRunForConversation(store.routing, "sub-conv-B")).toBe("run-1");

		store.handleAgentComplete({ subConversationId: "sub-conv-B", agentRunId: "run-2" });

		// Mapping is now gone
		expect(resolveRunForConversation(store.routing, "sub-conv-B")).toBeUndefined();

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-B", toolCallId: "tc-late" }),
		);

		expect(store.streamingToolCalls["run-1"]).toEqual([]);
		expect(store.warnings).toHaveLength(1);
	});

	// ── Nested sub-agents ─────────────────────────────────────────────

	test("depth-2 sub-agent permission routes to root runId", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		// Nested spawn: parent is the child agentRun from the previous spawn
		store.handleAgentSpawn({
			runId: "run-2",
			agentRunId: "run-3",
			subConversationId: "sub-conv-C",
		});

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-C", toolCallId: "tc-d2", toolName: "grep" }),
		);

		expect(store.streamingToolCalls["run-1"]).toHaveLength(1);
		expect(store.streamingToolCalls["run-1"]![0]!.id).toBe("tc-d2");
		expect(store.streamingToolCalls["run-2"]).toBeUndefined();
		expect(store.streamingToolCalls["run-3"]).toBeUndefined();
	});

	test("depth-3 chain routes to root runId", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		store.handleAgentSpawn({
			runId: "run-2",
			agentRunId: "run-3",
			subConversationId: "sub-conv-C",
		});
		store.handleAgentSpawn({
			runId: "run-3",
			agentRunId: "run-4",
			subConversationId: "sub-conv-D",
		});

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-D", toolCallId: "tc-d3", toolName: "editFile" }),
		);

		expect(store.streamingToolCalls["run-1"]).toHaveLength(1);
		expect(store.streamingToolCalls["run-1"]![0]!.id).toBe("tc-d3");
		expect(store.streamingToolCalls["run-2"]).toBeUndefined();
		expect(store.streamingToolCalls["run-3"]).toBeUndefined();
		expect(store.streamingToolCalls["run-4"]).toBeUndefined();
	});

	// ── Concurrent sub-agents ─────────────────────────────────────────

	test("two sibling sub-agents both route to the shared root", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-3",
			subConversationId: "sub-conv-C",
		});

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-B", toolCallId: "tc-B", toolName: "readFile" }),
		);
		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-C", toolCallId: "tc-C", toolName: "writeFile" }),
		);

		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(2);
		expect(calls.map((c) => c.id).sort()).toEqual(["tc-B", "tc-C"]);
		expect(calls.every((c) => c.permissionPending === true)).toBe(true);
	});

	test("completing one sibling leaves the other's routing intact", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-3",
			subConversationId: "sub-conv-C",
		});

		// Complete only sub-B
		store.handleAgentComplete({ subConversationId: "sub-conv-B", agentRunId: "run-2" });

		// Sub-C still routes correctly
		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-C", toolCallId: "tc-C", toolName: "bash" }),
		);
		expect(store.streamingToolCalls["run-1"]).toHaveLength(1);
		expect(store.streamingToolCalls["run-1"]![0]!.id).toBe("tc-C");
		expect(store.warnings).toHaveLength(0);

		// Sub-B is now orphaned and should fall through to the warning branch
		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "sub-conv-B", toolCallId: "tc-B-late", toolName: "bash" }),
		);
		expect(store.streamingToolCalls["run-1"]).toHaveLength(1); // unchanged
		expect(store.warnings).toHaveLength(1);
		expect(store.warnings[0]!.args).toContain("sub-conv-B");
	});

	// ── Edge cases ────────────────────────────────────────────────────

	test("existing running tool gets permissionPending flag updated in place (not duplicated)", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		// Seed a running tool call on the root run (e.g. from an earlier tool:start event)
		store.seedRunningTool("run-1", {
			toolName: "writeFile",
			input: { path: "/tmp/x", content: "hi" },
			startedAt: 1000,
		});
		expect(store.streamingToolCalls["run-1"]).toHaveLength(1);
		expect(store.streamingToolCalls["run-1"]![0]!.permissionPending).toBeUndefined();

		store.handleToolPermissionRequest(
			makePermRequest({
				conversationId: "sub-conv-B",
				toolCallId: "tc-perm",
				toolName: "writeFile",
				cardType: "file-write",
				category: "fs",
			}),
		);

		// Still only one entry — the existing one was updated in place
		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("tc-perm");
		expect(calls[0]!.permissionPending).toBe(true);
		expect(calls[0]!.cardType).toBe("file-write");
		expect(calls[0]!.category).toBe("fs");
		// Original input preserved from the seeded running call
		expect(calls[0]!.input).toEqual({ path: "/tmp/x", content: "hi" });
		// startedAt preserved (update in place, not re-created)
		expect(calls[0]!.startedAt).toBe(1000);
	});

	test("new tool call is created when no matching running tool exists", () => {
		store.startStreaming("run-1", "conv-A");
		store.handleAgentSpawn({
			runId: "run-1",
			agentRunId: "run-2",
			subConversationId: "sub-conv-B",
		});
		// Seed a DIFFERENT tool that's running — should not be matched
		store.seedRunningTool("run-1", {
			toolName: "readFile",
			input: {},
			startedAt: 500,
		});

		store.handleToolPermissionRequest(
			makePermRequest({
				conversationId: "sub-conv-B",
				toolCallId: "tc-new",
				toolName: "writeFile",
				input: { path: "/tmp/y" },
			}),
		);

		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(2);
		const writeCall = calls.find((c) => c.toolName === "writeFile")!;
		expect(writeCall.id).toBe("tc-new");
		expect(writeCall.permissionPending).toBe(true);
		expect(writeCall.status).toBe("running");
		expect(writeCall.input).toEqual({ path: "/tmp/y" });
		// The readFile call is untouched
		const readCall = calls.find((c) => c.toolName === "readFile")!;
		expect(readCall.permissionPending).toBeUndefined();
		expect(readCall.startedAt).toBe(500);
	});

	test("only latest matching running tool is updated when multiple exist", () => {
		store.startStreaming("run-1", "conv-A");
		// Two running calls with the same toolName — handler should pick the latest
		store.seedRunningTool("run-1", { toolName: "bash", input: { cmd: "ls" }, startedAt: 100 });
		store.seedRunningTool("run-1", { toolName: "bash", input: { cmd: "pwd" }, startedAt: 200 });

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "conv-A", toolCallId: "tc-latest", toolName: "bash" }),
		);

		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(2);
		// First call is untouched
		expect(calls[0]!.permissionPending).toBeUndefined();
		expect(calls[0]!.id).toBeUndefined();
		// Second (latest) call was updated
		expect(calls[1]!.permissionPending).toBe(true);
		expect(calls[1]!.id).toBe("tc-latest");
	});

	test("a completed tool with matching name does not absorb the permission update", () => {
		store.startStreaming("run-1", "conv-A");
		// Previously-completed bash call should not match
		store.streamingToolCalls["run-1"] = [
			{ toolName: "bash", status: "complete", input: { cmd: "ls" }, startedAt: 100, duration: 10 },
		];

		store.handleToolPermissionRequest(
			makePermRequest({ conversationId: "conv-A", toolCallId: "tc-fresh", toolName: "bash" }),
		);

		const calls = store.streamingToolCalls["run-1"]!;
		expect(calls).toHaveLength(2);
		expect(calls[0]!.status).toBe("complete");
		expect(calls[0]!.permissionPending).toBeUndefined();
		expect(calls[1]!.status).toBe("running");
		expect(calls[1]!.permissionPending).toBe(true);
		expect(calls[1]!.id).toBe("tc-fresh");
	});
});
