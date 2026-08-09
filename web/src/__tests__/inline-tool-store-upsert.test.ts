/**
 * Tests for `InlineToolStore.upsertStreaming` + `hydrateToolCalls`.
 *
 * `upsertStreaming` is the method `stores.svelte.ts` calls on every non-inline
 * `tool:start` / `tool:complete` / `tool:error` event so the Diff Summary
 * panel updates live without an HTTP refetch. The contract:
 *
 *   - Insert a new entry when the id is unseen.
 *   - Merge-update when the id already exists (status/duration/output).
 *   - Omitted `input` does NOT clobber a previously-stored input.
 *   - `hydrateToolCalls(convId, …)` replacement semantics are unchanged.
 *
 * Runs under VITEST, not bun, despite the plain `.test.ts` name (registered
 * explicitly in web/vitest.config.ts and subtracted from `web_bunleg_files()`
 * in scripts/lib/test-file-sets.sh — the same arrangement relative-time.test.ts
 * and send-message.test.ts use; the basename is kept so the Gate-integrity
 * test-rename check stays satisfied). It used to drive a rune-free
 * `TestInlineToolStore` stand-in "kept in sync" by hand, which asserted nothing
 * about the shipped store and left `inline-tool-store.svelte.ts` with no lcov
 * data at all (issue #142).
 */
import { test, expect, describe, beforeEach } from "vitest";
import { inlineToolStore } from "$lib/inline-tool-store.svelte";

describe("InlineToolStore.upsertStreaming", () => {
	beforeEach(() => {
		// Module-level singleton: reset rather than re-construct.
		inlineToolStore.calls = [];
	});

	test("inserting a new id appends a fully-initialized entry", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
			startedAt: 1000,
			cardType: "diff",
		});
		const entries = inlineToolStore.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		const e = entries[0]!;
		expect(e.id).toBe("tc-1");
		expect(e.status).toBe("running");
		expect(e.toolName).toBe("edit_file");
		expect(e.input.file_path).toBe("src/a.ts");
		expect(e.retryCount).toBe(0);
		expect(e.cardType).toBe("diff");
	});

	test("insert with no input at all defaults to an empty input object", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			status: "running",
		});
		expect(inlineToolStore.getByConversation("conv-1")[0]!.input).toEqual({});
	});

	test("upserting an existing id merges status transition without losing input", () => {
		// First event: tool:start with input
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
			startedAt: 1000,
		});
		// Second event: tool:complete — no input field
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			status: "complete",
			output: "Edit applied",
			duration: 42,
		});
		const entries = inlineToolStore.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.status).toBe("complete");
		expect(entries[0]!.output).toBe("Edit applied");
		expect(entries[0]!.duration).toBe(42);
		// Input from tool:start must be preserved (critical for the diff panel's aggregator).
		expect(entries[0]!.input.file_path).toBe("src/a.ts");
		expect(entries[0]!.input.new_string).toBe("y");
	});

	test("upsert explicit input overrides the previous input", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "running",
		});
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/b.ts" }, // corrected path
			status: "running",
		});
		expect(inlineToolStore.getByConversation("conv-1")[0]!.input.file_path).toBe("src/b.ts");
	});

	test("upsert on tool:error merges status=error + error message without losing input", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts", old_string: "x", new_string: "y" },
			status: "running",
		});
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			status: "error",
			error: "File not found",
			duration: 10,
		});
		const e = inlineToolStore.getByConversation("conv-1")[0]!;
		expect(e.status).toBe("error");
		expect(e.error).toBe("File not found");
		expect(e.input.file_path).toBe("src/a.ts");
	});

	test("upserting into conversation A does not touch conversation B", () => {
		inlineToolStore.upsertStreaming({
			id: "a-1", conversationId: "conv-A", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "a.ts" }, status: "running",
		});
		inlineToolStore.upsertStreaming({
			id: "b-1", conversationId: "conv-B", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "b.ts" }, status: "running",
		});
		expect(inlineToolStore.getByConversation("conv-A").map((c) => c.id)).toEqual(["a-1"]);
		expect(inlineToolStore.getByConversation("conv-B").map((c) => c.id)).toEqual(["b-1"]);
	});

	test("hydrateToolCalls replacement semantics still win: streamed entries for that conv are wiped", () => {
		// Streamed entry first
		inlineToolStore.upsertStreaming({
			id: "tc-stream",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "complete",
		});
		// Then DB hydration with a different id (e.g. before we aligned ids server-side,
		// or for extension tools whose id alignment isn't in scope yet)
		inlineToolStore.hydrateToolCalls("conv-1", [{
			id: "tc-db",
			extensionId: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			outputSummary: "ok",
			success: true,
			durationMs: 1,
			status: "success",
		}]);
		const entries = inlineToolStore.getByConversation("conv-1");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.id).toBe("tc-db");
	});

	test("hydrateToolCalls leaves OTHER conversations' entries alone", () => {
		inlineToolStore.upsertStreaming({
			id: "other-1", conversationId: "conv-2", extensionName: "builtin",
			toolName: "edit_file", input: {}, status: "complete",
		});
		inlineToolStore.hydrateToolCalls("conv-1", []);
		expect(inlineToolStore.getByConversation("conv-2").map((c) => c.id)).toEqual(["other-1"]);
	});

	test("hydrateToolCalls maps every persisted status and card layout", () => {
		inlineToolStore.hydrateToolCalls("conv-1", [
			{
				id: "ok", extensionId: "builtin", toolName: "read_file", input: null,
				outputSummary: "summary", fullOutput: "full", success: true, durationMs: 3,
				status: "success", messageId: "m-1", cardType: "diff", cardLayout: "dock",
			},
			{
				id: "bad", extensionId: "builtin", toolName: "read_file", input: { a: 1 },
				outputSummary: null, success: false, durationMs: 4,
				status: "error", cardType: null, cardLayout: "inline",
			},
			{
				id: "cut", extensionId: "builtin", toolName: "read_file", input: null,
				outputSummary: null, success: false, durationMs: 5,
				status: "interrupted", cardLayout: null,
			},
		]);
		const byId = new Map(inlineToolStore.getByConversation("conv-1").map((c) => [c.id, c]));
		expect(byId.get("ok")!.status).toBe("complete");
		// fullOutput wins over outputSummary.
		expect(byId.get("ok")!.output).toBe("full");
		expect(byId.get("ok")!.error).toBeUndefined();
		expect(byId.get("ok")!.messageId).toBe("m-1");
		expect(byId.get("ok")!.cardLayout).toBe("dock");
		expect(byId.get("bad")!.status).toBe("error");
		expect(byId.get("bad")!.error).toBe("Error");
		expect(byId.get("bad")!.input).toEqual({ a: 1 });
		expect(byId.get("bad")!.cardType).toBeUndefined();
		expect(byId.get("bad")!.cardLayout).toBe("inline");
		expect(byId.get("cut")!.status).toBe("error");
		expect(byId.get("cut")!.error).toBe("interrupted");
		expect(byId.get("cut")!.output).toBeUndefined();
		expect(byId.get("cut")!.cardLayout).toBeUndefined();
	});

	test("id-aligned reload: streamed id matches DB id → hydrate produces one entry, not two", () => {
		// This is the happy path after the server change that makes DB id === event.toolCallId.
		const sharedId = "00000000-0000-0000-0000-000000000001";
		inlineToolStore.upsertStreaming({
			id: sharedId,
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			status: "complete",
		});
		inlineToolStore.hydrateToolCalls("conv-1", [{
			id: sharedId,
			extensionId: "builtin",
			toolName: "edit_file",
			input: { file_path: "src/a.ts" },
			outputSummary: "ok",
			success: true,
			durationMs: 1,
			status: "success",
		}]);
		expect(inlineToolStore.getByConversation("conv-1")).toHaveLength(1);
		expect(inlineToolStore.getByConversation("conv-1")[0]!.id).toBe(sharedId);
	});

	test("upsertStreaming defaults source to 'agent-run' on insert (prevents duplicate render in unanchored cards fallback)", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1",
			conversationId: "conv-1",
			extensionName: "builtin",
			toolName: "edit_file",
			input: { file_path: "x.ts" },
			status: "running",
		});
		expect(inlineToolStore.getByConversation("conv-1")[0]!.source).toBe("agent-run");
	});

	test("scroll/render perf guard: filter c.source !== 'agent-run' excludes agent-run entries from unanchored fallback", () => {
		// Simulates the +page.svelte filter that prevents agent-run tool calls
		// from rendering as duplicate cards (which previously spawned setInterval
		// per card during busy runs and made scrolling janky).
		inlineToolStore.upsertStreaming({
			id: "a", conversationId: "c1", extensionName: "builtin", toolName: "edit_file",
			input: {}, status: "running",
		});
		inlineToolStore.upsertStreaming({
			id: "b", conversationId: "c1", extensionName: "builtin", toolName: "edit_file",
			input: {}, status: "running", source: "inline",
		});
		const unanchoredInline = inlineToolStore.calls.filter(
			(c) => !c.messageId && c.source !== "agent-run",
		);
		expect(unanchoredInline).toHaveLength(1);
		expect(unanchoredInline[0]!.id).toBe("b");
	});

	test("upsertStreaming preserves source across status transitions", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			input: { file_path: "x.ts" }, status: "running",
		});
		inlineToolStore.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			status: "complete",
		});
		expect(inlineToolStore.getByConversation("conv-1")[0]!.source).toBe("agent-run");
	});

	test("upsert with omitted cardType doesn't clobber an existing cardType", () => {
		inlineToolStore.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			input: {}, status: "running", cardType: "diff",
		});
		inlineToolStore.upsertStreaming({
			id: "tc-1", conversationId: "conv-1", extensionName: "builtin", toolName: "edit_file",
			status: "complete",
		});
		// cardType preserved because the second upsert didn't specify it.
		expect(inlineToolStore.getByConversation("conv-1")[0]!.cardType).toBe("diff");
	});
});
