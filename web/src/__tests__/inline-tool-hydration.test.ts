import { describe, test, expect, beforeEach } from "bun:test";

/**
 * Focused tests on the hydration flow for InlineToolStore.
 * Verifies store population, messageId association, deduplication, and interrupted mapping.
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

class TestInlineToolStore {
	calls: InlineToolCall[] = [];

	add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
		this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
	}

	getByConversation(conversationId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.conversationId === conversationId);
	}

	getByMessage(messageId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.messageId === messageId);
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

describe("Hydration flow", () => {
	let store: TestInlineToolStore;

	beforeEach(() => {
		store = new TestInlineToolStore();
	});

	test("store starts empty, hydrateToolCalls populates it", () => {
		expect(store.calls).toHaveLength(0);

		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1" }),
			makeHydrateCall({ id: "tc-2", toolName: "searchDocs" }),
		]);

		expect(store.calls).toHaveLength(2);
		expect(store.calls[0]!.id).toBe("tc-1");
		expect(store.calls[1]!.id).toBe("tc-2");
		expect(store.calls[1]!.toolName).toBe("searchDocs");
	});

	test("hydrated calls have correct messageId association", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1", messageId: "msg-10" }),
			makeHydrateCall({ id: "tc-2", messageId: "msg-10" }),
			makeHydrateCall({ id: "tc-3", messageId: "msg-20" }),
		]);

		const msg10Calls = store.getByMessage("msg-10");
		expect(msg10Calls).toHaveLength(2);
		expect(msg10Calls.map((c) => c.id)).toEqual(["tc-1", "tc-2"]);

		const msg20Calls = store.getByMessage("msg-20");
		expect(msg20Calls).toHaveLength(1);
		expect(msg20Calls[0]!.id).toBe("tc-3");
	});

	test("multiple hydration calls don't duplicate entries", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1" }),
			makeHydrateCall({ id: "tc-2" }),
		]);
		expect(store.getByConversation("conv-1")).toHaveLength(2);

		// Second hydration replaces, not appends
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-3" }),
		]);
		expect(store.getByConversation("conv-1")).toHaveLength(1);
		expect(store.getByConversation("conv-1")[0]!.id).toBe("tc-3");
	});

	test("hydrated interrupted calls show as error status with 'interrupted' error string", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1", status: "interrupted" }),
		]);

		const call = store.calls[0]!;
		expect(call.status).toBe("error");
		expect(call.error).toBe("interrupted");
		// Verify isInterrupted derivation would match
		expect(call.status === "error" && call.error === "interrupted").toBe(true);
	});

	test("hydration with mixed statuses maps each correctly", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1", status: "success" }),
			makeHydrateCall({ id: "tc-2", status: "error" }),
			makeHydrateCall({ id: "tc-3", status: "interrupted" }),
		]);

		expect(store.calls[0]!.status).toBe("complete");
		expect(store.calls[0]!.error).toBeUndefined();

		expect(store.calls[1]!.status).toBe("error");
		expect(store.calls[1]!.error).toBe("Error");

		expect(store.calls[2]!.status).toBe("error");
		expect(store.calls[2]!.error).toBe("interrupted");
	});

	test("hydration preserves calls from unrelated conversations", () => {
		// Pre-populate conv-2
		store.add({
			id: "existing-1",
			extensionName: "ext-b",
			toolName: "otherTool",
			input: {},
			conversationId: "conv-2",
		});

		// Hydrate conv-1 — should not touch conv-2
		store.hydrateToolCalls("conv-1", [makeHydrateCall({ id: "tc-1" })]);

		expect(store.getByConversation("conv-2")).toHaveLength(1);
		expect(store.getByConversation("conv-2")[0]!.id).toBe("existing-1");
		expect(store.getByConversation("conv-2")[0]!.status).toBe("pending"); // original status preserved
	});

	test("all hydrated calls have retryCount of 0", () => {
		store.hydrateToolCalls("conv-1", [
			makeHydrateCall({ id: "tc-1", status: "error" }),
			makeHydrateCall({ id: "tc-2", status: "interrupted" }),
			makeHydrateCall({ id: "tc-3", status: "success" }),
		]);

		for (const call of store.calls) {
			expect(call.retryCount).toBe(0);
		}
	});
});
