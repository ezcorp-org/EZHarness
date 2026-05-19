/**
 * DOM tests for DiffCard.svelte.
 *
 * Regression contract: the inline diff card must render after a page
 * reload, not just during live streaming.
 *
 * During streaming, `toolCall.output` is the full `{ content, details }`
 * object the builtin tool returned, so the card reads
 * `details.oldContent/newContent` directly. But only `tool_call.content`
 * is persisted to the DB (subscribe-bridge.ts) — after a reload
 * `toolCall.output` hydrates as a plain string and `details` is gone.
 * The card must then fall back to the tool INPUT (old_string /
 * new_string), the same source the diff panel reconstructs from, instead
 * of showing "No diff available".
 */

import { render, cleanup } from "@testing-library/svelte";
import { afterEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import DiffCard from "./DiffCard.svelte";
import type { ToolCallState } from "$lib/stores.svelte";

function makeToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
	return {
		id: "tc-diff",
		toolName: "editFile",
		status: "complete",
		input: {},
		startedAt: 0,
		duration: 1,
		cardType: "diff",
		...overrides,
	};
}

afterEach(() => cleanup());

describe("DiffCard — post-reload hydration", () => {
	test("new file: renders content from input when output is a hydrated string", () => {
		// Mirrors the editFile create path after refresh: output is the
		// truncated text summary, details stripped; input still carries
		// path + new_string.
		const { container, queryByText } = render(DiffCard, {
			toolCall: makeToolCall({
				input: { path: "src/new.ts", new_string: "alpha\nbeta" },
				output: "Created/overwrote src/new.ts (2 lines)\n1: alpha\n2: beta",
			}),
		});

		expect(queryByText("No diff available")).toBeNull();
		expect(container.textContent).toContain("src/new.ts");
		expect(container.textContent).toContain("New file");
		expect(container.textContent).toContain("alpha");
		expect(container.textContent).toContain("beta");
		// A real diff2html table must render — the original bug produced a
		// malformed diff that diff2html dropped, so this pins that the
		// generated new-file diff actually parses (not the green-pre
		// fallback path).
		expect(container.querySelector(".d2h-wrapper, table")).not.toBeNull();
		expect(container.querySelector("pre.whitespace-pre-wrap")).toBeNull();
		// CopyButton is gated on the resolved newContent (template change).
		expect(container.querySelector('[aria-label="Copy output"]')).not.toBeNull();
	});

	test("search/replace: renders diff from input old_string/new_string after reload", () => {
		const { container, queryByText } = render(DiffCard, {
			toolCall: makeToolCall({
				input: { file_path: "src/app.ts", old_string: "foo", new_string: "bar" },
				output: "Replaced in src/app.ts",
			}),
		});

		expect(queryByText("No diff available")).toBeNull();
		expect(container.textContent).not.toContain("New file");
		expect(container.textContent).toContain("foo");
		expect(container.textContent).toContain("bar");
	});

	test("still works during live streaming (output carries details)", () => {
		const { container, queryByText } = render(DiffCard, {
			toolCall: makeToolCall({
				input: { path: "src/new.ts", new_string: "alpha\nbeta" },
				output: {
					content: [{ type: "text", text: "Created/overwrote src/new.ts" }],
					// editFile sends null oldContent for a created file
					details: { oldContent: null, newContent: "alpha\nbeta" },
				},
			}),
		});

		expect(queryByText("No diff available")).toBeNull();
		expect(container.textContent).toContain("New file");
		expect(container.textContent).toContain("alpha");
	});

	test("output.details wins over input when both are present", () => {
		// Live path is richer (full file before/after); input only has the
		// snippet. Per-field precedence must prefer details.
		const { container, queryByText } = render(DiffCard, {
			toolCall: makeToolCall({
				input: { file_path: "src/app.ts", old_string: "INPUT_OLD", new_string: "INPUT_NEW" },
				output: {
					content: [{ type: "text", text: "Replaced in src/app.ts" }],
					details: { oldContent: "DETAILS_OLD", newContent: "DETAILS_NEW" },
				},
			}),
		});

		expect(queryByText("No diff available")).toBeNull();
		expect(container.textContent).toContain("DETAILS_OLD");
		expect(container.textContent).toContain("DETAILS_NEW");
		expect(container.textContent).not.toContain("INPUT_OLD");
		expect(container.textContent).not.toContain("INPUT_NEW");
	});

	test("genuinely empty edit still shows the no-diff fallback", () => {
		const { container, queryByText } = render(DiffCard, {
			toolCall: makeToolCall({
				input: { command: "ls" },
				output: "some unrelated output",
			}),
		});

		expect(queryByText("No diff available")).not.toBeNull();
		// No resolvable newContent → no copy button, no "New file" badge.
		expect(container.querySelector('[aria-label="Copy output"]')).toBeNull();
		expect(container.textContent).not.toContain("New file");
	});
});
