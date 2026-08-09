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

/** The inline `<input>` FilePicker renders at lg+ (absent on the mobile shim). */
function inlinePickerInput(page: Page) {
  return page.locator('[data-testid="open-file-picker"] input');
}

/**
 * The path a user can SEE in a FilePicker, whichever variant rendered.
 *
 * FilePicker.svelte has two shapes: at lg+ the text input is inline, and
 * below lg it collapses to a trigger button labelled with the current value
 * (the real input lives in a BottomSheet). A spec asserting the value would
 * otherwise have to branch on viewport width.
 */
export async function filePickerValue(page: Page): Promise<string> {
  const inline = inlinePickerInput(page);
  if (await inline.count()) return await inline.first().inputValue();
  return (await page.getByTestId("open-file-picker").innerText()).trim();
}

/**
 * The FilePicker's real text input, ready to type into — opening the mobile
 * BottomSheet first when that is the rendered variant. Idempotent: a sheet
 * that is already open is reused rather than re-triggered (the trigger sits
 * under the sheet's backdrop once it is up).
 */
export async function openFilePickerInput(page: Page, placeholder: string) {
  const inline = inlinePickerInput(page);
  if (await inline.count()) return inline.first();

  const sheet = page.getByTestId("bottom-sheet");
  if (!(await sheet.isVisible().catch(() => false))) {
    await page.getByTestId("open-file-picker").click();
  }
  const sheetInput = sheet.getByPlaceholder(placeholder);
  await sheetInput.waitFor({ state: "visible", timeout: 3000 });
  return sheetInput;
}
