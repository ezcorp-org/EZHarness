import { test, expect, describe } from "bun:test";

/**
 * Tests for the inline tool immediate execution flow.
 *
 * The key behavior: when a user submits the InlineToolForm, the tool
 * should execute immediately via ontoolinvoke — NOT be staged for
 * later execution when the user sends a message.
 *
 * Since we can't mount Svelte components in bun:test, we test the
 * pure logic that drives this behavior.
 */

// Simulate the handleFormConfirm logic extracted from ChatInput.svelte
interface StagedToolCall {
	extensionName: string;
	toolName: string;
	input: Record<string, unknown>;
}

function handleFormConfirm(
	activeExtension: string | null,
	selectedToolName: string | null,
	input: Record<string, unknown>,
	ontoolinvoke: ((calls: StagedToolCall[]) => void) | undefined,
): { invoked: boolean } {
	if (!activeExtension || !selectedToolName) return { invoked: false };
	ontoolinvoke?.([{
		extensionName: activeExtension,
		toolName: selectedToolName,
		input,
	}]);
	return { invoked: true };
}

describe("inline tool immediate execution", () => {
	test("form submit calls ontoolinvoke immediately", () => {
		const invoked: StagedToolCall[][] = [];
		const result = handleFormConfirm(
			"task-stack",
			"list-tasks",
			{ stackId: "inbox" },
			(calls) => invoked.push(calls),
		);

		expect(result.invoked).toBe(true);
		expect(invoked).toHaveLength(1);
		expect(invoked[0]![0]!.extensionName).toBe("task-stack");
		expect(invoked[0]![0]!.toolName).toBe("list-tasks");
		expect(invoked[0]![0]!.input).toEqual({ stackId: "inbox" });
	});

	test("form submit with no active extension does nothing", () => {
		const invoked: StagedToolCall[][] = [];
		const result = handleFormConfirm(
			null,
			"list-tasks",
			{},
			(calls) => invoked.push(calls),
		);

		expect(result.invoked).toBe(false);
		expect(invoked).toHaveLength(0);
	});

	test("form submit with no selected tool does nothing", () => {
		const invoked: StagedToolCall[][] = [];
		const result = handleFormConfirm(
			"task-stack",
			null,
			{},
			(calls) => invoked.push(calls),
		);

		expect(result.invoked).toBe(false);
		expect(invoked).toHaveLength(0);
	});

	test("form submit with no ontoolinvoke callback still returns invoked", () => {
		const result = handleFormConfirm(
			"task-stack",
			"list-tasks",
			{},
			undefined,
		);

		// invoked is true because the guard passed — callback just wasn't provided
		expect(result.invoked).toBe(true);
	});

	test("form submit passes empty input correctly", () => {
		const invoked: StagedToolCall[][] = [];
		handleFormConfirm(
			"task-stack",
			"list-tasks",
			{},
			(calls) => invoked.push(calls),
		);

		expect(invoked[0]![0]!.input).toEqual({});
	});

	test("form submit passes complex input correctly", () => {
		const invoked: StagedToolCall[][] = [];
		handleFormConfirm(
			"task-stack",
			"add-task",
			{ title: "Fix bug", description: "Auth issue", stackId: "sprint", position: "top" },
			(calls) => invoked.push(calls),
		);

		expect(invoked[0]![0]!.input).toEqual({
			title: "Fix bug",
			description: "Auth issue",
			stackId: "sprint",
			position: "top",
		});
	});
});

describe("inline tool cardType flow through store", () => {
	// Test that InlineToolCall preserves cardType through the update cycle

	interface InlineToolCall {
		id: string;
		extensionName: string;
		toolName: string;
		input: Record<string, unknown>;
		status: string;
		output?: string;
		cardType?: string;
	}

	function applyStartEvent(call: InlineToolCall, data: { timestamp: number; cardType?: string }): InlineToolCall {
		const update: Partial<InlineToolCall> = { status: 'running' };
		if (data.cardType) update.cardType = data.cardType;
		return { ...call, ...update };
	}

	function applyCompleteEvent(call: InlineToolCall, data: { output: string; cardType?: string }): InlineToolCall {
		const update: Partial<InlineToolCall> = { status: 'complete', output: data.output };
		if (data.cardType) update.cardType = data.cardType;
		return { ...call, ...update };
	}

	test("cardType set on tool:start survives tool:complete", () => {
		let call: InlineToolCall = { id: "1", extensionName: "task-stack", toolName: "list-tasks", input: {}, status: "pending" };
		call = applyStartEvent(call, { timestamp: 1, cardType: "task-list" });
		expect(call.cardType).toBe("task-list");

		call = applyCompleteEvent(call, { output: "[]" });
		expect(call.cardType).toBe("task-list"); // preserved via spread
	});

	test("cardType set on tool:complete works even without tool:start", () => {
		let call: InlineToolCall = { id: "1", extensionName: "task-stack", toolName: "list-tasks", input: {}, status: "pending" };
		// Skip tool:start, go straight to complete with cardType
		call = applyCompleteEvent(call, { output: "[]", cardType: "task-list" });
		expect(call.cardType).toBe("task-list");
		expect(call.status).toBe("complete");
	});

	test("cardType on tool:complete overwrites tool:start cardType", () => {
		let call: InlineToolCall = { id: "1", extensionName: "ext", toolName: "t", input: {}, status: "pending" };
		call = applyStartEvent(call, { timestamp: 1, cardType: "old-type" });
		call = applyCompleteEvent(call, { output: "x", cardType: "new-type" });
		expect(call.cardType).toBe("new-type");
	});

	test("no cardType on either event leaves it undefined", () => {
		let call: InlineToolCall = { id: "1", extensionName: "ext", toolName: "t", input: {}, status: "pending" };
		call = applyStartEvent(call, { timestamp: 1 });
		call = applyCompleteEvent(call, { output: "x" });
		expect(call.cardType).toBeUndefined();
	});
});
