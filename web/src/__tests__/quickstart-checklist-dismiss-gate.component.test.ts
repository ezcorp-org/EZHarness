/**
 * Component test for the QuickStartChecklist dismiss gate.
 *
 * The X (dismiss) button used to be visible from the moment the user
 * arrived at the app, which let people miss the entire onboarding
 * surface in one click. After the gate change, the X is hidden until
 * at least one step has been completed, so a brand-new user always
 * sees their checklist. Once they've made any progress the X reappears
 * and the existing dismiss flow resumes.
 *
 * Covers:
 *   - progress=0 (fresh /api/quickstart with all steps false): X absent
 *   - progress=1+ (any step true): X present
 *   - X click still dismisses (uses the localStorage flag the component
 *     already maintains)
 *
 * Collapse (the chevron toggle) is intentionally NOT gated — users can
 * always shrink the panel visually.
 */

import "@testing-library/jest-dom/vitest";
import { render, waitFor, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

import QuickStartChecklist from "$lib/components/QuickStartChecklist.svelte";

function quickstartResponse(steps: { provider: boolean; chat: boolean; extension: boolean; agent: boolean }): Response {
	return new Response(JSON.stringify({ steps }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

describe("QuickStartChecklist — dismiss-gate", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		localStorage.clear();
		fetchSpy = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchSpy.mockRestore();
		localStorage.clear();
	});

	test("progress=0 → dismiss button is hidden (collapse remains)", async () => {
		fetchSpy.mockResolvedValue(quickstartResponse({ provider: false, chat: false, extension: false, agent: false }));
		const { findByText, queryByLabelText, queryByTitle } = render(QuickStartChecklist);

		// Wait for the steps to render so we know the API resolved.
		await findByText("0/4");

		expect(queryByTitle("Dismiss checklist")).toBeNull();
		expect(queryByLabelText("Dismiss checklist")).toBeNull();
	});

	test("progress=1 → dismiss button appears", async () => {
		fetchSpy.mockResolvedValue(quickstartResponse({ provider: true, chat: false, extension: false, agent: false }));
		const { findByText, getByLabelText } = render(QuickStartChecklist);

		await findByText("1/4");

		expect(getByLabelText("Dismiss checklist")).toBeInTheDocument();
	});

	test("progress=2 → dismiss button appears", async () => {
		fetchSpy.mockResolvedValue(quickstartResponse({ provider: true, chat: true, extension: false, agent: false }));
		const { findByText, getByLabelText } = render(QuickStartChecklist);

		await findByText("2/4");

		expect(getByLabelText("Dismiss checklist")).toBeInTheDocument();
	});

	test("clicking dismiss when visible removes the checklist from the DOM", async () => {
		fetchSpy.mockResolvedValue(quickstartResponse({ provider: true, chat: false, extension: false, agent: false }));
		const { findByText, getByLabelText, queryByText } = render(QuickStartChecklist);

		await findByText("1/4");

		await fireEvent.click(getByLabelText("Dismiss checklist"));
		// After dismiss, the entire panel is removed (the {#if !dismissed} guard).
		await waitFor(() => expect(queryByText("Get Started")).toBeNull());
	});

	test("dismiss persists across renders via localStorage", async () => {
		fetchSpy.mockResolvedValue(quickstartResponse({ provider: true, chat: false, extension: false, agent: false }));
		const first = render(QuickStartChecklist);
		await first.findByText("1/4");
		await fireEvent.click(first.getByLabelText("Dismiss checklist"));
		first.unmount();

		const second = render(QuickStartChecklist);
		// Should not re-render the panel even before the API resolves —
		// the component reads localStorage synchronously on mount.
		expect(second.queryByText("Get Started")).toBeNull();
	});
});
