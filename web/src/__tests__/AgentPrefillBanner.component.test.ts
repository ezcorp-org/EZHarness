/**
 * Phase 48 Wave 4 — DOM tests for AgentPrefillBanner.
 *
 * Covers:
 *   - Active state shows "Prefilled by Ez" copy
 *   - Expired state shows "This prefill expired" copy
 *   - Dismiss button raises `ondismiss` and is omitted when no callback
 *     is supplied (the page can opt out of dismissal entirely)
 *   - Banner exposes `data-state` so the page can integration-assert
 *     on the active/expired state without scraping copy strings
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import AgentPrefillBanner from "$lib/components/ez/AgentPrefillBanner.svelte";

describe("AgentPrefillBanner — visual states", () => {
	test("renders 'Prefilled by Ez' for the active state", () => {
		const { getByTestId, getByText } = render(AgentPrefillBanner, {
			props: { state: "active", ondismiss: () => {} },
		});
		const el = getByTestId("agent-prefill-banner");
		expect(el).toHaveAttribute("data-state", "active");
		expect(getByText(/Prefilled by Ez/i)).toBeInTheDocument();
	});

	test("renders 'This prefill expired' for the expired state", () => {
		const { getByTestId, getByText } = render(AgentPrefillBanner, {
			props: { state: "expired", ondismiss: () => {} },
		});
		const el = getByTestId("agent-prefill-banner");
		expect(el).toHaveAttribute("data-state", "expired");
		expect(getByText(/This prefill expired/i)).toBeInTheDocument();
	});

	test("defaults to active state when no `state` prop is supplied", () => {
		const { getByTestId } = render(AgentPrefillBanner, { props: { ondismiss: () => {} } });
		expect(getByTestId("agent-prefill-banner")).toHaveAttribute("data-state", "active");
	});
});

describe("AgentPrefillBanner — dismiss behaviour", () => {
	test("clicking the close button raises `ondismiss`", async () => {
		const dismiss = vi.fn();
		const { getByTestId } = render(AgentPrefillBanner, {
			props: { state: "active", ondismiss: dismiss },
		});
		await fireEvent.click(getByTestId("agent-prefill-banner-dismiss"));
		expect(dismiss).toHaveBeenCalledTimes(1);
	});

	test("omits the close button when `ondismiss` is not provided", () => {
		const { queryByTestId } = render(AgentPrefillBanner, { props: { state: "active" } });
		expect(queryByTestId("agent-prefill-banner-dismiss")).toBeNull();
	});
});
