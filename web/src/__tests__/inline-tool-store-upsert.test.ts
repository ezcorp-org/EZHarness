/**
 * Tests for `InlineToolStore.upsertStreaming`.
 *
 * This is the method `stores.svelte.ts` calls on every non-inline
 * `tool:start` / `tool:complete` / `tool:error` event so the Diff Summary
 * panel updates live without an HTTP refetch. The contract:
 *
 *   - Insert a new entry when the id is unseen.
 *   - Merge-update when the id already exists (status/duration/output).
 *   - Omitted `input` does NOT clobber a previously-stored input.
 *   - `hydrateToolCalls(convId, …)` replacement semantics are unchanged.
 *
 * Uses a stand-in class that mirrors the real store's per-conversation
 * filter and replacement behavior so these tests can run in bun:test
 * without Svelte rune compilation.
 */
import { test, expect, describe, beforeEach } from "bun:test";

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
	source?: "inline" | "agent-run";
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
	cardType?: string | null;
}

/** Mirror of the real store. Keep in sync with inline-tool-store.svelte.ts. */
class TestInlineToolStore {
	calls: InlineToolCall[] = [];

	getByConversation(conversationId: string): InlineToolCall[] {
		return this.calls.filter((c) => c.conversationId === conversationId);
	}

	hydrateToolCalls(conversationId: string, toolCalls: HydrateInput[]): void {
		const other = this.calls.filter((c) => c.conversationId !== conversationId);
		const hydrated: InlineToolCall[] = toolCalls.map((tc) => ({
			id: tc.id,
			extensionName: tc.extensionId,
			toolName: tc.toolName,
			input: tc.input ?? {},
			status: tc.status === "success" ? "complete" : "error",
			output: tc.fullOutput ?? tc.outputSummary ?? undefined,
			error: tc.status === "interrupted" ? "interrupted" : tc.status === "error" ? "Error" : undefined,
			retryCount: 0,
			duration: tc.durationMs,
			conversationId,
			messageId: tc.messageId,
			cardType: tc.cardType ?? undefined,
		}));
		this.calls = [...other, ...hydrated];
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
		messageId?: string;
		source?: "inline" | "agent-run";
	}): void {
		const idx = this.calls.findIndex((c) => c.id === entry.id);
		if (idx < 0) {
			this.calls = [...this.calls, {
				retryCount: 0,
				input: entry.input ?? {},
				source: "agent-run" as const,
				...entry,
			} as any];
			return;
		}
		const existing = this.calls[idx]!;
		const next = [...this.calls];
		const { input: entryInput, ...entryRest } = entry;
		next[idx] = {
			...existing,
			...entryRest,
			...(entryInput !== undefined ? { input: entryInput } : {}),
		};
		this.calls = next;
	}
}

describe("InlineToolStore.upsertStreaming", () => {
	let store: TestInlineToolStore;

	beforeEach(() => {
		store = new TestInlineToolStore();
	});

	test("inserting a new id appends a fully-initialized entry", () => {
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
			startedAt: 1000,
			cardType: "diff",
		});
		const entries = store.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		const e = entries[0]!;
		expect(e.id).toBe("tc-1");
		expect(e.status).toBe("running");
		expect(e.toolName).toBe("edit_file");
		expect(e.input.file_path).toBe("src/a.ts");
		expect(e.retryCount).toBe(0);
		expect(e.cardType).toBe("diff");
	});

	test("upserting an existing id merges status transition without losing input", () => {
		// First event: tool:start with input
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
			startedAt: 1000,
		});
		// Second event: tool:complete — no input field
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			status: "complete",
			output: "Edit applied",
			duration: 42,
		});
		const entries = store.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.status).toBe("complete");
		expect(entries[0]!.output).toBe("Edit applied");
		expect(entries[0]!.duration).toBe(42);
		// Input from tool:start must be preserved (critical for the diff panel's aggregator).
		expect(entries[0]!.input.file_path).toBe("src/a.ts");
		expect(entries[0]!.input.new_string).toBe("y");
	});

	test("upsert explicit input overrides the previous input", () => {
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "running",
		});
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/b.ts" }, // corrected path
			status: "running",
		});
		expect(store.getByConversation("conv-1")[0]!.input.file_path).toBe("src/b.ts");
	});

	test("upsert on tool:error merges status=error + error message without losing input", () => {
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
		});
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			status: "error",
			error: "File not found",
			duration: 10,
		});
		const e = store.getByConversation("conv-1")[0]!;
		expect(e.status).toBe("error");
		expect(e.error).toBe("File not found");
		expect(e.input.file_path).toBe("src/a.ts");
	});

	test("upserting into conversation A does not touch conversation B", () => {
		store.upsertStreaming({
			id: "a-1", conversationId: "conv-A", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "a.ts" }, status: "running",
		});
		store.upsertStreaming({
			id: "b-1", conversationId: "conv-B", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "b.ts" }, status: "running",
		});
		expect(store.getByConversation("conv-A").map((c) => c.id)).toEqual(["a-1"]);
		expect(store.getByConversation("conv-B").map((c) => c.id)).toEqual(["b-1"]);
	});

	test("hydrateToolCalls replacement semantics still win: streamed entries for that conv are wiped", () => {
		// Streamed entry first
		store.upsertStreaming({
			id: "tc-stream",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "complete",
		});
		// Then DB hydration with a different id (e.g. before we aligned ids server-side,
		// or for extension tools whose id alignment isn't in scope yet)
		store.hydrateToolCalls("conv-1", [{
			id: "tc-db",
			extensionId: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			outputSummary: "ok",
			success: true,
			durationMs: 1,
			status: "success",
		}]);
		const entries = store.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("tc-db");
	});

	test("id-aligned reload: streamed id matches DB id → hydrate produces one entry, not two", () => {
		// This is the happy path after the server change that makes DB id === event.toolCallId.
		const sharedId = "00000000-0000-0000-0000-000000000001";
		store.upsertStreaming({
			id: sharedId,
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "complete",
		});
		store.hydrateToolCalls("conv-1", [{
			id: sharedId,
			extensionId: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			outputSummary: "ok",
			success: true,
			durationMs: 1,
			status: "success",
		}]);
		expect(store.getByConversation("conv-1")).toHaveLength(1);
		expect(store.getByConversation("conv-1")[0]!.id).toBe(sharedId);
	});

	test("upsertStreaming defaults source to 'agent-run' on insert (prevents duplicate render in unanchored cards fallback)", () => {
		store.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "x.ts" },
			status: "running",
		});
		const entry = store.getByConversation("conv-1")[0] as InlineToolCall & { source?: string };
		expect(entry.source).toBe("agent-run");
	});

	test("scroll/render perf guard: filter c.source !== 'agent-run' excludes agent-run entries from unanchored fallback", () => {
		// Simulates the +page.svelte filter that prevents agent-run tool calls
		// from rendering as duplicate cards (which previously spawned setInterval
		// per card during busy runs and made scrolling janky).
		store.calls = [
			{ id: "a", conversationId: "c1", extensionName: "builtin", toolName: "edit_file", input: {}, status: "running", retryCount: 0, source: "agent-run" as const } as any,
			{ id: "b", conversationId: "c1", extensionName: "builtin", toolName: "edit_file", input: {}, status: "running", retryCount: 0 } as any, // no source → inline (client-initiated)
		];
		const unanchoredInline = store.calls.filter((c: any) => !c.messageId && c.source !== "agent-run");
		expect(unanchoredInline).toHaveLength(1);
		expect(unanchoredInline[0]!.id).toBe("b");
	});

	test("upsertStreaming preserves source across status transitions", () => {
		store.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "x.ts" }, status: "running",
		});
		store.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			status: "complete",
		});
		const entry = store.getByConversation("conv-1")[0] as InlineToolCall & { source?: string };
		expect(entry.source).toBe("agent-run");
	});

	test("upsert with omitted cardType doesn't clobber an existing cardType", () => {
		store.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			input: {}, status: "running", cardType: "diff",
		});
		store.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			status: "complete",
		});
		// cardType preserved because the second upsert didn't specify it.
		expect(store.getByConversation("conv-1")[0]!.cardType).toBe("diff");
	});
});
