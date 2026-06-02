/**
 * DOM tests for DiffSummaryPanel.svelte's split/unified preference wiring.
 *
 * The panel restores the globally-persisted view mode on mount and persists
 * the user's toggle, so a page refresh keeps the last-chosen mode instead of
 * snapping back to split. The pure load/persist logic is unit-tested in
 * diff-view-mode.test.ts; this proves the integration inside the real
 * component — that the restored mode actually drives the diff2html render and
 * that clicking the header toggle writes through to storage.
 *
 * diff2html emits the two-column `.d2h-file-side-diff` only in side-by-side
 * mode; line-by-line renders a single column without it — that's the DOM
 * signal used to tell the modes apart.
 */

import { render, cleanup, fireEvent, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import "@testing-library/jest-dom/vitest";
import DiffSummaryPanel from "./DiffSummaryPanel.svelte";
import type { Message } from "$lib/api";
import { DIFF_VIEW_MODE_KEY } from "$lib/diff-view-mode";

const DIFF_MD = [
	"```diff",
	"--- a/src/auth.ts",
	"+++ b/src/auth.ts",
	"@@ -1,2 +1,2 @@",
	"-const ok = false;",
	"+const ok = true;",
	"```",
].join("\n");

function assistantMsg(content: string): Message {
	return {
		id: "m1",
		conversationId: "c1",
		role: "assistant",
		content,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId: null,
		excluded: false,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function renderPanel() {
	return render(DiffSummaryPanel, {
		messages: [assistantMsg(DIFF_MD)],
		toolCalls: [],
		open: true,
		onclose: () => {},
		streaming: false,
	});
}

afterEach(() => cleanup());

describe("DiffSummaryPanel — split/unified preference persistence", () => {
	beforeEach(() => localStorage.clear());
	afterEach(() => localStorage.clear());

	test("defaults to split when nothing is stored", async () => {
		const { container } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});
	});

	test("restores the persisted unified mode on mount (the refresh fix)", async () => {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, "line-by-line");
		const { container } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-wrapper")).not.toBeNull();
		});
		// Unified: the two-column side diff is absent.
		expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).toBeNull();
	});

	test("clicking Unified switches the view and persists the choice", async () => {
		const { container, getByRole } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});

		await fireEvent.click(getByRole("button", { name: "Unified" }));

		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("line-by-line");
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).toBeNull();
		});
	});

	test("clicking Split after Unified persists side-by-side again", async () => {
		localStorage.setItem(DIFF_VIEW_MODE_KEY, "line-by-line");
		const { container, getByRole } = renderPanel();
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-wrapper")).not.toBeNull();
		});

		await fireEvent.click(getByRole("button", { name: "Split" }));

		expect(localStorage.getItem(DIFF_VIEW_MODE_KEY)).toBe("side-by-side");
		await waitFor(() => {
			expect(container.querySelector(".diff-panel-content .d2h-file-side-diff")).not.toBeNull();
		});
	});
});
