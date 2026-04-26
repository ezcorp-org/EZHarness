/**
 * Tests the `streamingToolCalls` map mutation path inside the `tool:complete`
 * and `tool:error` branches of stores.svelte.ts. This is the path that feeds
 * `ToolCallCard.svelte`, so the status it lands in here is what determines
 * whether the user sees a green checkmark or a red X.
 *
 * Specifically guards against the regression where a `tool:complete` event
 * carrying `success: false` was being mapped to `status: 'complete'` (showing
 * a green check) instead of `status: 'error'` (showing a red X).
 *
 * The same pattern as `streaming-store.test.ts`: bodies are copied verbatim
 * from stores.svelte.ts so logic regressions surface here.
 */
import { test, expect, describe, beforeEach } from "bun:test";

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

interface StoreShape {
	streamingRunToConversation: Record<string, string>;
	streamingToolCalls: Record<string, ToolCallState[]>;
}

function makeStore(): StoreShape {
	return {
		streamingRunToConversation: {},
		streamingToolCalls: {},
	};
}

// ── Replicated extraction utility (same as stores.svelte.ts) ──────────────
function extractToolOutput(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.content)) {
		const texts = (obj.content as Array<Record<string, unknown>>)
			.filter((c) => c.type === "text" && typeof c.text === "string")
			.map((c) => c.text as string);
		if (texts.length > 0) return texts.join("\n");
	}
	return value;
}

// ── Replicated handler bodies from stores.svelte.ts ──────────────────────

type ToolCompleteEvent = {
	conversationId: string;
	toolName: string;
	output: unknown;
	duration: number;
	success?: boolean;
	invocationId?: string;
};

type ToolErrorEvent = {
	conversationId: string;
	toolName: string;
	error: string;
	duration: number;
	invocationId?: string;
};

/** Mirror of the `tool:complete` → `streamingToolCalls` branch. */
function applyToolComplete(store: StoreShape, e: ToolCompleteEvent): void {
	const runId = Object.entries(store.streamingRunToConversation).find(
		([, cId]) => cId === e.conversationId,
	)?.[0];
	if (!runId) return;
	const calls = store.streamingToolCalls[runId] ?? [];
	const idx = calls.findLastIndex(
		(tc) => tc.toolName === e.toolName && tc.status === "running",
	);
	if (idx < 0) return;
	const updated = [...calls];
	const extractedOutput = extractToolOutput(e.output);
	if (e.success === false) {
		const errText =
			typeof extractedOutput === "string"
				? extractedOutput
				: JSON.stringify(extractedOutput);
		updated[idx] = {
			...updated[idx]!,
			status: "error",
			error: errText,
			output: extractedOutput,
			duration: e.duration,
			permissionPending: false,
		};
	} else {
		updated[idx] = {
			...updated[idx]!,
			status: "complete",
			output: extractedOutput,
			duration: e.duration,
			permissionPending: false,
		};
	}
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: updated,
	};
}

/** Mirror of the `tool:error` → `streamingToolCalls` branch. */
function applyToolError(store: StoreShape, e: ToolErrorEvent): void {
	const runId = Object.entries(store.streamingRunToConversation).find(
		([, cId]) => cId === e.conversationId,
	)?.[0];
	if (!runId) return;
	const calls = store.streamingToolCalls[runId] ?? [];
	const idx = calls.findLastIndex(
		(tc) => tc.toolName === e.toolName && tc.status === "running",
	);
	if (idx < 0) return;
	const updated = [...calls];
	updated[idx] = {
		...updated[idx]!,
		status: "error",
		error: e.error,
		duration: e.duration,
	};
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: updated,
	};
}

// ── Helpers ────────────────────────────────────────────────────────────────

function seedRunningCall(
	store: StoreShape,
	runId: string,
	conversationId: string,
	toolName: string,
	id = `${runId}-tc`,
) {
	store.streamingRunToConversation = {
		...store.streamingRunToConversation,
		[runId]: conversationId,
	};
	store.streamingToolCalls = {
		...store.streamingToolCalls,
		[runId]: [
			{
				id,
				toolName,
				status: "running",
				input: {},
				startedAt: 0,
			},
		],
	};
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("streamingToolCalls status routing", () => {
	let store: StoreShape;
	beforeEach(() => {
		store = makeStore();
	});

	describe("tool:complete with success: true", () => {
		test("transitions running call to status='complete' (green checkmark)", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "ok",
				duration: 50,
				success: true,
			});

			const call = store.streamingToolCalls["run-1"]![0]!;
			expect(call.status).toBe("complete");
			expect(call.output).toBe("ok");
			expect(call.error).toBeUndefined();
			expect(call.permissionPending).toBe(false);
		});

		test("clears permissionPending when transitioning to complete", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");
			store.streamingToolCalls["run-1"]![0]!.permissionPending = true;

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "ok",
				duration: 1,
				success: true,
			});

			expect(store.streamingToolCalls["run-1"]![0]!.permissionPending).toBe(false);
		});
	});

	describe("tool:complete with success: false (the bug fix)", () => {
		test("transitions running call to status='error' (red X) when success=false", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "command not found",
				duration: 10,
				success: false,
			});

			const call = store.streamingToolCalls["run-1"]![0]!;
			expect(call.status).toBe("error");
			expect(call.error).toBe("command not found");
		});

		test("populates `error` from string output so ToolCallCard's error block renders", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "exit code 1: file not found",
				duration: 10,
				success: false,
			});

			expect(store.streamingToolCalls["run-1"]![0]!.error).toBe(
				"exit code 1: file not found",
			);
		});

		test("extracts ToolCallResult content[].text shape into the error string", () => {
			seedRunningCall(store, "run-1", "conv-1", "Edit");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Edit",
				output: { content: [{ type: "text", text: "permission denied" }] },
				duration: 5,
				success: false,
			});

			expect(store.streamingToolCalls["run-1"]![0]!.error).toBe("permission denied");
		});

		test("JSON-stringifies non-string error output so error block always shows something", () => {
			seedRunningCall(store, "run-1", "conv-1", "tool-x");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "tool-x",
				output: { code: "EACCES", path: "/etc/foo" },
				duration: 5,
				success: false,
			});

			expect(store.streamingToolCalls["run-1"]![0]!.error).toBe(
				'{"code":"EACCES","path":"/etc/foo"}',
			);
		});
	});

	describe("tool:complete with success undefined (legacy events)", () => {
		test("treats absent `success` as success — backwards compat", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "ok",
				duration: 1,
				// no success field
			});

			expect(store.streamingToolCalls["run-1"]![0]!.status).toBe("complete");
		});
	});

	describe("tool:error event", () => {
		test("transitions running call to status='error' with the error string", () => {
			seedRunningCall(store, "run-1", "conv-1", "Bash");

			applyToolError(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				error: "process killed",
				duration: 12,
			});

			const call = store.streamingToolCalls["run-1"]![0]!;
			expect(call.status).toBe("error");
			expect(call.error).toBe("process killed");
		});
	});

	describe("isolation between runs", () => {
		test("a failure on run-A does not affect run-B", () => {
			seedRunningCall(store, "run-A", "conv-A", "Bash", "tcA");
			seedRunningCall(store, "run-B", "conv-B", "Bash", "tcB");

			applyToolComplete(store, {
				conversationId: "conv-A",
				toolName: "Bash",
				output: "boom",
				duration: 5,
				success: false,
			});

			expect(store.streamingToolCalls["run-A"]![0]!.status).toBe("error");
			expect(store.streamingToolCalls["run-B"]![0]!.status).toBe("running");
			expect(store.streamingToolCalls["run-B"]![0]!.error).toBeUndefined();
		});

		test("only the latest running call with the matching toolName is updated", () => {
			// Two sequential Bash calls in the same run — the new failure must
			// land on the still-running one, not retroactively on a completed one.
			store.streamingRunToConversation = { "run-1": "conv-1" };
			store.streamingToolCalls = {
				"run-1": [
					{
						id: "tc1",
						toolName: "Bash",
						status: "complete",
						output: "ok",
						input: {},
						startedAt: 0,
					},
					{
						id: "tc2",
						toolName: "Bash",
						status: "running",
						input: {},
						startedAt: 1,
					},
				],
			};

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "fail",
				duration: 5,
				success: false,
			});

			const calls = store.streamingToolCalls["run-1"]!;
			// First (already-completed) call is untouched
			expect(calls[0]!.status).toBe("complete");
			expect(calls[0]!.error).toBeUndefined();
			// Second (running) call flipped to error
			expect(calls[1]!.status).toBe("error");
			expect(calls[1]!.error).toBe("fail");
		});
	});

	describe("graceful no-ops", () => {
		test("event for unknown conversation is ignored (no run mapping)", () => {
			applyToolComplete(store, {
				conversationId: "ghost",
				toolName: "Bash",
				output: "x",
				duration: 1,
				success: false,
			});
			expect(store.streamingToolCalls).toEqual({});
		});

		test("event with no matching running call is ignored", () => {
			store.streamingRunToConversation = { "run-1": "conv-1" };
			store.streamingToolCalls = { "run-1": [] };

			applyToolComplete(store, {
				conversationId: "conv-1",
				toolName: "Bash",
				output: "x",
				duration: 1,
				success: false,
			});

			expect(store.streamingToolCalls["run-1"]).toEqual([]);
		});
	});
});
