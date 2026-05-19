import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Unit tests for the tool call anchoring fix.
 *
 * Tests the pure logic that ensures inline tool calls are anchored
 * to the correct message via messageId, and that hydration preserves
 * messageId from the API response.
 */

interface InlineToolCall {
	id: string;
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
	status: "pending" | "running" | "complete" | "error";
	output?: string;
	error?: string;
	retryCount: number;
	startedAt?: number;
	duration?: number;
	conversationId: string;
	messageId?: string;
	cardType?: string;
	cardLayout?: "inline" | "dock";
}

interface HydrateInput {
	id: string;
	extensionId: string;
	toolName: string;
	input: Record<string, unknown> | null;
	outputSummary: string | null;
	success: boolean;
	durationMs: number;
	status: "success" | "error" | "interrupted";
	messageId?: string;
	cardType?: string | null;
	fullOutput?: string | null;
}

/** Mirrors the real InlineToolStore without Svelte 5 runes. */
class TestInlineToolStore {
	calls: InlineToolCall[] = [];

	add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
		this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
	}

	getByMessage(messageId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.messageId === messageId);
	}

	getByConversation(conversationId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.conversationId === conversationId);
	}

	hydrateToolCalls(conversationId: string, toolCalls: HydrateInput[]): void {
		const otherCalls = this.calls.filter((c) => c.conversationId !== conversationId);
		const hydrated: InlineToolCall[] = toolCalls.map((tc) => ({
			id: tc.id,
			extensionName: tc.extensionId,
			toolName: tc.toolName,
			input: tc.input ?? {},
			status:
				tc.status === "interrupted"
					? ("error" as const)
					: tc.status === "error"
						? ("error" as const)
						: ("complete" as const),
			output: tc.fullOutput ?? tc.outputSummary ?? undefined,
			error:
				tc.status === "interrupted"
					? "interrupted"
					: tc.status === "error"
						? "Error"
						: undefined,
			retryCount: 0,
			duration: tc.durationMs,
			conversationId,
			messageId: tc.messageId,
			cardType: tc.cardType ?? undefined,
		}));
		this.calls = [...otherCalls, ...hydrated];
	}
}

/**
 * Mirrors the messageId derivation logic from handleToolInvoke in +page.svelte.
 * activeLeafId is passed as messageId, but streaming placeholders are stripped.
 */
function deriveMessageId(activeLeafId: string | null | undefined): string | undefined {
	if (!activeLeafId) return undefined;
	if (activeLeafId.startsWith("streaming-")) return undefined;
	return activeLeafId;
}

describe("Tool call anchoring fix", () => {
	let store: TestInlineToolStore;

	beforeEach(() => {
		store = new TestInlineToolStore();
	});

	test("activeLeafId is passed as messageId", () => {
		const messageId = deriveMessageId("msg-1");
		expect(messageId).toBe("msg-1");

		store.add({
			id: "inv-1",
			extensionName: "ext-task-stack",
			toolName: "list-tasks",
			input: {},
			conversationId: "conv-1",
			messageId,
		});

		expect(store.calls[0]!.messageId).toBe("msg-1");
	});

	test("streaming- prefix is stripped from activeLeafId", () => {
		const messageId = deriveMessageId("streaming-run-1");
		expect(messageId).toBeUndefined();
	});

	test("null activeLeafId produces undefined messageId", () => {
		const messageId = deriveMessageId(null);
		expect(messageId).toBeUndefined();
	});

	test("hydration preserves messageId from API", () => {
		store.hydrateToolCalls("conv-1", [
			{
				id: "tc-1",
				extensionId: "ext-task-stack",
				toolName: "list-tasks",
				input: {},
				outputSummary: "[]",
				success: true,
				durationMs: 100,
				status: "success",
				messageId: "msg-1",
			},
		]);

		expect(store.calls[0]!.messageId).toBe("msg-1");
	});

	test("hydration handles null messageId", () => {
		store.hydrateToolCalls("conv-1", [
			{
				id: "tc-1",
				extensionId: "ext-task-stack",
				toolName: "list-tasks",
				input: {},
				outputSummary: "[]",
				success: true,
				durationMs: 100,
				status: "success",
				messageId: undefined,
			},
		]);

		expect(store.calls[0]!.messageId).toBeUndefined();
	});

	test("getByMessage returns calls with matching messageId", () => {
		store.add({
			id: "inv-1",
			extensionName: "ext-a",
			toolName: "tool-a",
			input: {},
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		store.add({
			id: "inv-2",
			extensionName: "ext-b",
			toolName: "tool-b",
			input: {},
			conversationId: "conv-1",
			messageId: "msg-2",
		});
		store.add({
			id: "inv-3",
			extensionName: "ext-c",
			toolName: "tool-c",
			input: {},
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		const msg1Calls = store.getByMessage("msg-1");
		expect(msg1Calls).toHaveLength(2);
		expect(msg1Calls.map((c) => c.id)).toEqual(["inv-1", "inv-3"]);

		const msg2Calls = store.getByMessage("msg-2");
		expect(msg2Calls).toHaveLength(1);
		expect(msg2Calls[0]!.id).toBe("inv-2");
	});

	test("calls without messageId don't match any message", () => {
		store.add({
			id: "inv-1",
			extensionName: "ext-a",
			toolName: "tool-a",
			input: {},
			conversationId: "conv-1",
			// no messageId
		});
		store.add({
			id: "inv-2",
			extensionName: "ext-b",
			toolName: "tool-b",
			input: {},
			conversationId: "conv-1",
			messageId: "msg-1",
		});

		const msg1Calls = store.getByMessage("msg-1");
		expect(msg1Calls).toHaveLength(1);
		expect(msg1Calls[0]!.id).toBe("inv-2");

		// Unanchored calls have undefined messageId — getByMessage("undefined") should not match
		const noMatch = store.getByMessage("undefined");
		expect(noMatch).toHaveLength(0);

		// Verify the unanchored call is retrievable via conversation filter + messageId check
		const allCalls = store.getByConversation("conv-1");
		const unanchored = allCalls.filter((c) => !c.messageId);
		expect(unanchored).toHaveLength(1);
		expect(unanchored[0]!.id).toBe("inv-1");
	});
});

// ── getHistoricalToolCalls cardType mapping ──

describe("getHistoricalToolCalls cardType mapping", () => {
	// Simulate the mapping function from +page.svelte getHistoricalToolCalls
	function mapToToolCallState(calls: InlineToolCall[]): Array<{
		id: string; toolName: string; status: string; input: Record<string, unknown>;
		output?: string; cardType?: string; extensionId: string;
	}> {
		return calls.map((c, i) => ({
			id: c.id,
			toolName: c.toolName,
			status: c.status === "complete" ? "complete" : c.status === "error" ? "error" : "running",
			input: c.input,
			output: c.output,
			startedAt: c.startedAt ?? i,
			duration: c.duration,
			extensionId: c.extensionName,
			cardType: c.cardType,
		}));
	}

	test("includes cardType when present on InlineToolCall", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-1", extensionName: "task-stack", toolName: "list-tasks",
			input: {}, status: "complete", retryCount: 0, conversationId: "c-1",
			output: "[]", cardType: "task-list",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardType).toBe("task-list");
	});

	test("cardType is undefined when not set on InlineToolCall", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-2", extensionName: "some-ext", toolName: "do-thing",
			input: {}, status: "complete", retryCount: 0, conversationId: "c-1",
			output: "done",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardType).toBeUndefined();
	});

	test("task-detail cardType flows through", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-3", extensionName: "task-stack", toolName: "add-task",
			input: { title: "Test" }, status: "complete", retryCount: 0,
			conversationId: "c-1", output: '{"id":"t-1","title":"Test"}',
			cardType: "task-detail",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardType).toBe("task-detail");
	});
});

// ── getHistoricalToolCalls cardLayout mapping ──
// Regression for canvas-dock-sdk: after a streaming run completes,
// `getHistoricalToolCalls` projects InlineToolCalls → ToolCallState. If
// `cardLayout` is dropped here, `ToolCallCard.shouldRenderInDock` becomes
// false on the persisted message and the canvas renders inline. Mirror
// the +page.svelte mapping (now including cardLayout) and assert that
// `dock` rides through.
describe("getHistoricalToolCalls cardLayout mapping", () => {
	function mapToToolCallState(calls: InlineToolCall[]): Array<{
		id: string;
		toolName: string;
		status: string;
		cardType?: string;
		cardLayout?: "inline" | "dock";
	}> {
		return calls.map((c, i) => ({
			id: c.id,
			toolName: c.toolName,
			status: c.status === "complete" ? "complete" : c.status === "error" ? "error" : "running",
			input: c.input,
			output: c.output,
			startedAt: c.startedAt ?? i,
			duration: c.duration,
			extensionId: c.extensionName,
			cardType: c.cardType,
			cardLayout: c.cardLayout,
		}));
	}

	test("cardLayout='dock' rides through to ToolCallState", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-canvas-1",
			extensionName: "claude-design",
			toolName: "open-canvas",
			input: { draftId: "d-1" },
			status: "complete",
			retryCount: 0,
			conversationId: "c-1",
			messageId: "m-asst-1",
			output: "ok",
			cardType: "design-canvas",
			cardLayout: "dock",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardLayout).toBe("dock");
		expect(mapped[0]!.cardType).toBe("design-canvas");
	});

	test("cardLayout='inline' rides through to ToolCallState", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-x",
			extensionName: "task-stack",
			toolName: "list-tasks",
			input: {},
			status: "complete",
			retryCount: 0,
			conversationId: "c-1",
			cardLayout: "inline",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardLayout).toBe("inline");
	});

	test("missing cardLayout maps to undefined (treated as inline by shouldRenderInDock)", () => {
		const calls: InlineToolCall[] = [{
			id: "tc-y",
			extensionName: "ext",
			toolName: "tool",
			input: {},
			status: "complete",
			retryCount: 0,
			conversationId: "c-1",
		}];
		const mapped = mapToToolCallState(calls);
		expect(mapped[0]!.cardLayout).toBeUndefined();
	});
});
