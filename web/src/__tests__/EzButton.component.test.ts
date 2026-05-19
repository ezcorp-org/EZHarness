/**
 * Phase 48 Wave 3 — DOM tests for the floating Ez button.
 *
 * Covers:
 *   - default render is visible and labeled
 *   - clicking invokes the onopen prop (and the global open store
 *     when no prop is passed)
 *   - the button hides when the Ez panel is open (visibility derived
 *     from the panel-open store)
 *   - explicit `hidden` prop force-hides the button
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import EzButton from "$lib/components/ez/EzButton.svelte";
import { ezPanelState, closeEzPanel } from "$lib/ez/panel-store.svelte.js";

beforeEach(() => {
	closeEzPanel();
});

describe("EzButton — visibility", () => {
	test("renders with the Ez label by default", () => {
		const { getByTestId } = render(EzButton);
		const btn = getByTestId("ez-button");
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveAccessibleName(/Open Ez/i);
	});

	test("hides itself when the Ez panel is open (derived from store)", async () => {
		const { queryByTestId, rerender } = render(EzButton);
		expect(queryByTestId("ez-button")).toBeInTheDocument();

		ezPanelState.open = true;
		// Svelte 5 reactivity needs a tick — re-render forces the derived
		// recompute; in production the runes runtime does this automatically.
		await rerender({});
		expect(queryByTestId("ez-button")).toBeNull();
	});

	test("respects an explicit hidden prop", () => {
		const { queryByTestId } = render(EzButton, { props: { hidden: true } });
		expect(queryByTestId("ez-button")).toBeNull();
	});
});

describe("EzButton — click behaviour", () => {
	test("invokes onopen prop when clicked", async () => {
		const onopen = vi.fn();
		const { getByTestId } = render(EzButton, { props: { onopen } });
		await fireEvent.click(getByTestId("ez-button"));
		expect(onopen).toHaveBeenCalledTimes(1);
	});

	test("opens the global panel store when no onopen is provided", async () => {
		const { getByTestId } = render(EzButton);
		expect(ezPanelState.open).toBe(false);
		await fireEvent.click(getByTestId("ez-button"));
		expect(ezPanelState.open).toBe(true);
	});
});
