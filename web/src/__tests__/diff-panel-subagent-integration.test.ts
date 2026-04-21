/**
 * Integration test: API response → client hydration → panel input → diff aggregation.
 *
 * Simulates the full pipeline that lights up the Diff Summary panel when a
 * sub-agent (team member / invoked agent) completes edits:
 *
 *   1. Server returns `{ messages, subConversations, subConversationToolCalls }`.
 *   2. `hydrateToolCallsFromApi` (from +page.svelte) calls
 *      `inlineToolStore.hydrateToolCalls(subId, calls)` for each sub.
 *   3. The derived `diffPanelToolCalls` flattens across parent + subs.
 *   4. `aggregateToolCallDiffs` groups diffs by file path.
 *
 * The result is what the panel renders. We assert on that result.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { aggregateToolCallDiffs } from "../lib/diff-aggregator";

// ── Test stand-in for InlineToolStore with the same public surface we need ──

interface InlineToolCall {
	id: string;
	toolName: string;
	input: Record<string, unknown>;
	status: "pending" | "running" | "complete" | "error";
	output?: string;
	conversationId: string;
}

interface ApiToolCall {
	id: string;
	extensionId: string;
	toolName: string;
	input: Record<string, unknown> | null;
	outputSummary: string | null;
	success: boolean;
	durationMs: number;
	status: "success" | "error" | "interrupted";
	messageId?: string | null;
	cardType?: string | null;
}

class TestStore {
	calls: InlineToolCall[] = [];

	hydrateToolCalls(conversationId: string, toolCalls: ApiToolCall[]): void {
		const other = this.calls.filter((c) => c.conversationId !== conversationId);
		const hydrated: InlineToolCall[] = toolCalls.map((tc) => ({
			id: tc.id,
			toolName: tc.toolName,
			input: tc.input ?? {},
			status: tc.status === "success" ? "complete" : "error",
			output: tc.outputSummary ?? undefined,
			conversationId,
		}));
		this.calls = [...other, ...hydrated];
	}

	getByConversation(conversationId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.conversationId === conversationId);
	}
}

// ── Client hydration simulating +page.svelte::hydrateToolCallsFromApi ──

interface ApiResponse {
	messages: Array<{ id: string; toolCalls: ApiToolCall[] }>;
	subConversations: Array<{ id: string; agentName: string }>;
	orphanedToolCalls: ApiToolCall[];
	subConversationToolCalls: Record<string, ApiToolCall[]>;
}

function applyApiResponseToStore(
	store: TestStore,
	parentConvId: string,
	data: ApiResponse,
): { parentConvId: string; subIds: string[] } {
	// Parent: flatten message-attached + orphaned tool calls.
	const parentCalls: ApiToolCall[] = [];
	for (const msg of data.messages) {
		for (const tc of msg.toolCalls) parentCalls.push({ ...tc, messageId: msg.id });
	}
	for (const tc of data.orphanedToolCalls) parentCalls.push(tc);
	store.hydrateToolCalls(parentConvId, parentCalls);

	// Sub-conversations: hydrate each bucket under the sub's id.
	for (const [subId, calls] of Object.entries(data.subConversationToolCalls)) {
		store.hydrateToolCalls(subId, calls);
	}

	return {
		parentConvId,
		subIds: data.subConversations.map((sc) => sc.id),
	};
}

/** Derive the tool-call set the Diff Summary panel would receive. */
function diffPanelToolCalls(
	store: TestStore,
	parentConvId: string,
	subIds: string[],
): InlineToolCall[] {
	const ids = [parentConvId, ...subIds];
	return ids.flatMap((id) => store.getByConversation(id));
}

function makeApiToolCall(overrides: Partial<ApiToolCall> & { id: string }): ApiToolCall {
	return {
		extensionId: "builtin",
		toolName: "edit_file",
		input: { file_path: "x.ts", old_string: "a", new_string: "b" },
		outputSummary: "ok",
		success: true,
		durationMs: 10,
		status: "success" as const,
		...overrides,
	};
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("Diff panel end-to-end with sub-agent edits", () => {
	let store: TestStore;
	const PARENT = "parent-conv";

	beforeEach(() => {
		store = new TestStore();
	});

	test("sub-agent edit on a distinct file appears in the panel input AND in aggregated diffs", () => {
		const apiResponse: ApiResponse = {
			messages: [],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: {
				"sub-A": [
					makeApiToolCall({
						id: "sub-call-1",
						input: { file_path: "src/feature.ts", old_string: "foo", new_string: "bar" },
					}),
				],
			},
		};

		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);

		expect(panelInput).toHaveLength(1);
		expect(panelInput[0]!.conversationId).toBe("sub-A");

		const groups = aggregateToolCallDiffs(
			panelInput
				.filter((c) => c.status === "complete")
				.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/feature.ts");
	});

	test("parent + sub edits on DIFFERENT files: two groups, both file paths rendered", () => {
		const apiResponse: ApiResponse = {
			messages: [
				{
					id: "msg-1",
					toolCalls: [
						makeApiToolCall({
							id: "parent-call-1",
							input: { file_path: "src/api.ts", old_string: "x=1", new_string: "x=2" },
						}),
					],
				},
			],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: {
				"sub-A": [
					makeApiToolCall({
						id: "sub-call-1",
						input: { file_path: "src/auth.ts", old_string: "false", new_string: "true" },
					}),
				],
			},
		};

		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);
		expect(panelInput).toHaveLength(2);

		const groups = aggregateToolCallDiffs(
			panelInput
				.filter((c) => c.status === "complete")
				.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
		);
		expect(groups.map((g) => g.filePath).sort()).toEqual(["src/api.ts", "src/auth.ts"]);
	});

	test("parent + sub edits on the SAME file merge into one group with both diffs", () => {
		const apiResponse: ApiResponse = {
			messages: [
				{
					id: "msg-1",
					toolCalls: [
						makeApiToolCall({
							id: "parent-call-1",
							input: { file_path: "src/shared.ts", old_string: "a=1", new_string: "a=2" },
						}),
					],
				},
			],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: {
				"sub-A": [
					makeApiToolCall({
						id: "sub-call-1",
						input: { file_path: "src/shared.ts", old_string: "b=1", new_string: "b=3" },
					}),
				],
			},
		};

		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);

		const groups = aggregateToolCallDiffs(
			panelInput
				.filter((c) => c.status === "complete")
				.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/shared.ts");
		expect(groups[0]!.diffs).toHaveLength(2);
	});

	test("edits from multiple sub-agents on different files: all sub-agent diffs visible", () => {
		const apiResponse: ApiResponse = {
			messages: [],
			subConversations: [
				{ id: "sub-A", agentName: "agent-a" },
				{ id: "sub-B", agentName: "agent-b" },
				{ id: "sub-C", agentName: "agent-c" },
			],
			orphanedToolCalls: [],
			subConversationToolCalls: {
				"sub-A": [makeApiToolCall({ id: "a-1", input: { file_path: "a.ts", old_string: "1", new_string: "2" } })],
				"sub-B": [makeApiToolCall({ id: "b-1", input: { file_path: "b.ts", old_string: "x", new_string: "y" } })],
				"sub-C": [makeApiToolCall({ id: "c-1", input: { file_path: "c.ts", old_string: "q", new_string: "r" } })],
			},
		};

		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);
		expect(panelInput).toHaveLength(3);

		const groups = aggregateToolCallDiffs(
			panelInput
				.filter((c) => c.status === "complete")
				.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
		);
		expect(groups.map((g) => g.filePath).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	test("failed (error) sub-agent tool calls are excluded from panel aggregation (status filter)", () => {
		const apiResponse: ApiResponse = {
			messages: [],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: {
				"sub-A": [
					makeApiToolCall({
						id: "sub-ok",
						status: "success",
						input: { file_path: "src/ok.ts", old_string: "a", new_string: "b" },
					}),
					makeApiToolCall({
						id: "sub-fail",
						status: "error",
						success: false,
						input: { file_path: "src/fail.ts", old_string: "x", new_string: "y" },
					}),
				],
			},
		};

		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);

		// Failed calls are present in the store but the panel filters to status==='complete'.
		const groups = aggregateToolCallDiffs(
			panelInput
				.filter((c) => c.status === "complete")
				.map((c) => ({ toolName: c.toolName, input: c.input, output: c.output })),
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.filePath).toBe("src/ok.ts");
	});

	test("empty sub-conversation bucket (sub exists but made no edits) contributes nothing", () => {
		const apiResponse: ApiResponse = {
			messages: [],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: { "sub-A": [] },
		};
		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);
		expect(panelInput).toEqual([]);
	});

	test("regression baseline: without the subConversationToolCalls field, only parent edits show (matches the old broken behavior)", () => {
		// This confirms the original bug: if the server omits subConversationToolCalls,
		// only parent edits are visible — which is exactly what users were reporting.
		const apiResponse: ApiResponse = {
			messages: [
				{
					id: "msg-1",
					toolCalls: [
						makeApiToolCall({
							id: "parent-call",
							input: { file_path: "src/parent.ts", old_string: "a", new_string: "b" },
						}),
					],
				},
			],
			subConversations: [{ id: "sub-A", agentName: "coder" }],
			orphanedToolCalls: [],
			subConversationToolCalls: {}, // empty — simulates the old server response
		};
		const { parentConvId, subIds } = applyApiResponseToStore(store, PARENT, apiResponse);
		const panelInput = diffPanelToolCalls(store, parentConvId, subIds);
		expect(panelInput.map((c) => c.conversationId)).toEqual([PARENT]);
	});
});
