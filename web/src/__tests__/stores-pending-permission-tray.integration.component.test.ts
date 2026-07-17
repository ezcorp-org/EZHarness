/**
 * B3 INTEGRATION test — drives the REAL `stores.svelte.ts` switch handler
 * (not a copy) by mocking the WS client and capturing its subscriber, then
 * emitting a synthetic `tool:permission_request` for a conversation that maps
 * to NO active run. This is the extension-initiated case (ez-code-factory's
 * init_gate hitting fs.write / shell): `resolveRunForConversation` returns
 * undefined, so the handler MUST route the prompt onto the global fallback
 * tray (`store.pendingPermissions`) instead of only warning — otherwise the
 * backend gate hangs with no UI to approve it.
 *
 * Proves end-to-end:
 *   1. A run-less permission request lands on `store.pendingPermissions`.
 *   2. A request WITH a run still lands inline (no regression) and does NOT
 *      duplicate onto the fallback tray.
 *   3. Idempotency: a replayed request (same toolCallId) updates in place.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";

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

vi.mock("$lib/api", () => ({
	fetchAgents: () => Promise.resolve([]),
	fetchRuns: () => Promise.resolve([]),
	fetchProjects: () => Promise.resolve([]),
	fetchSettings: () => Promise.resolve({}),
	fetchAgentConfigs: () => Promise.resolve([]),
	fetchPipelines: () => Promise.resolve([]),
	// stores.svelte.ts gained a fetchWorkflows import (workflows feature);
	// a partial mock missing it fails every import from the module.
	fetchWorkflows: () => Promise.resolve([]),
}));

import {
	initStores,
	startStreaming,
	stopStreaming,
	dismissPendingPermission,
	getStreamingToolCalls,
	store,
} from "$lib/stores.svelte";

function emit(type: string, data: unknown) {
	if (!capturedSubscriber) throw new Error("subscriber not captured — initStores not called?");
	capturedSubscriber({ type, data });
}

describe("stores.svelte.ts — fallback permission tray (B3)", () => {
	beforeEach(() => {
		capturedSubscriber = null;
		initStores();
		for (const runId of Object.keys(store.streamingRunToConversation)) {
			stopStreaming(runId);
		}
		store.pendingPermissions = [];
	});

	test("run-less permission request routes onto the fallback tray", () => {
		// No startStreaming → conversation maps to no run.
		emit("tool:permission_request", {
			conversationId: "conv-no-run",
			toolCallId: "prompt-init-gate",
			toolName: "ez-code-factory__init_gate",
			input: { projectRoot: "/app/projects/ecf-demo" },
			extensionId: "ez-code-factory",
			capabilityKind: "shell",
		});

		expect(store.pendingPermissions).toHaveLength(1);
		const entry = store.pendingPermissions[0]!;
		expect(entry.id).toBe("prompt-init-gate");
		expect(entry.toolName).toBe("ez-code-factory__init_gate");
		expect(entry.permissionPending).toBe(true);
		expect(entry.extensionId).toBe("ez-code-factory");
		expect(entry.capabilityKind).toBe("shell");

		// dismiss clears it (the resolve path).
		dismissPendingPermission("prompt-init-gate");
		expect(store.pendingPermissions).toHaveLength(0);
	});

	test("a request WITH a run stays inline and does NOT hit the fallback tray", () => {
		startStreaming("run-x", "conv-x");
		emit("tool:permission_request", {
			conversationId: "conv-x",
			toolCallId: "tc-inline",
			toolName: "writeFile",
			input: { path: "/tmp/x" },
		});

		expect(getStreamingToolCalls("run-x")).toHaveLength(1);
		expect(getStreamingToolCalls("run-x")[0]!.id).toBe("tc-inline");
		// Not duplicated onto the fallback tray.
		expect(store.pendingPermissions).toHaveLength(0);
	});

	test("a replayed run-less request (same toolCallId) updates in place — no stacked cards", () => {
		const payload = {
			conversationId: "conv-no-run",
			toolCallId: "prompt-dup",
			toolName: "ez-code-factory__init_gate",
			input: { projectRoot: "/app/projects/ecf-demo" },
			extensionId: "ez-code-factory",
			capabilityKind: "shell" as const,
		};
		emit("tool:permission_request", payload);
		emit("tool:permission_request", payload);
		expect(store.pendingPermissions).toHaveLength(1);
	});
});
