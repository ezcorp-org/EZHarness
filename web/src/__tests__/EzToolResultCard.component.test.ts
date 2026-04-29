/**
 * Phase 48 Wave 3 — DOM tests for EzToolResultCard.
 *
 * Covers:
 *   - the single primary "Open prefilled form" button renders
 *   - clicking it calls `goto(openUrl)` with the result's URL
 *   - tool-name-specific defaults (project / agent / extension) render
 *   - the button is disabled when no openUrl is supplied
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi } from "vitest";
import EzToolResultCard from "$lib/components/ez/EzToolResultCard.svelte";

describe("EzToolResultCard — render", () => {
	test("renders the single primary 'Open prefilled form' button", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/new-project?prefill=abc", draftId: "abc" },
				goto: vi.fn(),
			},
		});
		const btn = getByTestId("ez-card-open");
		expect(btn).toBeInTheDocument();
		expect(btn).toHaveTextContent(/Open prefilled form/i);
	});

	test("uses propose_create_project default copy when toolName matches", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/new-project?prefill=abc" },
				toolName: "propose_create_project",
				goto: vi.fn(),
			},
		});
		const card = getByTestId("ez-tool-result-card");
		expect(card).toHaveTextContent(/Open new project form/i);
		expect(card).toHaveAttribute("data-tool-name", "propose_create_project");
	});

	test("uses propose_create_agent default copy when toolName matches", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/agents/new?prefill=abc" },
				toolName: "propose_create_agent",
				goto: vi.fn(),
			},
		});
		expect(getByTestId("ez-tool-result-card")).toHaveTextContent(/Open new agent form/i);
	});

	test("respects explicit title/summary props over defaults", () => {
		const { getByTestId } = render(EzToolResultCard, {
			props: {
				result: { openUrl: "/x", title: "Custom Heading", summary: "Custom blurb." },
				goto: vi.fn(),
			},
		});
		const card = getByTestId("ez-tool-result-card");
		expect(card).toHaveTextContent(/Custom Heading/);
		expect(card).toHaveTextContent(/Custom blurb./);
	});
});

describe("EzToolResultCard — interaction", () => {
	test("clicking the button calls goto with openUrl", async () => {
		const goto = vi.fn();
		const { getByTestId } = render(EzToolResultCard, {
			props: { result: { openUrl: "/marketplace?q=pdf" }, goto },
		});
		await fireEvent.click(getByTestId("ez-card-open"));
		expect(goto).toHaveBeenCalledWith("/marketplace?q=pdf");
	});

	test("button is disabled when openUrl is empty", () => {
		const goto = vi.fn();
		const { getByTestId } = render(EzToolResultCard, {
			props: { result: { openUrl: "" }, goto },
		});
		const btn = getByTestId("ez-card-open") as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});
});
