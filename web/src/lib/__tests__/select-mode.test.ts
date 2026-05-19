import { describe, test, expect } from "bun:test";
import {
	toggleSelection,
	clearSelection,
	isSelected,
	selectionSize,
	orderedSelection,
	selectRange,
} from "../select-mode.js";

describe("select-mode helpers", () => {
	test("toggleSelection returns a fresh Set with the id added when absent", () => {
		const initial = new Set<string>(["a"]);
		const next = toggleSelection(initial, "b");
		expect(next).not.toBe(initial); // new reference for Svelte reactivity
		expect(next.has("a")).toBe(true);
		expect(next.has("b")).toBe(true);
		// initial is untouched
		expect(initial.has("b")).toBe(false);
	});

	test("toggleSelection removes the id when already present", () => {
		const next = toggleSelection(new Set(["a", "b"]), "a");
		expect(next.has("a")).toBe(false);
		expect(next.has("b")).toBe(true);
	});

	test("clearSelection returns an empty Set", () => {
		const cleared = clearSelection();
		expect(cleared.size).toBe(0);
	});

	test("isSelected and selectionSize reflect the set contents", () => {
		const s = new Set(["a", "c"]);
		expect(isSelected(s, "a")).toBe(true);
		expect(isSelected(s, "b")).toBe(false);
		expect(selectionSize(s)).toBe(2);
	});

	test("orderedSelection preserves reference order and filters unselected ids", () => {
		const sel = new Set(["m-3", "m-1"]);
		const order = ["m-1", "m-2", "m-3", "m-4"];
		expect(orderedSelection(sel, order)).toEqual(["m-1", "m-3"]);
	});

	test("orderedSelection drops ids absent from the reference order", () => {
		const sel = new Set(["m-1", "stray"]);
		expect(orderedSelection(sel, ["m-1", "m-2"])).toEqual(["m-1"]);
	});

	test("toggleSelection on an empty set adds the id", () => {
		const next = toggleSelection(new Set(), "x");
		expect(Array.from(next)).toEqual(["x"]);
	});

	test("toggling the same id twice returns the original membership", () => {
		const start = new Set<string>(["a"]);
		const after = toggleSelection(toggleSelection(start, "b"), "b");
		expect(Array.from(after).sort()).toEqual(["a"]);
	});
});

describe("selectRange", () => {
	const order = ["m-1", "m-2", "m-3", "m-4", "m-5"];

	test("forward range adds every id between anchor and target inclusive", () => {
		const next = selectRange(new Set(), order, "m-2", "m-4");
		expect(Array.from(next).sort()).toEqual(["m-2", "m-3", "m-4"]);
	});

	test("reverse range works when anchor is after target", () => {
		const next = selectRange(new Set(), order, "m-4", "m-2");
		expect(Array.from(next).sort()).toEqual(["m-2", "m-3", "m-4"]);
	});

	test("range is additive — pre-existing selections are preserved", () => {
		const initial = new Set(["m-1", "m-5"]);
		const next = selectRange(initial, order, "m-2", "m-3");
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-5"]);
	});

	test("returns a fresh Set so Svelte reactivity picks up the change", () => {
		const initial = new Set<string>(["m-1"]);
		const next = selectRange(initial, order, "m-2", "m-3");
		expect(next).not.toBe(initial);
		expect(initial.has("m-2")).toBe(false); // input untouched
	});

	test("anchor === target selects just that single id", () => {
		const next = selectRange(new Set(), order, "m-3", "m-3");
		expect(Array.from(next)).toEqual(["m-3"]);
	});

	test("missing anchor returns the input set unchanged", () => {
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, order, "missing", "m-3");
		expect(next).toBe(initial);
	});

	test("missing target returns the input set unchanged", () => {
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, order, "m-2", "missing");
		expect(next).toBe(initial);
	});

	test("skipPredicate excludes matching ids from the range", () => {
		const orderWithStream = ["m-1", "m-2", "streaming-r1", "m-3", "m-4"];
		const next = selectRange(new Set(), orderWithStream, "m-1", "m-4", {
			skipPredicate: (id) => id.startsWith("streaming-"),
		});
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
	});

	test("toggle:true on already-selected target removes ONLY the target — not the range", () => {
		// User has m-1..m-4 selected (e.g. anchor=m-1, prior shift+click range-added).
		// Now shift+clicking m-3 should deselect just m-3, leaving m-1, m-2, m-4
		// intact. This is the "uncheck one in the middle" case the user asked for.
		const initial = new Set(["m-1", "m-2", "m-3", "m-4"]);
		const next = selectRange(initial, order, "m-1", "m-3", { toggle: true });
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-4"]);
	});

	test("toggle:true on already-selected target does NOT remove items past the click", () => {
		// Anchor at the BOTTOM of the range (m-5). Earlier behavior would have
		// removed m-3..m-5 here, dropping items "below" the click. New behavior
		// only drops the clicked id — m-4, m-5 stay selected.
		const initial = new Set(["m-1", "m-2", "m-3", "m-4", "m-5"]);
		const next = selectRange(initial, order, "m-5", "m-3", { toggle: true });
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-4", "m-5"]);
	});

	test("toggle:true adds the range when the target is not selected", () => {
		// Target unselected → behaves like the additive mode.
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, order, "m-2", "m-4", { toggle: true });
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
	});

	test("toggle:true with mixed selection — target unselected adds the full range", () => {
		// Range = m-2..m-4. m-3 is selected, m-4 (target) is NOT → add the range.
		const initial = new Set(["m-1", "m-3"]);
		const next = selectRange(initial, order, "m-2", "m-4", { toggle: true });
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
	});

	test("toggle:true with anchor === target and target selected deselects that id", () => {
		const initial = new Set(["m-1", "m-3"]);
		const next = selectRange(initial, order, "m-3", "m-3", { toggle: true });
		expect(Array.from(next).sort()).toEqual(["m-1"]);
	});

	test("default mode (toggle omitted) is additive — does not remove pre-selected ids", () => {
		const initial = new Set(["m-1", "m-2", "m-3", "m-4"]);
		const next = selectRange(initial, order, "m-2", "m-4");
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
	});

	test("empty orderedIds returns the input set unchanged", () => {
		// Defensive: if the visible message list is empty (e.g. before initial
		// load) range expansion must not crash or mutate state.
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, [], "m-1", "m-2");
		expect(next).toBe(initial);
	});

	test("invalid args in toggle mode also return the same reference (no spurious churn)", () => {
		// Mirrors the additive-mode "missing anchor" guard for the toggle path.
		// Returning a fresh Set here would make Svelte's `$state` re-render for
		// no real change, causing flicker.
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, order, "missing", "m-3", { toggle: true });
		expect(next).toBe(initial);
	});

	test("toggle:true + skipPredicate when target is unselected — predicate still skips matching ids", () => {
		// Adding the range respects skipPredicate: streaming placeholders in
		// the middle of the range stay out even when toggle mode is on.
		const orderWithStream = ["m-1", "m-2", "streaming-r1", "m-3", "m-4"];
		const next = selectRange(new Set(), orderWithStream, "m-1", "m-4", {
			skipPredicate: (id) => id.startsWith("streaming-"),
			toggle: true,
		});
		expect(Array.from(next).sort()).toEqual(["m-1", "m-2", "m-3", "m-4"]);
	});

	test("skipPredicate that excludes every id in the range is a no-op", () => {
		// e.g. a range comprised entirely of streaming placeholders. Returns a
		// fresh Set (the additive-path doesn't short-circuit on this), but
		// contents match the input.
		const initial = new Set(["m-1"]);
		const next = selectRange(initial, order, "m-2", "m-4", {
			skipPredicate: () => true,
		});
		expect(Array.from(next).sort()).toEqual(["m-1"]);
	});
});
