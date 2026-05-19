/**
 * Integration test: event bus → inline store upsert → Diff panel aggregator.
 *
 * Simulates the full push-based pipeline that now drives live Diff Summary
 * updates during team orchestration:
 *
 *   agent:spawn → sub `tool:start` → sub `tool:complete` → agent:complete
 *        └── upsertStreaming(subConvId, …) on each tool event
 *
 * Asserts the Diff panel's aggregator sees the correct file-change groups
 * after the sub-agent's tool:complete — no API refetch, no DOM event hop.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { aggregateToolCallDiffs } from "../lib/diff-aggregator";

// ── Store stand-in with upsertStreaming semantics ──────────────────────

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

class TestStore {
	calls: InlineToolCall[] = [];
	getByConversation(id: string): InlineToolCall[] {
		return this.calls.filter((c) => c.conversationId === id);
	}
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
		const idx = this.calls.findIndex((c) => c.id === entry.id);
		if (idx < 0) {
			this.calls = [...this.calls, { retryCount: 0, input: entry.input ?? {}, ...entry }];
			return;
		}
		const existing = this.calls[idx]!;
		const { input: entryInput, ...rest } = entry;
		const next = [...this.calls];
		next[idx] = {
			...existing,
			...rest,
			...(entryInput !== undefined ? { input: entryInput } : {}),
		};
		this.calls = next;
	}
}

// ── Simulated dispatcher: mirrors the stores.svelte.ts routing rules ──

type AnyEvent =
	| { type: "agent:spawn"; data: { subConversationId: string; agentName: string; parentConversationId: string } }
	| { type: "tool:start"; data: { conversationId: string; toolName: string; input: unknown; timestamp: number; invocationId?: string; source?: string } }
	| { type: "tool:complete"; data: { conversationId: string; toolName: string; output: unknown; duration: number; success?: boolean; invocationId?: string; source?: string } }
	| { type: "agent:complete"; data: { subConversationId: string; success: boolean; parentConversationId: string } };

function dispatch(store: TestStore, event: AnyEvent): void {
	switch (event.type) {
		case "tool:start":
			if (event.data.source === "inline") return;
			if (!event.data.invocationId) return;
			store.upsertStreaming({
				id: event.data.invocationId,
				conversationId: event.data.conversationId,
				extensionName: "builtin",
				toolName: event.data.toolName,
				input: (event.data.input ?? {}) as Record<string, unknown>,
				status: "running",
				startedAt: event.data.timestamp,
			});
			return;
		case "tool:complete":
			if (event.data.source === "inline") return;
			if (!event.data.invocationId) return;
			store.upsertStreaming({
				id: event.data.invocationId,
				conversationId: event.data.conversationId,
				extensionName: "builtin",
				toolName: event.data.toolName,
				status: event.data.success === false ? "error" : "complete",
				duration: event.data.duration,
			});
			return;
		// agent:spawn and agent:complete are no-ops for the inline store in the new design.
		case "agent:spawn":
		case "agent:complete":
			return;
	}
}

// ── Union + aggregate helper ──────────────────────────────────────────

function diffPanelToolCalls(
	store: TestStore,
	parentConvId: string,
	subIds: string[],
): InlineToolCall[] {
	const ids = [parentConvId, ...subIds];
	return ids.flatMap((id) => store.getByConversation(id));
}

function aggregateForPanel(calls: InlineToolCall[]) {
	return aggregateToolCallDiffs(
		calls
			.filter((c) => c.status === "complete")
			.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
	);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Diff panel push flow (sub-agent → inline store → aggregator)", () => {
	let store: TestStore;
	beforeEach(() => { store = new TestStore(); });

	test("single sub-agent edit flows into the panel via tool:complete alone", () => {
		const parent = "parent-1";
		const sub = "sub-A";

		// Sequence of events a team orchestration would produce.
		dispatch(store, { type: "agent:spawn", data: { subConversationId: sub, agentName: "Coder", parentConversationId: parent } });
		dispatch(store, { type: "tool:start", data: { conversationId: sub, toolName: "edit_file", input: { file_path: "src/feature.ts", old_string: "a", new_string: "b" }, timestamp: 1, invocationId: "inv-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: sub, toolName: "edit_file", output: "ok", duration: 5, success: true, invocationId: "inv-1" } });
		dispatch(store, { type: "agent:complete", data: { subConversationId: sub, success: true, parentConversationId: parent } });

		const panelInput = diffPanelToolCalls(store, parent, [sub]);
		expect(panelInput).toHaveLength(1);
		expect(panelInput[0]!.status).toBe("complete");
		expect(panelInput[0]!.input.file_path).toBe("src/feature.ts");

		const groups = aggregateForPanel(panelInput);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/feature.ts");
	});

	test("two concurrent sub-agents don't cross-contaminate; aggregator sees both", () => {
		const parent = "parent-1";
		const [sA, sB] = ["sub-A", "sub-B"];

		// Both spawned
		dispatch(store, { type: "agent:spawn", data: { subConversationId: sA, agentName: "A", parentConversationId: parent } });
		dispatch(store, { type: "agent:spawn", data: { subConversationId: sB, agentName: "B", parentConversationId: parent } });

		// Interleaved tool events
		dispatch(store, { type: "tool:start", data: { conversationId: sA, toolName: "edit_file", input: { file_path: "a.ts", old_string: "x", new_string: "y" }, timestamp: 1, invocationId: "A-1" } });
		dispatch(store, { type: "tool:start", data: { conversationId: sB, toolName: "edit_file", input: { file_path: "b.ts", old_string: "p", new_string: "q" }, timestamp: 2, invocationId: "B-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: sB, toolName: "edit_file", output: "ok", duration: 10, success: true, invocationId: "B-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: sA, toolName: "edit_file", output: "ok", duration: 11, success: true, invocationId: "A-1" } });

		dispatch(store, { type: "agent:complete", data: { subConversationId: sA, success: true, parentConversationId: parent } });
		dispatch(store, { type: "agent:complete", data: { subConversationId: sB, success: true, parentConversationId: parent } });

		const groups = aggregateForPanel(diffPanelToolCalls(store, parent, [sA, sB]));
		expect(groups.map((g) => g.filePath).sort()).toEqual(["a.ts", "b.ts"]);
	});

	test("agent:complete alone (no tool events) produces no orphan inline entries", () => {
		// Regression test for the old DOM-event hack being removed: if a
		// sub-agent run reports complete without any tool events, the inline
		// store MUST stay empty. (Previously we triggered a refetch here,
		// which could have introduced ghost entries if the API returned
		// stale data.)
		const parent = "parent-1";
		const sub = "sub-idle";
		dispatch(store, { type: "agent:spawn", data: { subConversationId: sub, agentName: "Idle", parentConversationId: parent } });
		dispatch(store, { type: "agent:complete", data: { subConversationId: sub, success: true, parentConversationId: parent } });

		expect(store.getByConversation(sub)).toEqual([]);
		expect(store.calls).toEqual([]);
	});

	test("parent and sub edit the same file → aggregator merges into one group", () => {
		const parent = "parent-1";
		const sub = "sub-A";

		// Parent edits
		dispatch(store, { type: "tool:start", data: { conversationId: parent, toolName: "edit_file", input: { file_path: "shared.ts", old_string: "a=1", new_string: "a=2" }, timestamp: 1, invocationId: "P-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: parent, toolName: "edit_file", output: "ok", duration: 5, success: true, invocationId: "P-1" } });

		// Sub-agent edits the same file
		dispatch(store, { type: "agent:spawn", data: { subConversationId: sub, agentName: "Coder", parentConversationId: parent } });
		dispatch(store, { type: "tool:start", data: { conversationId: sub, toolName: "edit_file", input: { file_path: "shared.ts", old_string: "b=1", new_string: "b=3" }, timestamp: 2, invocationId: "S-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: sub, toolName: "edit_file", output: "ok", duration: 5, success: true, invocationId: "S-1" } });

		const groups = aggregateForPanel(diffPanelToolCalls(store, parent, [sub]));
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("shared.ts");
		expect(groups[0]!.diffs).toHaveLength(2);
	});

	test("errored sub-agent tool is present in the store but filtered out of aggregation", () => {
		const parent = "parent-1";
		const sub = "sub-A";
		dispatch(store, { type: "tool:start", data: { conversationId: sub, toolName: "edit_file", input: { file_path: "bad.ts", old_string: "x", new_string: "y" }, timestamp: 1, invocationId: "E-1" } });
		dispatch(store, { type: "tool:complete", data: { conversationId: sub, toolName: "edit_file", output: "error", duration: 1, success: false, invocationId: "E-1" } });

		// Entry exists with status='error'.
		expect(store.getByConversation(sub)).toHaveLength(1);
		expect(store.getByConversation(sub)[0]!.status).toBe("error");

		// But the panel's aggregator filters to status='complete'.
		const groups = aggregateForPanel(diffPanelToolCalls(store, parent, [sub]));
		expect(groups).toHaveLength(0);
	});

	test("re-dispatching the same tool:start (idempotency) doesn't create duplicates", () => {
		const sub = "sub-A";
		const start = { type: "tool:start" as const, data: { conversationId: sub, toolName: "edit_file", input: { file_path: "x.ts" }, timestamp: 1, invocationId: "dup-1" } };
		dispatch(store, start);
		dispatch(store, start); // replay (e.g. from reconnection)
		expect(store.getByConversation(sub)).toHaveLength(1);
	});
});
