/**
 * Phase 57 — UX-04 Wave 0 RED scaffold for drag-reorderable extension chips.
 *
 * Pins the must_haves contract from PLAN frontmatter:
 *   "On the agent edit page, a user can drag an extension chip to a new
 *    position via mouse, touch, or keyboard; the new order persists to
 *    agentConfigs.extensions JSONB array and survives a page reload."
 *
 * Four cases:
 *   1. Chip row has aria-label="Reorderable extension list" (Pitfall 5
 *      — screen-reader announce on focus).
 *   2. Chip row is wired with the dndzone action (data attribute OR a
 *      `consider` CustomEvent is handled).
 *   3. onfinalize CustomEvent on the chip row emits onchange with the
 *      new id order.
 *   4. aria-label includes keyboard hint ("Space" + "arrows") so users
 *      know the keyboard path exists.
 *
 * RED reason: ExtensionSearchPicker.svelte lines 101-107 wraps chips in
 * a bare `<div data-testid="selected-extension-chips">` — no aria-label,
 * no dndzone action, no finalize handler. Wave 2 Track C (Plan 57-05
 * Task 2) attaches `use:dndzone` + the aria-label + the handler.
 *
 * Runner: vitest (component suffix triggers the .component.test.ts glob
 * in web/vitest.config.ts).
 */

import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import ExtensionSearchPicker from "../ExtensionSearchPicker.svelte";

beforeEach(() => {
	// The picker fetches `/api/extensions` on mount to populate the
	// extension list. Stub fetch so the chip-row tests don't depend on
	// network state — the only path under test is the selected-chip
	// row rendering + drag wiring.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.includes("/api/extensions")) {
				return new Response(
					JSON.stringify({
						extensions: [
							{ name: "ext-a", description: "ext A" },
							{ name: "ext-b", description: "ext B" },
							{ name: "ext-c", description: "ext C" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("[]", {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});

describe("ExtensionSearchPicker drag-reorder", () => {
	test("selected chip row has aria-label='Reorderable extension list'", async () => {
		render(ExtensionSearchPicker, {
			selected: ["ext-a", "ext-b", "ext-c"],
			onchange: vi.fn(),
		});
		const row = await screen.findByTestId("selected-extension-chips");
		const label = row.getAttribute("aria-label") ?? "";
		expect(label).toContain("Reorderable extension list");
	});

	test("selected chip row uses dndzone action (data-dnd-zone attribute present)", async () => {
		render(ExtensionSearchPicker, {
			selected: ["ext-a", "ext-b", "ext-c"],
			onchange: vi.fn(),
		});
		const row = await screen.findByTestId("selected-extension-chips");
		// svelte-dnd-action stamps an internal `data-is-dnd-shadow-item-*`
		// presence + `aria-roledescription="sortable"`. Either is a valid
		// liveness signal; we assert the aria-roledescription which is
		// the public contract surface.
		expect(row.getAttribute("aria-roledescription")).toBe("sortable");
	});

	test("onfinalize reorder emits onchange with new id order", async () => {
		const onchange = vi.fn();
		render(ExtensionSearchPicker, {
			selected: ["ext-a", "ext-b", "ext-c"],
			onchange,
		});
		const row = await screen.findByTestId("selected-extension-chips");
		// svelte-dnd-action fires a `finalize` CustomEvent whose detail
		// carries `items: [{ id, ... }, ...]` in the new order.
		await fireEvent(
			row,
			new CustomEvent("finalize", {
				detail: {
					items: [{ id: "ext-b" }, { id: "ext-a" }, { id: "ext-c" }],
				},
			}),
		);
		expect(onchange).toHaveBeenCalledWith(["ext-b", "ext-a", "ext-c"]);
	});

	test("aria-label hints keyboard activation (Space + arrows)", async () => {
		render(ExtensionSearchPicker, {
			selected: ["ext-a"],
			onchange: vi.fn(),
		});
		const row = await screen.findByTestId("selected-extension-chips");
		const label = row.getAttribute("aria-label") ?? "";
		// Per Pitfall 5 (RESEARCH §Architecture Patterns) — keyboard
		// users need to see the activation hint in the label.
		expect(label).toMatch(/space/i);
		expect(label).toMatch(/arrow/i);
	});
});
