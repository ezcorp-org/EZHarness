/**
 * DockOpenPill renders the navigable affordance and clicks open the dock.
 * canvas-dock-sdk.md §5 component case #DockOpenPill.
 */
import { render, fireEvent, cleanup } from "@testing-library/svelte";
import { describe, test, expect, afterEach, beforeEach } from "vitest";
import DockOpenPill from "./DockOpenPill.svelte";
import { store, closeDock } from "$lib/stores.svelte.js";

afterEach(() => {
	cleanup();
	for (const k of Object.keys(store.dockState)) closeDock(k);
});

beforeEach(() => {
	for (const k of Object.keys(store.dockState)) delete store.dockState[k];
});

describe("DockOpenPill", () => {
	test('renders the "Canvas open" affordance and click calls openDock', async () => {
		const { getByTestId } = render(DockOpenPill, {
			toolCallId: "tc-pill-1",
			conversationId: "conv-1",
		});
		const pill = getByTestId("dock-open-pill");
		expect(pill).toBeInTheDocument();
		expect(pill.textContent).toContain("Canvas open");
		await fireEvent.click(pill);
		expect(store.dockState["conv-1"]?.toolCallId).toBe("tc-pill-1");
	});
});
