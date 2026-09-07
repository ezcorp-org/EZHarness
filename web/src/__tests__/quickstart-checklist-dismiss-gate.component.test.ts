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
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import QuickStartChecklist from "$lib/components/QuickStartChecklist.svelte";
import { store } from "$lib/stores.svelte.js";

function setQuickstartSteps(steps: { provider: boolean; chat: boolean; extension: boolean; agent: boolean }) {
	store.quickstartSteps = steps;
}

describe("QuickStartChecklist — dismiss-gate", () => {
	beforeEach(() => {
		localStorage.clear();
		setQuickstartSteps({ provider: false, chat: false, extension: false, agent: false });
	});
	afterEach(() => {
		localStorage.clear();
	});

	test("progress=0 → dismiss button is hidden (collapse remains)", async () => {
		const { findByText, queryByLabelText, queryByTitle } = render(QuickStartChecklist);

		// Wait for the initial completion state to render.
		await findByText("0/4");

		expect(queryByTitle("Dismiss checklist")).toBeNull();
		expect(queryByLabelText("Dismiss checklist")).toBeNull();
	});

	test("an unknown role gets provider guidance without a settings link", async () => {
		const { findByText, container } = render(QuickStartChecklist);
		await findByText("Ask an admin to connect a provider");
		expect(container.querySelector('a[href="/settings/models#providers"]')).toBeNull();
	});

	test("a member gets provider guidance without a settings link", async () => {
		const { findByText, container } = render(QuickStartChecklist, { role: "member" });
		await findByText("Ask an admin to connect a provider");
		expect(container.querySelector('a[href="/settings/models#providers"]')).toBeNull();
	});

	test("an admin can open provider settings from the checklist", async () => {
		const { findByRole } = render(QuickStartChecklist, { role: "admin" });
		const setup = await findByRole("link", { name: "Set up a provider" });
		expect(setup).toHaveAttribute("href", "/settings/models#providers");
	});

	test("a member sees provider ready as a completed status", async () => {
		setQuickstartSteps({ provider: true, chat: false, extension: false, agent: false });
		const { findByText, container } = render(QuickStartChecklist, { role: "member" });
		await findByText("Provider ready");
		expect(container.querySelector('a[href="/settings/models#providers"]')).toBeNull();
	});

	test("progress=1 → dismiss button appears", async () => {
		setQuickstartSteps({ provider: true, chat: false, extension: false, agent: false });
		const { findByText, getByLabelText } = render(QuickStartChecklist);

		await findByText("1/4");

		expect(getByLabelText("Dismiss checklist")).toBeInTheDocument();
	});

	test("progress=2 → dismiss button appears", async () => {
		setQuickstartSteps({ provider: true, chat: true, extension: false, agent: false });
		const { findByText, getByLabelText } = render(QuickStartChecklist);

		await findByText("2/4");

		expect(getByLabelText("Dismiss checklist")).toBeInTheDocument();
	});

	test("clicking dismiss when visible removes the checklist from the DOM", async () => {
		setQuickstartSteps({ provider: true, chat: false, extension: false, agent: false });
		const { findByText, getByLabelText, queryByText } = render(QuickStartChecklist);

		await findByText("1/4");

		await fireEvent.click(getByLabelText("Dismiss checklist"));
		// After dismiss, the entire panel is removed (the {#if !dismissed} guard).
		await waitFor(() => expect(queryByText("Get Started")).toBeNull());
	});

	test("dismiss persists across renders via localStorage", async () => {
		setQuickstartSteps({ provider: true, chat: false, extension: false, agent: false });
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
