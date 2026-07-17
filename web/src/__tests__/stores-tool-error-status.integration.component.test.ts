/**
 * INTEGRATION test for the tool-error rendering bug fix.
 *
 * Drives the REAL `stores.svelte.ts` switch handler (not a copy) by mocking
 * the WS client and capturing its subscriber, then dispatching synthetic
 * `tool:start` / `tool:complete` events at it. The store's runes execute
 * under vitest, so this exercises the actual production code path and the
 * actual line that the bug fix changed.
 *
 * What this proves end-to-end:
 *   1. A `tool:complete` event with `success: false` flips the tool call's
 *      status to 'error' (red X), not 'complete' (green checkmark).
 *   2. The `error` field is populated from the tool output so the expanded
 *      ToolCallCard shows the error block.
 *   3. A `tool:complete` with `success: true` still lands as 'complete'
 *      (no regression of the happy path).
 */

import { describe, test, expect, beforeEach, vi } from "vitest";

// Capture the subscriber the real store hands to createWSClient.
let capturedSubscriber: ((evt: { type: string; data: unknown }) => void) | null = null;

vi.mock("$lib/ws", () => ({
	createWSClient: () => ({
		subscribe: (fn: (evt: { type: string; data: unknown }) => void) => {
			capturedSubscriber = fn;
			return () => {};
		},
		close: () => {},
		manualRetry: () => {},
	}),
}));

// Stub the network-bound API calls so initStores() doesn't blow up the run.
vi.mock("$lib/api", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchWorkflows: () => Promise.resolve([]),
}));

import {
	initStores,
	startStreaming,
	stopStreaming,
	getStreamingToolCalls,
	store,
} from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
	if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
	capturedSubscriber({ type, data });
}

describe("stores.svelte.ts — real handler integration", () => {
	beforeEach(() => {
		// Wire the store up once per test so each gets a fresh subscriber.
		// initStores() is idempotent for our purposes — it just attaches another
		// subscriber to a fresh mock client. Reset the captured one first.
		capturedSubscriber = null;
		initStores();
		// Wipe any leftover streaming state from a previous test.
		for (const runId of Object.keys(store.streamingRunToConversation)) {
			stopStreaming(runId);
		}
	});

	test("BUG FIX: tool:complete with success=false flips status to 'error' with error text", () => {
		const runId = "run-real-1";
		const convId = "conv-real-1";

		startStreaming(runId, convId);

		emit("tool:start", {
			conversationId: convId,
			toolName: "Bash",
			input: { command: "false" },
			timestamp: Date.now(),
			invocationId: "tc-fail-1",
		});

		// Sanity check: the tool is in 'running' before tool:complete arrives.
		const beforeCalls = getStreamingToolCalls(runId);
		expect(beforeCalls).toHaveLength(1);
		expect(beforeCalls[0]!.status).toBe("running");

		// Backend reports failure via tool:complete with success: false
		// (real-world emission path from src/runtime/stream-chat/subscribe-bridge.ts
		// and src/extensions/tool-executor.ts).
		emit("tool:complete", {
			conversationId: convId,
			toolName: "Bash",
			output: "exit code 1: command failed",
			duration: 12,
			success: false,
			invocationId: "tc-fail-1",
		});

		const afterCalls = getStreamingToolCalls(runId);
		expect(afterCalls).toHaveLength(1);

		// The fix: status MUST be 'error' (renders the red X in ToolCallCard),
		// not 'complete' (which would render the green checkmark).
		expect(afterCalls[0]!.status).toBe("error");

		// And the error text must propagate so the expanded card shows the
		// red error block.
		expect(afterCalls[0]!.error).toBe("exit code 1: command failed");

		// Permission-pending must be cleared so the card doesn't get stuck.
		expect(afterCalls[0]!.permissionPending).toBe(false);
	});

	test("happy path: tool:complete with success=true still lands as 'complete' (no regression)", () => {
		const runId = "run-real-2";
		const convId = "conv-real-2";

		startStreaming(runId, convId);

		emit("tool:start", {
			conversationId: convId,
			toolName: "Bash",
			input: { command: "true" },
			timestamp: Date.now(),
			invocationId: "tc-ok-1",
		});

		emit("tool:complete", {
			conversationId: convId,
			toolName: "Bash",
			output: "ok",
			duration: 10,
			success: true,
			invocationId: "tc-ok-1",
		});

		const calls = getStreamingToolCalls(runId);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.status).toBe("complete");
		expect(calls[0]!.error).toBeUndefined();
	});

	test("tool:complete with structured ToolCallResult content extracts error text", () => {
		const runId = "run-real-3";
		const convId = "conv-real-3";

		startStreaming(runId, convId);

		emit("tool:start", {
			conversationId: convId,
			toolName: "Edit",
			input: { file_path: "/etc/passwd" },
			timestamp: Date.now(),
			invocationId: "tc-fail-2",
		});

		emit("tool:complete", {
			conversationId: convId,
			toolName: "Edit",
			output: { content: [{ type: "text", text: "permission denied" }] },
			duration: 5,
			success: false,
			invocationId: "tc-fail-2",
		});

		const calls = getStreamingToolCalls(runId);
		expect(calls[0]!.status).toBe("error");
		expect(calls[0]!.error).toBe("permission denied");
	});

	test("tool:error event also produces 'error' status (path B)", () => {
		const runId = "run-real-4";
		const convId = "conv-real-4";

		startStreaming(runId, convId);

		emit("tool:start", {
			conversationId: convId,
			toolName: "Bash",
			input: { command: "killed" },
			timestamp: Date.now(),
			invocationId: "tc-err-1",
		});

		emit("tool:error", {
			conversationId: convId,
			toolName: "Bash",
			error: "process killed by signal",
			duration: 7,
			invocationId: "tc-err-1",
		});

		const calls = getStreamingToolCalls(runId);
		expect(calls[0]!.status).toBe("error");
		expect(calls[0]!.error).toBe("process killed by signal");
	});
});
