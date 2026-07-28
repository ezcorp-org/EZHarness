/**
 * Tests for `shouldRenderInDock` — the pure helper that decides whether a
 * tool call should render in the floating DockHost panel instead of the
 * inline chat bubble. Streaming-precedence rule: only `cardLayout === "dock"
 * && status === "complete"` returns true.
 *
 * canvas-dock-sdk.md §5 unit cases #8-9.
 */
import { test, expect, describe } from "bun:test";
import { shouldRenderInDock } from "../lib/components/tool-cards/utils.js";

describe("shouldRenderInDock", () => {
	test('returns true ONLY when cardLayout === "dock" && status === "complete"', () => {
		expect(shouldRenderInDock("dock", "complete")).toBe(true);
	});

	test('returns false for streaming (running) calls — streaming-precedence rule', () => {
		expect(shouldRenderInDock("dock", "running")).toBe(false);
	});

	test('returns false for missing/null cardLayout — backwards-compat (NULL → inline)', () => {
		expect(shouldRenderInDock(undefined, "complete")).toBe(false);
		expect(shouldRenderInDock(null, "complete")).toBe(false);
	});

	test('returns false for cardLayout === "inline" regardless of status', () => {
		expect(shouldRenderInDock("inline", "complete")).toBe(false);
		expect(shouldRenderInDock("inline", "running")).toBe(false);
		expect(shouldRenderInDock("inline", "error")).toBe(false);
	});
});

describe("validation: shouldRenderInDock additional gaps", () => {
	test("undefined cardLayout + complete → false (legacy NULL → inline)", () => {
		expect(shouldRenderInDock(undefined, "complete")).toBe(false);
	});

	test('cardLayout="dock" + status="error" → false (only complete docks)', () => {
		// Errored dock-mode tool calls keep their pill in chat history;
		// they don't take over the dock.
		expect(shouldRenderInDock("dock", "error")).toBe(false);
	});
});
