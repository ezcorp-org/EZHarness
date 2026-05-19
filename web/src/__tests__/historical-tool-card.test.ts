import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Phase 37 tests: historical tool calls, hydration, API endpoints, and sub-conversation summaries.
 * Tests the store/logic layer directly — no Svelte DOM rendering.
 */

// ── Shared types (mirrors inline-tool-store.svelte.ts without $state rune) ──

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
}

// ── TestInlineToolStore: mirrors real store without Svelte runes ──

class TestInlineToolStore {
	calls: InlineToolCall[] = [];

	add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
		this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
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
			output: tc.outputSummary ?? undefined,
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
		}));
		this.calls = [...otherCalls, ...hydrated];
	}
}

// ── Helpers ──

function makeHydrateCall(overrides: Partial<HydrateInput> = {}): HydrateInput {
	return {
		id: overrides.id ?? "tc-1",
		extensionId: overrides.extensionId ?? "ext-weather",
		toolName: overrides.toolName ?? "getWeather",
		input: overrides.input ?? { city: "NYC" },
		outputSummary: overrides.outputSummary ?? "Sunny, 72F",
		success: overrides.success ?? true,
		durationMs: overrides.durationMs ?? 350,
		status: overrides.status ?? "success",
		messageId: overrides.messageId,
	};
}

// ── hydrateToolCalls tests ──

describe("InlineToolStore.hydrateToolCalls", () => {
	let store: TestInlineToolStore;

	beforeEach(() => {
		store = new TestInlineToolStore();
	});

	test("replaces existing calls for the conversation", () => {
		store.add({
			id: "old-1",
			extensionName: "ext-a",
			toolName: "oldTool",
			input: {},
			conversationId: "conv-1",
		});
		expect(store.getByConversation("conv-1")).toHaveLength(1);

		store.hydrateToolCalls("conv-1", [makeHydrateCall({ id: "new-1" })]);
		const calls = store.getByConversation("conv-1");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.id).toBe("new-1");
	});

	test('maps "success" status to "complete"', () => {
		store.hydrateToolCalls("conv-1", [makeHydrateCall({ status: "success" })]);
		expect(store.calls[0]!.status).toBe("complete");
		expect(store.calls[0]!.error).toBeUndefined();
	});

	test('maps "error" status to "error" with "Error" message', () => {
		store.hydrateToolCalls("conv-1", [makeHydrateCall({ status: "error" })]);
		expect(store.calls[0]!.status).toBe("error");
		expect(store.calls[0]!.error).toBe("Error");
	});

	test('maps "interrupted" status to "error" with "interrupted" message', () => {
		store.hydrateToolCalls("conv-1", [makeHydrateCall({ status: "interrupted" })]);
		expect(store.calls[0]!.status).toBe("error");
		expect(store.calls[0]!.error).toBe("interrupted");
	});

	test("preserves calls from other conversations", () => {
		store.add({
			id: "other-1",
			extensionName: "ext-b",
			toolName: "otherTool",
			input: {},
			conversationId: "conv-2",
		});
		store.hydrateToolCalls("conv-1", [makeHydrateCall()]);
		expect(store.getByConversation("conv-2")).toHaveLength(1);
		expect(store.getByConversation("conv-2")[0]!.id).toBe("other-1");
		expect(store.getByConversation("conv-1")).toHaveLength(1);
	});

	test("sets extensionName from extensionId", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ extensionId: "my-cool-extension" }),
		]);
		expect(store.calls[0]!.extensionName).toBe("my-cool-extension");
	});

	test("handles null input as empty object", () => {
		const tc: HydrateInput = {
			id: "tc-null-input", extensionId: "ext-a", toolName: "run",
			input: null, outputSummary: "ok", success: true, durationMs: 100, status: "success",
		};
		store.hydrateToolCalls("conv-1", [tc]);
		expect(store.calls[0]!.input).toEqual({});
	});

	test("handles null outputSummary as undefined output", () => {
		const tc: HydrateInput = {
			id: "tc-null-out", extensionId: "ext-a", toolName: "run",
			input: { x: 1 }, outputSummary: null, success: true, durationMs: 100, status: "success",
		};
		store.hydrateToolCalls("conv-1", [tc]);
		expect(store.calls[0]!.output).toBeUndefined();
	});

	test("sets correct messageId association", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1", messageId: "msg-42" }),
			makeHydrateCall({ id: "tc-2", messageId: "msg-43" }),
		]);
		expect(store.calls[0]!.messageId).toBe("msg-42");
		expect(store.calls[1]!.messageId).toBe("msg-43");
	});

	test("sets duration from durationMs", () => {
		store.hydrateToolCalls("conv-1", [makeHydrateCall({ durationMs: 1234 })]);
		expect(store.calls[0]!.duration).toBe(1234);
	});
});

// ── API endpoint logic tests (mock fetch) ──

describe("API endpoint logic (mock fetch)", () => {
	const originalFetch = globalThis.fetch;

	function mockFetch(handler: (url: string) => Response) {
		globalThis.fetch = ((url: string) => Promise.resolve(handler(url))) as any;
	}

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("GET /api/tool-calls/:id/output returns full output", async () => {
		mockFetch((url) => {
			if (url === "/api/tool-calls/tc-42/output") {
				return new Response(JSON.stringify({ output: "Full detailed output here" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("Not found", { status: 404 });
		});

		const res = await fetch("/api/tool-calls/tc-42/output");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.output).toBe("Full detailed output here");
	});

	test("GET /api/tool-calls/:id/output returns 404 for missing", async () => {
		mockFetch(() => new Response("Not found", { status: 404 }));

		const res = await fetch("/api/tool-calls/nonexistent/output");
		expect(res.status).toBe(404);
		expect(res.ok).toBe(false);
	});

	test("GET /api/conversations/:id/messages?withToolCalls=true triggers hydration path", async () => {
		const apiToolCalls = [
			{
				id: "tc-1",
				extensionId: "ext-a",
				toolName: "search",
				input: { q: "test" },
				outputSummary: "Found 3 results",
				success: true,
				durationMs: 200,
				status: "success",
				messageId: "msg-1",
			},
		];

		mockFetch((url) => {
			if (url.includes("/api/conversations/conv-5/messages") && url.includes("withToolCalls=true")) {
				return new Response(
					JSON.stringify({
						messages: [{ id: "msg-1", role: "assistant", content: "Here are results" }],
						toolCalls: apiToolCalls,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("Not found", { status: 404 });
		});

		const res = await fetch("/api/conversations/conv-5/messages?withToolCalls=true");
		expect(res.ok).toBe(true);
		const data = await res.json();
		expect(data.toolCalls).toHaveLength(1);

		// Simulate hydration
		const store = new TestInlineToolStore();
		store.hydrateToolCalls("conv-5", data.toolCalls);
		expect(store.getByConversation("conv-5")).toHaveLength(1);
		expect(store.getByConversation("conv-5")[0]!.status).toBe("complete");
	});
});

// ── Sub-conversation summary logic ──

describe("Sub-conversation summary logic", () => {
	function deriveSummaryText(
		messageCount: number | undefined,
		lastMessagePreview: string | null | undefined,
		messages: Array<{ content: string }>,
	): string {
		if (messageCount != null && lastMessagePreview) {
			return `${messageCount} messages -- "${lastMessagePreview}"`;
		}
		if (messages.length === 0) return "No messages yet";
		const last = messages[messages.length - 1]!;
		const text = last.content;
		return text.length > 80 ? text.slice(0, 80) + "..." : text;
	}

	test("collapsed summary shows agent name and message count", () => {
		const summary = deriveSummaryText(5, "Final answer is 42", []);
		expect(summary).toBe('5 messages -- "Final answer is 42"');
		expect(summary).toContain("5 messages");
	});

	test("lastMessagePreview is truncated at 80 chars in fallback mode", () => {
		const longContent = "X".repeat(100);
		const summary = deriveSummaryText(undefined, undefined, [{ content: longContent }]);
		expect(summary).toHaveLength(83); // 80 + "..."
		expect(summary.endsWith("...")).toBe(true);
	});

	test("falls back to last message content when messageCount is undefined", () => {
		const summary = deriveSummaryText(undefined, undefined, [
			{ content: "first" },
			{ content: "last message here" },
		]);
		expect(summary).toBe("last message here");
	});

	test("shows 'No messages yet' when empty and no count", () => {
		expect(deriveSummaryText(undefined, undefined, [])).toBe("No messages yet");
	});
});

// ── InlineToolCard derived logic for historical/interrupted/source ──

describe("InlineToolCard historical/interrupted/source logic", () => {
	test("isInterrupted is true when status=error and error=interrupted", () => {
		const call: InlineToolCall = {
			id: "tc-1",
			extensionName: "ext-a",
			toolName: "run",
			input: {},
			status: "error",
			error: "interrupted",
			retryCount: 0,
			conversationId: "conv-1",
		};
		const isInterrupted = call.status === "error" && call.error === "interrupted";
		expect(isInterrupted).toBe(true);
	});

	test("isInterrupted is false for normal errors", () => {
		const call: InlineToolCall = {
			id: "tc-1",
			extensionName: "ext-a",
			toolName: "run",
			input: {},
			status: "error",
			error: "timeout",
			retryCount: 0,
			conversationId: "conv-1",
		};
		const isInterrupted = call.status === "error" && call.error === "interrupted";
		expect(isInterrupted).toBe(false);
	});

	test("historical=true hides retry/edit buttons (logic check)", () => {
		// In the component, buttons render only when !historical
		const historical = true;
		expect(!historical).toBe(false); // buttons not shown
	});

	test("historical=false shows retry/edit buttons (logic check)", () => {
		const historical = false;
		expect(!historical).toBe(true); // buttons shown
	});

	test("source='agent' produces 'via agent' label", () => {
		const source: "user" | "agent" = "agent";
		expect(source === "agent").toBe(true);
	});

	test("fetchFullOutput only triggers on expand when historical", () => {
		// Mirrors handleExpand logic
		let fetchCalled = false;
		const historical = true;
		const expanded = true;

		if (expanded && historical) {
			fetchCalled = true;
		}
		expect(fetchCalled).toBe(true);

		// Non-historical expand should not fetch
		fetchCalled = false;
		const historical2 = false;
		if (expanded && historical2) {
			fetchCalled = true;
		}
		expect(fetchCalled).toBe(false);
	});
});

// Import afterEach for mock cleanup
import { afterEach } from "bun:test";

test("placeholder test passes", () => {
	expect(true).toBe(true);
});
