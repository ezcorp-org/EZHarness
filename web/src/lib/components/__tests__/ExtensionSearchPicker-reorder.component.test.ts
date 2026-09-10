/** Selected chip order must keep temporary drag state out of saved values. */
import { render, screen, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { SHADOW_ITEM_MARKER_PROPERTY_NAME, SHADOW_PLACEHOLDER_ITEM_ID } from "svelte-dnd-action";
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
							{ id: "ext-a", name: "ext-a", description: "ext A" },
							{ id: "ext-b", name: "ext-b", description: "ext B" },
							{ id: "ext-c", name: "ext-c", description: "ext C" },
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

	test("consider updates the visible order without saving a temporary shadow ID", async () => {
		const onchange = vi.fn();
		const { rerender } = render(ExtensionSearchPicker, {
			selected: ["ext-a", "ext-b", "ext-c"], onchange,
		});
		const row = await screen.findByTestId("selected-extension-chips");
		await fireEvent(row, new CustomEvent("consider", { detail: { items: [
			{ id: SHADOW_PLACEHOLDER_ITEM_ID, [SHADOW_ITEM_MARKER_PROPERTY_NAME]: true },
			{ id: "ext-a" }, { id: "ext-b" },
		] } }));
		expect(onchange).not.toHaveBeenCalled();
		expect(Array.from(row.querySelectorAll("[data-chip-id]"), item => item.getAttribute("data-chip-id")))
			.toEqual([SHADOW_PLACEHOLDER_ITEM_ID, "ext-a", "ext-b"]);
		// A subsequent parent change still replaces the local order.
		await rerender({ selected: ["ext-b"], onchange });
		expect(Array.from(row.querySelectorAll("[data-chip-id]"), item => item.getAttribute("data-chip-id"))).toEqual(["ext-b"]);
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
