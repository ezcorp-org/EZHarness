/**
 * Phase 57 — GAP-57-C regression: SelectedPill chipId → data-chip-id pass-through.
 *
 * Plan 57-05 added an optional `chipId` prop (verbatim at
 * SelectedPill.svelte:13-27) that ExtensionSearchPicker (chip row
 * drag-reorder, UX-04) depends on for per-chip e2e queries:
 *   <SelectedPill chipId={item.id} ... />
 *
 * Without this test, a refactor could (a) flip the prop to a no-op,
 * (b) hardcode the attribute, (c) emit it as `undefined` literal string
 * — and the chip-reorder e2e (fixme'd pending auth-fixture infra) would
 * not catch it.
 *
 * Two cases:
 *   1. chipId="ext-a" → element has data-chip-id="ext-a".
 *   2. chipId omitted → element has NO data-chip-id attribute.
 *
 * Runner: vitest (jsdom env).
 */

import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SelectedPill from "../SelectedPill.svelte";

describe("SelectedPill chipId -> data-chip-id pass-through (GAP-57-C)", () => {
	test("renders data-chip-id=<value> when chipId prop is supplied", () => {
		render(SelectedPill, {
			label: "Extension A",
			onremove: vi.fn(),
			chipId: "ext-a",
		});
		const pill = screen.getByTestId("selected-pill");
		expect(pill.getAttribute("data-chip-id")).toBe("ext-a");
	});

	test("omits data-chip-id attribute when chipId prop is undefined", () => {
		render(SelectedPill, {
			label: "Extension B",
			onremove: vi.fn(),
			// chipId intentionally omitted
		});
		const pill = screen.getByTestId("selected-pill");
		// Svelte 5 omits attributes bound to `undefined` from the DOM
		// (verified at SelectedPill.svelte:47 — `data-chip-id={chipId}`).
		// hasAttribute is the precise check: a literal `undefined` string
		// value would also fail toBeNull on getAttribute, so hasAttribute
		// is the stronger assertion.
		expect(pill.hasAttribute("data-chip-id")).toBe(false);
	});
});
