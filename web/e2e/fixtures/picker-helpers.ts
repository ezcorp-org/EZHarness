import type { Page } from "@playwright/test";

/**
 * Below lg the ExtensionSearchPicker body is wrapped in a BottomSheet that
 * stays open for multi-select; dismiss it before interacting with the form
 * underneath (the sheet + backdrop cover the whole viewport). No-op on
 * desktop, where selecting an option closes the dropdown.
 *
 * Deliberately avoids importing `expect` — a value import of
 * "@playwright/test" from a fixture can resolve a second copy of the
 * package, which trips the "did not expect test.describe()" runtime guard.
 */
export async function dismissPickerSheet(page: Page) {
	const sheet = page.getByTestId("bottom-sheet");
	if (await sheet.isVisible().catch(() => false)) {
		await sheet.getByRole("button", { name: "Close", exact: true }).click();
		await sheet.waitFor({ state: "hidden", timeout: 3000 });
	}
}
