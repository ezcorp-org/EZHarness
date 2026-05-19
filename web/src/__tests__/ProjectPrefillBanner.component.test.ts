/**
 * Phase 48 Wave 4 — DOM tests for ProjectPrefillBanner.
 *
 * Mirrors the AgentPrefillBanner suite — both banners are presentational
 * siblings, so the contract is the same. Kept as a separate test file
 * (rather than a parametrized suite) to match the component split: if
 * the two banners' copy/style diverge later, the tests live where the
 * components do.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import ProjectPrefillBanner from "$lib/components/ez/ProjectPrefillBanner.svelte";

describe("ProjectPrefillBanner — visual states", () => {
	test("renders 'Prefilled by Ez' for the active state", () => {
		const { getByTestId, getByText } = render(ProjectPrefillBanner, {
			props: { state: "active", ondismiss: () => {} },
		});
		const el = getByTestId("project-prefill-banner");
		expect(el).toHaveAttribute("data-state", "active");
		expect(getByText(/Prefilled by Ez/i)).toBeInTheDocument();
	});

	test("renders 'This prefill expired' for the expired state", () => {
		const { getByTestId, getByText } = render(ProjectPrefillBanner, {
			props: { state: "expired", ondismiss: () => {} },
		});
		const el = getByTestId("project-prefill-banner");
		expect(el).toHaveAttribute("data-state", "expired");
		expect(getByText(/This prefill expired/i)).toBeInTheDocument();
	});

	test("defaults to active state when no `state` prop is supplied", () => {
		const { getByTestId } = render(ProjectPrefillBanner, { props: { ondismiss: () => {} } });
		expect(getByTestId("project-prefill-banner")).toHaveAttribute("data-state", "active");
	});
});

describe("ProjectPrefillBanner — dismiss behaviour", () => {
	test("clicking the close button raises `ondismiss`", async () => {
		const dismiss = vi.fn();
		const { getByTestId } = render(ProjectPrefillBanner, {
			props: { state: "active", ondismiss: dismiss },
		});
		await fireEvent.click(getByTestId("project-prefill-banner-dismiss"));
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	test("omits the close button when `ondismiss` is not provided", () => {
		const { queryByTestId } = render(ProjectPrefillBanner, { props: { state: "active" } });
		expect(queryByTestId("project-prefill-banner-dismiss")).toBeNull();
	});
});
