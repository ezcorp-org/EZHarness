/**
 * Direct 4-state test for SaveIndicator (locked decision 5):
 * idle renders nothing; saving > error > saved precedence.
 */
import { describe, test, expect } from "vitest";
import { render } from "@testing-library/svelte";
import SaveIndicator from "../settings/SaveIndicator.svelte";

describe("SaveIndicator states", () => {
	test("idle renders nothing", () => {
		const { container } = render(SaveIndicator);
		expect(container.querySelector("[data-testid^='save-indicator']")).toBeNull();
	});

	test("saving renders the Saving... status", () => {
		const { getByTestId } = render(SaveIndicator, { props: { saving: true } });
		const el = getByTestId("save-indicator-saving");
		expect(el).toHaveTextContent("Saving...");
		expect(el).toHaveAttribute("role", "status");
	});

	test("saved renders the green confirmation", () => {
		const { getByTestId } = render(SaveIndicator, { props: { saved: true } });
		const el = getByTestId("save-indicator-saved");
		expect(el).toHaveTextContent("Saved ✓");
		expect(el.className).toContain("text-green-400");
	});

	test("error renders the alert and wins over saved", () => {
		const { getByTestId, queryByTestId } = render(SaveIndicator, {
			props: { error: true, saved: true },
		});
		const el = getByTestId("save-indicator-error");
		expect(el).toHaveTextContent("Save failed — try again");
		expect(el).toHaveAttribute("role", "alert");
		expect(queryByTestId("save-indicator-saved")).toBeNull();
	});

	test("saving wins over error and saved", () => {
		const { getByTestId, queryByTestId } = render(SaveIndicator, {
			props: { saving: true, error: true, saved: true },
		});
		expect(getByTestId("save-indicator-saving")).toBeInTheDocument();
		expect(queryByTestId("save-indicator-error")).toBeNull();
		expect(queryByTestId("save-indicator-saved")).toBeNull();
	});
});
