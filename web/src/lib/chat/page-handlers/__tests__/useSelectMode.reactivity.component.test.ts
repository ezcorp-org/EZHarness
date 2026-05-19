/**
 * Reactivity regression test for `useSelectMode`.
 *
 * Plain `useSelectMode.test.ts` covers the pure core handlers against a
 * non-reactive `SelectModeState` shape — but those tests can't catch a
 * Svelte-5-specific reactivity break, e.g. swapping the underlying
 * container from `SvelteSet` to `$state(new Set())`. Built-in `Set` /
 * `Map` instances are NOT proxied by `$state`, so `.add` / `.delete` on
 * such a slot would fail to re-render the chat-page checkboxes — exactly
 * the bug this test is here to prevent.
 *
 * Strategy: render a thin Svelte harness that mirrors the chat page's
 * read pattern (`derived.selectedCount` label + per-row
 * `aria-checked={selectedIds.has(id)}`), drive the same handler the
 * chat row's `onclick` would, and assert the visible state actually
 * flips. If reactivity is broken, the count stays at 0 and
 * `aria-checked` never toggles — same failure mode the user reported.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import type { Message } from "$lib/api.js";

// `useSelectMode` pulls in `$app/navigation` (for the fork-success goto) and
// `$lib/utils/fetch-policy` (for bulk-save-memory POSTs). Neither is exercised
// by the toggle-paths under test here, but the imports run at module-load
// time so they need stubs.
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(),
	backgroundFetch: vi.fn(),
	invalidate: vi.fn(),
}));

import Harness from "./UseSelectModeHarness.svelte";

function makeMessage(id: string): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: "2024-01-01T00:00:00.000Z",
		excluded: false,
	} as Message;
}

describe("useSelectMode rune-wrapper reactivity", () => {
	test("clicking a row updates selectedCount and aria-checked", async () => {
		const messages = ["a", "b", "c"].map(makeMessage);
		const { getByTestId } = render(Harness, { messages });

		// Pre-condition: harness auto-enters select-mode; nothing selected yet.
		expect(getByTestId("selected-count")).toHaveTextContent("0");
		expect(getByTestId("row-a")).toHaveAttribute("aria-checked", "false");

		await fireEvent.click(getByTestId("row-a"));

		// Post-condition: count bumped AND the clicked row's aria-checked
		// flipped to "true". A non-reactive Set would keep both at the
		// pre-click values.
		expect(getByTestId("selected-count")).toHaveTextContent("1");
		expect(getByTestId("row-a")).toHaveAttribute("aria-checked", "true");
		expect(getByTestId("row-b")).toHaveAttribute("aria-checked", "false");
	});

	test("clicking a second row adds it; clicking again removes it", async () => {
		const messages = ["a", "b", "c"].map(makeMessage);
		const { getByTestId } = render(Harness, { messages });

		await fireEvent.click(getByTestId("row-a"));
		await fireEvent.click(getByTestId("row-c"));
		expect(getByTestId("selected-count")).toHaveTextContent("2");
		expect(getByTestId("row-a")).toHaveAttribute("aria-checked", "true");
		expect(getByTestId("row-c")).toHaveAttribute("aria-checked", "true");

		// Toggle off — the same click that added it must remove it.
		await fireEvent.click(getByTestId("row-a"));
		expect(getByTestId("selected-count")).toHaveTextContent("1");
		expect(getByTestId("row-a")).toHaveAttribute("aria-checked", "false");
		expect(getByTestId("row-c")).toHaveAttribute("aria-checked", "true");
	});

	test("shift+click range select reflects in aria-checked across the range", async () => {
		const messages = ["a", "b", "c", "d"].map(makeMessage);
		const { getByTestId } = render(Harness, { messages });

		await fireEvent.click(getByTestId("row-a"));
		// Shift-click a row past the anchor — fills in the inclusive range.
		await fireEvent.click(getByTestId("row-c"), { shiftKey: true });

		expect(getByTestId("selected-count")).toHaveTextContent("3");
		for (const id of ["a", "b", "c"]) {
			expect(getByTestId(`row-${id}`)).toHaveAttribute(
				"aria-checked",
				"true",
			);
		}
		expect(getByTestId("row-d")).toHaveAttribute("aria-checked", "false");
	});
});
