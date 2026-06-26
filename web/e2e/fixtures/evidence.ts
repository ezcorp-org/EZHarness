import type { Page, TestInfo, Locator } from "@playwright/test";

/**
 * Capture a deterministic visual-evidence screenshot and attach it to the
 * current test as a PNG.
 *
 * HARD no-op unless `EZCORP_E2E_EVIDENCE === "1"` — normal local/CI runs
 * never take a screenshot here, so they stay byte-identical. Evidence mode
 * is opt-in (`EZCORP_E2E_EVIDENCE=1 bunx playwright test --grep @evidence`)
 * and the captured attachments are surfaced through Playwright's `blob`
 * reporter (see `playwright.config.ts`).
 *
 * The capture is stabilised before the shot (fonts ready, network idle,
 * animations + caret disabled, CSS-pixel scale) so successive runs produce
 * comparable images. `opts.mask` blanks volatile regions (timestamps, etc.)
 * and `opts.fullPage` captures beyond the viewport.
 */
export async function captureEvidence(
	page: Page,
	testInfo: TestInfo,
	label: string,
	opts: { fullPage?: boolean; mask?: Locator[] } = {},
): Promise<void> {
	if (process.env.EZCORP_E2E_EVIDENCE !== "1") return; // hard no-op
	await page.evaluate(() => document.fonts?.ready);
	await page.waitForLoadState("networkidle").catch(() => {});
	const body = await page.screenshot({
		fullPage: opts.fullPage ?? false,
		animations: "disabled",
		caret: "hide",
		scale: "css",
		mask: opts.mask ?? [],
	});
	await testInfo.attach(label, { body, contentType: "image/png" });
}
