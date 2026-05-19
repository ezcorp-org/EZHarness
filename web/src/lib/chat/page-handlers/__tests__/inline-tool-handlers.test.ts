/**
 * Unit tests for makeInlineToolHandlers.
 *
 * The handlers were lifted out of the chat `+page.svelte` (W3 of the chat-page
 * split). They mutate `inlineToolStore` directly and call `invokeInlineTool` /
 * `userFetch`, so this suite mocks the three modules and asserts the wiring
 * is unchanged from the original page.
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";

// ── Mocks ────────────────────────────────────────────────────────────────
//
// We mock the three transitive dependencies BEFORE the SUT is imported so
// that Bun's module cache resolves to the doubles.

const inlineToolStoreMock = {
	add: mock((_call: Record<string, unknown>) => {}),
	updateFromEvent: mock((_id: string, _event: string, _data: Record<string, unknown>) => {}),
};

const invokeInlineToolMock = mock((_params: Record<string, unknown>) => {});

// userFetch is async; default to a resolved 200 with an empty tool list.
const userFetchMock = mock(async (_url: string, _init?: RequestInit) => {
	return new Response(JSON.stringify({ tools: [] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
});

mock.module("$lib/inline-tool-store.svelte.js", () => ({
	inlineToolStore: inlineToolStoreMock,
}));

mock.module("$lib/invoke-inline-tool.js", () => ({
	invokeInlineTool: invokeInlineToolMock,
}));

mock.module("$lib/utils/fetch-policy.js", () => ({
	userFetch: userFetchMock,
}));

afterAll(() => mock.restore());

// Now safe to import the SUT.
const { makeInlineToolHandlers } = await import("../inline-tool-handlers.js");
type InlineToolCall = import("$lib/inline-tool-store.svelte.js").InlineToolCall;
type ToolDefinition = import("../../../../../../src/extensions/types").ToolDefinition;

// ── Helpers ──────────────────────────────────────────────────────────────

interface HostState {
	convId: string;
	activeLeafId: string | null;
	editRetryCall: InlineToolCall | null;
	editRetryTool: ToolDefinition | null;
}

function makeHost(initial: Partial<HostState> = {}) {
	const state: HostState = {
		convId: "conv-1",
		activeLeafId: "msg-leaf-1",
		editRetryCall: null,
		editRetryTool: null,
		...initial,
	};
	const host = {
		convId: () => state.convId,
		activeLeafId: () => state.activeLeafId,
		getEditRetry: () => ({ call: state.editRetryCall, tool: state.editRetryTool }),
		setEditRetry: (call: InlineToolCall | null, tool: ToolDefinition | null) => {
			state.editRetryCall = call;
			state.editRetryTool = tool;
		},
	};
	return { host, state };
}

function makeCall(overrides: Partial<InlineToolCall> = {}): InlineToolCall {
	return {
		id: "call-1",
		extensionName: "ext",
		toolName: "do-thing",
		input: { foo: "bar" },
		status: "running",
		retryCount: 0,
		conversationId: "conv-1",
		messageId: "msg-1",
		startedAt: 1000,
		...overrides,
	};
}

function makeTool(name = "do-thing"): ToolDefinition {
	return {
		name,
		description: "test tool",
		inputSchema: { type: "object", properties: {} },
	};
}

beforeEach(() => {
	inlineToolStoreMock.add.mockClear();
	inlineToolStoreMock.updateFromEvent.mockClear();
	invokeInlineToolMock.mockClear();
	userFetchMock.mockClear();
	// Reset userFetch to the default success response between tests; individual
	// tests override via mockImplementationOnce when they need different shapes.
	userFetchMock.mockImplementation(async () =>
		new Response(JSON.stringify({ tools: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe("handleToolInvoke", () => {
	test("invokes once per call with the host's convId and current leaf as messageId", () => {
		const { host } = makeHost({ convId: "conv-A", activeLeafId: "leaf-A" });
		const handlers = makeInlineToolHandlers(host);

		handlers.handleToolInvoke([
			{ extensionName: "git", toolName: "status", input: {} },
			{ extensionName: "fs", toolName: "read", input: { path: "/x" } },
		]);

		expect(invokeInlineToolMock).toHaveBeenCalledTimes(2);
		expect(invokeInlineToolMock.mock.calls[0]![0]).toEqual({
			conversationId: "conv-A",
			extensionName: "git",
			toolName: "status",
			input: {},
			messageId: "leaf-A",
		});
		expect(invokeInlineToolMock.mock.calls[1]![0]).toEqual({
			conversationId: "conv-A",
			extensionName: "fs",
			toolName: "read",
			input: { path: "/x" },
			messageId: "leaf-A",
		});
	});

	test("strips the messageId when activeLeafId is a streaming placeholder", () => {
		const { host } = makeHost({ activeLeafId: "streaming-abc-123" });
		const handlers = makeInlineToolHandlers(host);

		handlers.handleToolInvoke([{ extensionName: "e", toolName: "t", input: {} }]);

		expect(invokeInlineToolMock).toHaveBeenCalledTimes(1);
		expect(invokeInlineToolMock.mock.calls[0]![0]).toMatchObject({ messageId: undefined });
	});

	test("strips the messageId when activeLeafId is null", () => {
		const { host } = makeHost({ activeLeafId: null });
		const handlers = makeInlineToolHandlers(host);

		handlers.handleToolInvoke([{ extensionName: "e", toolName: "t", input: {} }]);

		expect(invokeInlineToolMock.mock.calls[0]![0]).toMatchObject({ messageId: undefined });
	});

	test("host getters are read fresh on each invocation (not captured at factory time)", () => {
		const { host, state } = makeHost({ convId: "conv-1", activeLeafId: "leaf-1" });
		const handlers = makeInlineToolHandlers(host);

		handlers.handleToolInvoke([{ extensionName: "e", toolName: "t", input: {} }]);
		// Mutate host state between calls — handler must observe the new values.
		state.convId = "conv-2";
		state.activeLeafId = "leaf-2";
		handlers.handleToolInvoke([{ extensionName: "e", toolName: "t", input: {} }]);

		expect(invokeInlineToolMock.mock.calls[0]![0]).toMatchObject({
			conversationId: "conv-1",
			messageId: "leaf-1",
		});
		expect(invokeInlineToolMock.mock.calls[1]![0]).toMatchObject({
			conversationId: "conv-2",
			messageId: "leaf-2",
		});
	});
});

describe("handleInlineRetry", () => {
	test("re-invokes the call using the call's own conversationId/messageId (not the host's)", () => {
		// Important: retry uses the original call's anchor, not the current
		// active leaf — so a retry from a historical card doesn't "jump" anchor.
		const { host } = makeHost({ convId: "conv-host", activeLeafId: "leaf-host" });
		const handlers = makeInlineToolHandlers(host);

		const call = makeCall({
			conversationId: "conv-original",
			messageId: "msg-original",
			extensionName: "ext-x",
			toolName: "tool-x",
			input: { a: 1 },
		});
		handlers.handleInlineRetry(call);

		expect(invokeInlineToolMock).toHaveBeenCalledTimes(1);
		expect(invokeInlineToolMock.mock.calls[0]![0]).toEqual({
			conversationId: "conv-original",
			extensionName: "ext-x",
			toolName: "tool-x",
			input: { a: 1 },
			messageId: "msg-original",
		});
	});
});

describe("handleInlineEditRetry", () => {
	test("fetches tool list and parks the call+tool pair via setEditRetry", async () => {
		const tool = makeTool("do-thing");
		userFetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ tools: [tool, makeTool("other")] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const { host, state } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		const call = makeCall({ extensionName: "ext-y", toolName: "do-thing" });

		await handlers.handleInlineEditRetry(call);

		expect(userFetchMock).toHaveBeenCalledTimes(1);
		expect(userFetchMock.mock.calls[0]![0]).toBe("/api/extensions/ext-y/tools");
		expect(state.editRetryCall).toBe(call);
		expect(state.editRetryTool).toEqual(tool);
	});

	test("URL-encodes extension names that contain reserved characters", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ tools: [] }), { status: 200 }),
		);
		const { host } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		await handlers.handleInlineEditRetry(makeCall({ extensionName: "ext/with slash" }));
		expect(userFetchMock.mock.calls[0]![0]).toBe(
			`/api/extensions/${encodeURIComponent("ext/with slash")}/tools`,
		);
	});

	test("does NOT park when the response is not ok", async () => {
		userFetchMock.mockImplementationOnce(async () => new Response("nope", { status: 500 }));
		const { host, state } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		await handlers.handleInlineEditRetry(makeCall());
		expect(state.editRetryCall).toBeNull();
		expect(state.editRetryTool).toBeNull();
	});

	test("does NOT park when the tool name is missing from the response", async () => {
		userFetchMock.mockImplementationOnce(async () =>
			new Response(JSON.stringify({ tools: [makeTool("other-thing")] }), { status: 200 }),
		);
		const { host, state } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		await handlers.handleInlineEditRetry(makeCall({ toolName: "do-thing" }));
		expect(state.editRetryCall).toBeNull();
		expect(state.editRetryTool).toBeNull();
	});

	test("swallows fetch errors silently (no throw, no parking)", async () => {
		userFetchMock.mockImplementationOnce(async () => {
			throw new Error("network down");
		});
		const { host, state } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		await handlers.handleInlineEditRetry(makeCall());
		expect(state.editRetryCall).toBeNull();
	});
});

describe("handleEditRetryConfirm", () => {
	test("no-ops when the edit-retry slot is empty", () => {
		const { host } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		handlers.handleEditRetryConfirm({ foo: "bar" });
		expect(inlineToolStoreMock.add).not.toHaveBeenCalled();
		expect(userFetchMock).not.toHaveBeenCalled();
	});

	test("adds to store, posts to /api/tool-invoke, then clears the slot", () => {
		const parkedCall = makeCall({
			conversationId: "conv-parked",
			messageId: "msg-parked",
			extensionName: "ext-z",
			toolName: "tool-z",
		});
		const { host, state } = makeHost({
			editRetryCall: parkedCall,
			editRetryTool: makeTool("tool-z"),
		});
		const handlers = makeInlineToolHandlers(host);

		handlers.handleEditRetryConfirm({ updated: true });

		// Store entry created with a fresh invocationId, NOT the original call.id.
		expect(inlineToolStoreMock.add).toHaveBeenCalledTimes(1);
		const added = inlineToolStoreMock.add.mock.calls[0]![0] as Record<string, unknown>;
		expect(added.id).toBeTypeOf("string");
		expect(added.id).not.toBe(parkedCall.id);
		expect(added).toMatchObject({
			extensionName: "ext-z",
			toolName: "tool-z",
			input: { updated: true },
			conversationId: "conv-parked",
			messageId: "msg-parked",
		});

		// Same invocationId is forwarded to the API so the SSE stream binds back.
		expect(userFetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = userFetchMock.mock.calls[0]!;
		expect(url).toBe("/api/tool-invoke");
		expect(init?.method).toBe("POST");
		const body = JSON.parse(init?.body as string);
		expect(body).toEqual({
			extensionName: "ext-z",
			toolName: "tool-z",
			input: { updated: true },
			conversationId: "conv-parked",
			invocationId: added.id,
		});

		// Slot cleared after a successful submit.
		expect(state.editRetryCall).toBeNull();
		expect(state.editRetryTool).toBeNull();
	});

	test("clears the slot even though the POST is fire-and-forget", async () => {
		// The POST is intentionally not awaited in the production path. The
		// slot must still clear synchronously so the form unmounts immediately.
		userFetchMock.mockImplementationOnce(async () => {
			throw new Error("api down");
		});
		const { host, state } = makeHost({
			editRetryCall: makeCall(),
			editRetryTool: makeTool(),
		});
		const handlers = makeInlineToolHandlers(host);
		// Silence the expected console.error from the production catch handler.
		const errorSpy = mock(() => {});
		const originalError = console.error;
		console.error = errorSpy;
		try {
			handlers.handleEditRetryConfirm({ x: 1 });
			expect(state.editRetryCall).toBeNull();
			expect(state.editRetryTool).toBeNull();
			// Let the rejected promise settle so it doesn't leak across tests.
			await new Promise(r => setTimeout(r, 0));
			expect(errorSpy).toHaveBeenCalled();
		} finally {
			console.error = originalError;
		}
	});
});

describe("handleInlineCancel", () => {
	test("flips the call to error: 'Cancelled by user' with elapsed duration", () => {
		const { host } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		const startedAt = Date.now() - 250;
		handlers.handleInlineCancel(makeCall({ id: "call-x", startedAt }));

		expect(inlineToolStoreMock.updateFromEvent).toHaveBeenCalledTimes(1);
		const [id, event, data] = inlineToolStoreMock.updateFromEvent.mock.calls[0]!;
		expect(id).toBe("call-x");
		expect(event).toBe("tool:error");
		const payload = data as { error: string; duration: number };
		expect(payload.error).toBe("Cancelled by user");
		// Elapsed should be >= 250ms (we're not racing the clock — just ensure
		// it's a sensible non-negative number).
		expect(payload.duration).toBeGreaterThanOrEqual(250);
	});

	test("uses duration 0 when the call never recorded startedAt", () => {
		const { host } = makeHost();
		const handlers = makeInlineToolHandlers(host);
		handlers.handleInlineCancel(makeCall({ id: "call-y", startedAt: undefined }));

		const [, , data] = inlineToolStoreMock.updateFromEvent.mock.calls[0]!;
		expect((data as { duration: number }).duration).toBe(0);
	});
});
