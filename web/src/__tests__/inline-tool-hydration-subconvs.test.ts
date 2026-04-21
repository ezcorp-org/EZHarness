import { test, expect, describe, beforeEach } from "bun:test";

/**
 * Focused tests on hydrating sub-conversation tool calls into the inline
 * tool store. The chat page does this for every sub-conversation belonging
 * to a parent so the Diff Summary panel sees their edits.
 *
 * Uses a stand-in TestInlineToolStore that mirrors the real store's
 * per-conversation replacement semantics (see inline-tool-store.svelte.ts).
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
	fullOutput?: string | null;
	success: boolean;
	durationMs: number;
	status: "success" | "error" | "interrupted";
	messageId?: string;
}

/** Mirror of InlineToolStore.hydrateToolCalls / getByConversation */
class TestInlineToolStore {
	calls: InlineToolCall[] = [];

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
				tc.status === "interrupted" ? ("error" as const)
				: tc.status === "error" ? ("error" as const)
				: ("complete" as const),
			output: tc.outputSummary ?? undefined,
			error: tc.status === "interrupted" ? "interrupted" : tc.status === "error" ? "Error" : undefined,
			retryCount: 0,
			duration: tc.durationMs,
			conversationId,
			messageId: tc.messageId,
		}));
		this.calls = [...otherCalls, ...hydrated];
	}
}

function makeCall(overrides: Partial<HydrateInput> & { id: string }): HydrateInput {
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

describe("hydrating sub-conversation tool calls", () => {
	let store: TestInlineToolStore;

	beforeEach(() => {
		store = new TestInlineToolStore();
	});

	test("parent + two sub buckets land in disjoint, correctly-tagged slots", () => {
		store.hydrateToolCalls("parent-1", [makeCall({ id: "p-1" }), makeCall({ id: "p-2" })]);
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-1" })]);
		store.hydrateToolCalls("sub-B", [makeCall({ id: "b-1" }), makeCall({ id: "b-2" }), makeCall({ id: "b-3" })]);

		expect(store.getByConversation("parent-1").map((c) => c.id).sort()).toEqual(["p-1", "p-2"]);
		expect(store.getByConversation("sub-A").map((c) => c.id)).toEqual(["a-1"]);
		expect(store.getByConversation("sub-B").map((c) => c.id).sort()).toEqual(["b-1", "b-2", "b-3"]);

		// Every call is tagged with the conversation id it was hydrated under.
		for (const c of store.getByConversation("sub-A")) expect(c.conversationId).toBe("sub-A");
		for (const c of store.getByConversation("sub-B")) expect(c.conversationId).toBe("sub-B");
	});

	test("re-hydrating a sub replaces only that sub's entries (other conversations untouched)", () => {
		store.hydrateToolCalls("parent-1", [makeCall({ id: "p-1" })]);
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-1" }), makeCall({ id: "a-2" })]);

		// Second hydration for sub-A: swap from two calls to one
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-new" })]);

		expect(store.getByConversation("sub-A").map((c) => c.id)).toEqual(["a-new"]);
		expect(store.getByConversation("parent-1").map((c) => c.id)).toEqual(["p-1"]);
	});

	test("union across [parent, ...subs] equals the sum of individual per-conversation results", () => {
		store.hydrateToolCalls("parent-1", [makeCall({ id: "p-1" }), makeCall({ id: "p-2" })]);
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-1" })]);
		store.hydrateToolCalls("sub-B", [makeCall({ id: "b-1" })]);

		const ids = ["parent-1", "sub-A", "sub-B"];
		const union = ids.flatMap((id) => store.getByConversation(id));
		expect(union).toHaveLength(4);
		expect(union.map((c) => c.id).sort()).toEqual(["a-1", "b-1", "p-1", "p-2"]);
	});

	test("interrupted status from a sub propagates into the hydrated entry", () => {
		store.hydrateToolCalls("sub-A", [
			makeCall({ id: "a-1", status: "interrupted", success: false }),
		]);
		const call = store.getByConversation("sub-A")[0]!;
		expect(call.status).toBe("error");
		expect(call.error).toBe("interrupted");
	});

	test("hydrating an empty array for a sub clears any prior entries for that sub", () => {
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-1" })]);
		store.hydrateToolCalls("sub-A", []);
		expect(store.getByConversation("sub-A")).toEqual([]);
	});

	test("hydrating subs does not interfere with historic parent calls and vice versa", () => {
		store.hydrateToolCalls("parent-1", [makeCall({ id: "p-1" })]);
		store.hydrateToolCalls("sub-A", [makeCall({ id: "a-1" })]);

		// Now re-hydrate parent with a different set — sub-A must be untouched.
		store.hydrateToolCalls("parent-1", [makeCall({ id: "p-new" }), makeCall({ id: "p-extra" })]);
		expect(store.getByConversation("parent-1").map((c) => c.id).sort()).toEqual(["p-extra", "p-new"]);
		expect(store.getByConversation("sub-A").map((c) => c.id)).toEqual(["a-1"]);
	});
});
