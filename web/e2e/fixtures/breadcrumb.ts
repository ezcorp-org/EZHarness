import type { Page } from "@playwright/test";
import { expect } from "./hydration.js";

/**
 * Assert the Command Deck strip is the page's ONE breadcrumb landmark and
 * carries the expected content.
 *
 * The strip (`data-testid="deck-breadcrumb"`) IS the accessible
 * `<nav aria-label="Breadcrumb">` — there is no separate page-level
 * breadcrumb component, so `getByRole("navigation", { name: "Breadcrumb" })`
 * must resolve to exactly this element. `section` is optional because not
 * every caller cares about the middle crumb; `tail` is required so a
 * caller must say explicitly whether it expects one (`null` asserts none).
 */
export async function expectDeckBreadcrumb(
	page: Page,
	{ section, tail }: { section?: string; tail: string | null },
): Promise<void> {
	const landmark = page.getByRole("navigation", { name: "Breadcrumb" });
	await expect(landmark).toHaveCount(1);
	await expect(landmark).toBeVisible();
	// The landmark IS the strip, not a second element wrapping or overlapping
	// it — assert identity via the strip's own test id rather than treating
	// them as two locators that merely happen to agree.
	await expect(landmark).toHaveAttribute("data-testid", "deck-breadcrumb");

	await expect(landmark.locator("ol")).toHaveCount(1);

	if (section) {
		await expect(landmark).toContainText(section);
	}

	if (tail === null) {
		await expect(landmark.getByTestId("deck-breadcrumb-tail")).toHaveCount(0);
	} else {
		await expect(landmark.getByTestId("deck-breadcrumb-tail")).toHaveText(tail);
	}
}
