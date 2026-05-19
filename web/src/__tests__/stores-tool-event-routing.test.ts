/**
 * Tests the routing logic of `tool:start` / `tool:complete` / `tool:error`
 * events into `inlineToolStore.upsertStreaming`.
 *
 * The real routing lives inside stores.svelte.ts inside a switch statement
 * that also mutates per-run state; this test extracts just the upsert
 * behavior into a pure function that matches the same branching rules,
 * so we can exhaustively cover:
 *   - inline vs non-inline gating
 *   - missing invocationId gracefully ignored
 *   - conversation scoping (sub-agent events tagged with sub-conv id)
 *   - status transitions (running → complete/error)
 */
import { test, expect, describe, beforeEach } from "bun:test";

interface InlineToolCall {
	id: string;
	conversationId: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
	status: "pending" | "running" | "complete" | "error";
	output?: string;
	error?: string;
	retryCount: number;
	startedAt?: number;
	duration?: number;
	cardType?: string;
}

class FakeStore {
	calls: InlineToolCall[] = [];
	/** Records every upsert call so tests can assert on the sequence. */
	upsertLog: Array<{ id: string; status: string; conversationId: string }> = [];

	upsertStreaming(entry: {
		id: string;
		conversationId: string;
		extensionName: string;
		toolName: string;
		input?: Record<string, unknown>;
		status: InlineToolCall["status"];
		startedAt?: number;
		duration?: number;
		output?: string;
		error?: string;
		cardType?: string;
	}): void {
		this.upsertLog.push({ id: entry.id, status: entry.status, conversationId: entry.conversationId });
		const idx = this.calls.findIndex((c) => c.id === entry.id);
		if (idx < 0) {
			this.calls = [...this.calls, {
				retryCount: 0,
				input: entry.input ?? {},
				...entry,
			}];
			return;
		}
		const existing = this.calls[idx]!;
		const { input: entryInput, ...entryRest } = entry;
		const next = [...this.calls];
		next[idx] = {
			...existing,
			...entryRest,
			...(entryInput !== undefined ? { input: entryInput } : {}),
		};
		this.calls = next;
	}

	/** Mirror of updateFromEvent so we can check the inline branch isn't hit. */
	updateFromEventCalls: Array<{ id: string; type: string }> = [];
	updateFromEvent(id: string, type: string): void {
		this.updateFromEventCalls.push({ id, type });
	}
}

// ── Extracted routing: identical branches to stores.svelte.ts ──

type ToolStartEvent = {
	conversationId: string;
	toolName: string;
	input: unknown;
	timestamp: number;
	extensionId?: string;
	source?: string;
	invocationId?: string;
	cardType?: string;
};
type ToolCompleteEvent = {
	conversationId: string;
	toolName: string;
	output: unknown;
	duration: number;
	success?: boolean;
	source?: string;
	invocationId?: string;
	cardType?: string;
};
type ToolErrorEvent = {
	conversationId: string;
	toolName: string;
	error: string;
	duration: number;
	source?: string;
	invocationId?: string;
};

function extractToolOutput(value: unknown): unknown {
	if (value == null || typeof value !== "object") return value;
	const obj = value as Record<string, unknown>;
	if (Array.isArray(obj.content)) {
		const texts = (obj.content as any[])
			.filter((c: any) => c.type === "text" && typeof c.text === "string")
			.map((c: any) => c.text);
		if (texts.length > 0) return texts.join("\n");
	}
	return value;
}

function routeToolStart(store: FakeStore, e: ToolStartEvent): void {
	if (e.source === "inline" && e.invocationId) {
		store.updateFromEvent(e.invocationId, "tool:start");
		return;
	}
	if (e.invocationId) {
		store.upsertStreaming({
			id: e.invocationId,
			conversationId: e.conversationId,
			extensionName: e.extensionId ?? "builtin",
			toolName: e.toolName,
			input: (e.input ?? {}) as Record<string, unknown>,
			status: "running",
			startedAt: e.timestamp,
			...(e.cardType ? { cardType: e.cardType } : {}),
		});
	}
}

function routeToolComplete(store: FakeStore, e: ToolCompleteEvent): void {
	if (e.source === "inline" && e.invocationId) {
		store.updateFromEvent(e.invocationId, e.success === false ? "tool:error" : "tool:complete");
		return;
	}
	if (e.invocationId) {
		const extracted = extractToolOutput(e.output);
		const outputText = typeof extracted === "string" ? extracted : JSON.stringify(extracted);
		store.upsertStreaming({
			id: e.invocationId,
			conversationId: e.conversationId,
			extensionName: "builtin",
			toolName: e.toolName,
			status: e.success === false ? "error" : "complete",
			output: outputText,
			duration: e.duration,
			...(e.cardType ? { cardType: e.cardType } : {}),
		});
	}
}

function routeToolError(store: FakeStore, e: ToolErrorEvent): void {
	if (e.source === "inline" && e.invocationId) {
		store.updateFromEvent(e.invocationId, "tool:error");
		return;
	}
	if (e.invocationId) {
		store.upsertStreaming({
			id: e.invocationId,
			conversationId: e.conversationId,
			extensionName: "builtin",
			toolName: e.toolName,
			status: "error",
			error: e.error,
			duration: e.duration,
		});
	}
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("stores.svelte.ts tool-event routing", () => {
	let store: FakeStore;
	beforeEach(() => { store = new FakeStore(); });

	test("non-inline tool:start with invocationId upserts status='running'", () => {
		routeToolStart(store, {
			conversationId: "conv-1",
			toolName: "edit_file",
			input: { file_path: "x.ts" },
			timestamp: 1000,
			invocationId: "tc-1",
		});
		expect(store.calls).toHaveLength(1);
		expect(store.calls[0]!.status).toBe("running");
		expect(store.calls[0]!.conversationId).toBe("conv-1");
		expect(store.calls[0]!.input.file_path).toBe("x.ts");
	});

	test("non-inline tool:complete with matching invocationId transitions to 'complete' and keeps input", () => {
		routeToolStart(store, {
			conversationId: "conv-1", toolName: "edit_file",
			input: { file_path: "x.ts" }, timestamp: 1000, invocationId: "tc-1",
		});
		routeToolComplete(store, {
			conversationId: "conv-1", toolName: "edit_file",
			output: { content: [{ type: "text", text: "done" }] },
			duration: 50, success: true, invocationId: "tc-1",
		});
		expect(store.calls).toHaveLength(1);
		expect(store.calls[0]!.status).toBe("complete");
		expect(store.calls[0]!.duration).toBe(50);
		expect(store.calls[0]!.output).toBe("done");
		// input from tool:start preserved
		expect(store.calls[0]!.input.file_path).toBe("x.ts");
	});

	test("non-inline tool:error captures error message and transitions to 'error'", () => {
		routeToolStart(store, {
			conversationId: "conv-1", toolName: "edit_file",
			input: { file_path: "x.ts" }, timestamp: 1000, invocationId: "tc-1",
		});
		routeToolError(store, {
			conversationId: "conv-1", toolName: "edit_file",
			error: "file not found", duration: 10, invocationId: "tc-1",
		});
		expect(store.calls[0]!.status).toBe("error");
		expect(store.calls[0]!.error).toBe("file not found");
	});

	test("inline source takes the updateFromEvent path — no upsert", () => {
		routeToolStart(store, {
			source: "inline",
			invocationId: "inline-1",
			conversationId: "conv-1", toolName: "invoke_ext",
			input: {}, timestamp: 0,
		});
		expect(store.upsertLog).toHaveLength(0);
		expect(store.updateFromEventCalls).toHaveLength(1);
	});

	test("non-inline event missing invocationId is ignored by the upsert path (graceful)", () => {
		routeToolStart(store, {
			conversationId: "conv-1", toolName: "edit_file",
			input: { file_path: "x.ts" }, timestamp: 1000,
			// no invocationId
		});
		expect(store.upsertLog).toHaveLength(0);
		expect(store.calls).toHaveLength(0);
	});

	test("sub-agent event (sub-conv's conversationId) tags the entry under the sub id", () => {
		routeToolStart(store, {
			conversationId: "sub-A",
			toolName: "edit_file",
			input: { file_path: "x.ts" }, timestamp: 1000, invocationId: "sub-tc-1",
		});
		expect(store.calls[0]!.conversationId).toBe("sub-A");
	});

	test("full lifecycle for two concurrent sub-agents doesn't cross-contaminate", () => {
		// sub-A starts and completes
		routeToolStart(store, {
			conversationId: "sub-A", toolName: "edit_file",
			input: { file_path: "a.ts" }, timestamp: 1, invocationId: "a-tc",
		});
		// sub-B starts
		routeToolStart(store, {
			conversationId: "sub-B", toolName: "edit_file",
			input: { file_path: "b.ts" }, timestamp: 2, invocationId: "b-tc",
		});
		// sub-A completes first
		routeToolComplete(store, {
			conversationId: "sub-A", toolName: "edit_file",
			output: "A done", duration: 10, success: true, invocationId: "a-tc",
		});
		// sub-B completes
		routeToolComplete(store, {
			conversationId: "sub-B", toolName: "edit_file",
			output: "B done", duration: 12, success: true, invocationId: "b-tc",
		});

		expect(store.calls).toHaveLength(2);
		const a = store.calls.find((c) => c.id === "a-tc")!;
		const b = store.calls.find((c) => c.id === "b-tc")!;
		expect(a.conversationId).toBe("sub-A");
		expect(a.status).toBe("complete");
		expect(a.input.file_path).toBe("a.ts");
		expect(b.conversationId).toBe("sub-B");
		expect(b.status).toBe("complete");
		expect(b.input.file_path).toBe("b.ts");
	});

	test("tool:complete arriving WITHOUT a preceding tool:start still creates a usable entry", () => {
		// Edge case: network hiccup drops tool:start event. The complete event
		// alone is enough to show the file changed (aggregator only needs input
		// file_path/path, which isn't in complete — so this entry wouldn't render
		// a diff but also shouldn't break anything).
		routeToolComplete(store, {
			conversationId: "conv-1", toolName: "edit_file",
			output: "done", duration: 5, success: true, invocationId: "tc-orphan",
		});
		expect(store.calls).toHaveLength(1);
		expect(store.calls[0]!.status).toBe("complete");
		// No input known — that's OK; aggregator will skip it.
		expect(store.calls[0]!.input).toEqual({});
	});

	test("output extraction: ToolCallResult shape → joined text; other shapes → JSON", () => {
		routeToolStart(store, {
			conversationId: "conv-1", toolName: "edit_file",
			input: {}, timestamp: 0, invocationId: "t1",
		});
		routeToolComplete(store, {
			conversationId: "conv-1", toolName: "edit_file",
			output: { content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
			duration: 1, success: true, invocationId: "t1",
		});
		expect(store.calls[0]!.output).toBe("line1\nline2");

		routeToolStart(store, {
			conversationId: "conv-1", toolName: "other", input: {}, timestamp: 0, invocationId: "t2",
		});
		routeToolComplete(store, {
			conversationId: "conv-1", toolName: "other",
			output: { foo: "bar" }, duration: 1, success: true, invocationId: "t2",
		});
		// Non-ToolCallResult shape falls through to JSON stringify.
		expect(store.calls.find((c) => c.id === "t2")!.output).toBe('{"foo":"bar"}');
	});
});
