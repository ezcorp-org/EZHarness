/**
 * Direct tests for the SettingsSection shell (locked decision 11):
 * collapsible accordion variant (chevron, description placement,
 * aria-expanded) and the static variant with tooltip.
 */
import { describe, test, expect } from "vitest";
import { render, fireEvent } from "@testing-library/svelte";
import SettingsSection from "../settings/SettingsSection.svelte";

describe("SettingsSection collapsible variant", () => {
	test("toggles open state; description moves below the header when collapsed", async () => {
		const { getByRole, getByText, container } = render(SettingsSection, {
			props: {
				id: "demo",
				title: "Demo Section",
				description: "What this section does.",
				collapsible: true,
			},
		});

		const header = getByRole("button");
		expect(header).toHaveAttribute("aria-expanded", "true");
		// Open: description inside the bordered body.
		expect(getByText("What this section does.")).toBeInTheDocument();
		expect(container.querySelector("section#demo")).not.toBeNull();

		await fireEvent.click(header);
		expect(header).toHaveAttribute("aria-expanded", "false");
		// Collapsed: description still visible (rendered under the header).
		expect(getByText("What this section does.")).toBeInTheDocument();
		expect(container.querySelector(".border-t")).toBeNull(); // body gone

		await fireEvent.click(header);
		expect(header).toHaveAttribute("aria-expanded", "true");
	});
});

describe("SettingsSection static variant", () => {
	test("renders title, description, tooltip, and testid", () => {
		const { getByText, getByTestId, container } = render(SettingsSection, {
			props: {
				title: "Security",
				description: "Rate limits and quotas.",
				tooltip: "Applies globally to all users.",
				testid: "settings-security-shell",
			},
		});

		expect(getByText("Security")).toBeInTheDocument();
		expect(getByText("Rate limits and quotas.")).toBeInTheDocument();
		expect(getByTestId("settings-security-shell")).toBeInTheDocument();
		// InfoTooltip rendered next to the title.
		expect(container.querySelector("h2 button, h2 [role='tooltip'], h2 svg")).not.toBeNull();
	});
});
