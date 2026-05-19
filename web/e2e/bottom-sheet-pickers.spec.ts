/**
 * Phase 57 — UX-01 Wave 0 RED scaffold (Playwright e2e).
 *
 * Pins the must_haves contract from PLAN frontmatter:
 *   "On a viewport <lg (<=1024px), opening any of the 9 picker components
 *    renders the picker body inside a BottomSheet.svelte with a visible
 *    close button, Escape-to-dismiss, and env(safe-area-inset-bottom)
 *    honored on iOS — WCAG 2.5.1 single-pointer equivalent satisfied."
 *
 * Sampling matrix (RESEARCH §Validation Architecture):
 *   9 pickers × 2 viewports × 3 dismiss paths + 1 iOS safe-area test
 *   + 1 axe-core scan.
 *
 * Every assertion that depends on impl that hasn't shipped uses
 * `test.fixme(true, '<wave name>')` — mirroring the L797 fixme pattern
 * in v1.3-permission-backbone.spec.ts. `test.skip` is reserved for env
 * reasons (per auto-memory `feedback_agent_briefs_no_git_stash` and the
 * CONVENTIONS.md skip-vs-fixme split).
 *
 * Run from web/:  `cd web && bunx playwright test e2e/bottom-sheet-pickers.spec.ts`
 *
 * NEVER `--watch` (auto-memory rule).
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

interface PickerSpec {
	name: string;
	url: string;
	triggerTestId: string;
}

// 9 picker entry points. Trigger URLs/selectors verified against
// CONTEXT.md UX-01 picker enumeration + RESEARCH §Architecture
// Patterns. `assignment` is the W1 smoke target (Plan 57-02 Task 3);
// the other 8 land in W2 Track A (Plan 57-03). Picker entry-point
// URLs marked TBD have a comment — Track A's task tightens them.
const PICKERS: PickerSpec[] = [
	// TBD: confirm during Wave 2 Track A — placeholder selectors will
	// be tightened in Plan 57-03 Task 1 once each picker mount point
	// is wired with a deterministic data-testid.
	{
		name: "assignment",
		url: "/teams/builder",
		triggerTestId: "open-assignment-picker",
	},
	{
		name: "agent-search",
		url: "/agents",
		triggerTestId: "open-agent-picker",
	},
	{
		name: "extension-attach",
		url: "/agents/new",
		triggerTestId: "open-extension-attach-picker",
	},
	{
		name: "extension-search",
		url: "/agents/new",
		triggerTestId: "open-extension-search-picker",
	},
	{
		name: "file",
		url: "/projects",
		triggerTestId: "open-file-picker",
	},
	{
		name: "model-search",
		url: "/agents/new",
		triggerTestId: "open-model-search-picker",
	},
	{
		name: "mode-search",
		url: "/agents/new",
		triggerTestId: "open-mode-search-picker",
	},
	{
		name: "project",
		url: "/",
		triggerTestId: "open-project-picker",
	},
	{
		name: "tool-search",
		url: "/agents/new",
		triggerTestId: "open-tool-search-picker",
	},
];

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };

test.describe.parallel("BottomSheet picker wrapping (UX-01)", () => {
	for (const picker of PICKERS) {
		// Component-level wrap landed across Plans 57-02 (assignment) +
		// 57-03 (8 remaining pickers). All 9 pickers now `import BottomSheet`
		// and use `useBreakpoint('lg').below` to wrap their body in
		// BottomSheet on <lg viewports. Each picker exposes a deterministic
		// `data-testid="open-<picker-name>"` on its trigger element.
		//
		// E2e cases REMAIN fixme because:
		// - `/teams/builder` (assignment) doesn't exist as a route.
		// - `/agents`, `/agents/new`, `/projects` live in the `(app)` protected
		//   route group requiring an authenticated session + project fixture;
		//   the non-Docker Playwright config has no auth setup.
		// - Un-fixme'ing would convert the cases into RED failures on every CI
		//   run, masking real wrap regressions.
		//
		// The wrap correctness is verified at the component layer:
		//   - `BottomSheet.component.test.ts` 8/8 GREEN (W1)
		//   - Source-grep: every picker has `import BottomSheet` + the
		//     `bp.below`/`{#if open && bp.below}` conditional snippet wrap.
		//
		// Wave 2 Track A Phase 59 (TEST-03) or an opportunistic 57-04+ pass
		// owns wiring real route fixtures + Docker auth harness so these e2e
		// cases can flip GREEN. The deterministic `open-*-picker` testids
		// landed in 57-03 mean the selectors are already correct — only the
		// URL + auth scaffolding is missing.
		const waveTag =
			picker.name === "assignment"
				? "Plan 57-02 wrap landed; route fixture + auth harness deferred to v1.5 (no /teams/builder route)"
				: "Plan 57-03 wrap landed; route fixture + auth harness deferred to v1.5 ((app) protected routes need auth)";

		test(`${picker.name}: <lg renders inside bottom-sheet`, async ({ page }) => {
			test.fixme(true, `${waveTag} provides impl`);
			await page.setViewportSize(MOBILE_VIEWPORT);
			await page.goto(picker.url);
			await page.getByTestId(picker.triggerTestId).click();
			const sheet = page.getByTestId("bottom-sheet");
			await expect(sheet).toBeVisible();
			await expect(sheet).toHaveAttribute("aria-modal", "true");
			await expect(sheet).toHaveAttribute("role", "dialog");
		});

		test(`${picker.name}: >=lg does NOT render bottom-sheet`, async ({ page }) => {
			test.fixme(true, `${waveTag} provides impl`);
			await page.setViewportSize(DESKTOP_VIEWPORT);
			await page.goto(picker.url);
			await page.getByTestId(picker.triggerTestId).click();
			await expect(page.getByTestId("bottom-sheet")).toHaveCount(0);
		});

		test(`${picker.name}: x button closes`, async ({ page }) => {
			test.fixme(true, `${waveTag} provides impl`);
			await page.setViewportSize(MOBILE_VIEWPORT);
			await page.goto(picker.url);
			await page.getByTestId(picker.triggerTestId).click();
			const sheet = page.getByTestId("bottom-sheet");
			await expect(sheet).toBeVisible();
			await page.getByLabel("Close").click();
			await expect(sheet).toHaveCount(0);
		});

		test(`${picker.name}: Escape closes`, async ({ page }) => {
			test.fixme(true, `${waveTag} provides impl`);
			await page.setViewportSize(MOBILE_VIEWPORT);
			await page.goto(picker.url);
			await page.getByTestId(picker.triggerTestId).click();
			const sheet = page.getByTestId("bottom-sheet");
			await expect(sheet).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(sheet).toHaveCount(0);
		});

		test(`${picker.name}: backdrop click closes`, async ({ page }) => {
			test.fixme(true, `${waveTag} provides impl`);
			await page.setViewportSize(MOBILE_VIEWPORT);
			await page.goto(picker.url);
			await page.getByTestId(picker.triggerTestId).click();
			const sheet = page.getByTestId("bottom-sheet");
			await expect(sheet).toBeVisible();
			// Click the backdrop (positioned outside the panel body).
			// Click at top-left where the backdrop overlays.
			await page.mouse.click(10, 10);
			await expect(sheet).toHaveCount(0);
		});
	}
});

// WebKit-only safe-area test — Playwright webkit project approximates
// iOS Safari's `env(safe-area-inset-bottom)` computed style behavior.
// CONTEXT.md UX-01 + VALIDATION.md Manual-Only confirm real-device
// visual verification is human-only; this test catches the CSS
// regression case where the env() call is missing entirely.
test("iOS safe-area: bottom-sheet honors env(safe-area-inset-bottom)", async ({
	page,
	browserName,
}) => {
	test.skip(browserName !== "webkit", "webkit-only — iOS safe-area proxy");
	test.fixme(true, "Wave 1 (Plan 57-02 Task 2) BottomSheet ships safe-area padding");
	await page.setViewportSize(MOBILE_VIEWPORT);
	await page.goto("/teams/builder");
	await page.getByTestId("open-assignment-picker").click();
	const panel = page.getByTestId("bottom-sheet-panel");
	const paddingBottom = await panel.evaluate(
		(el) => getComputedStyle(el).paddingBottom,
	);
	// The computed style will resolve env(safe-area-inset-bottom) to
	// 0px in non-iOS browsers; the regression we guard against is the
	// inline-style env() call being absent entirely.
	const inlineStyle = await panel.getAttribute("style");
	expect(inlineStyle ?? "").toContain("env(safe-area-inset-bottom");
	expect(paddingBottom).toBeDefined();
});

// WCAG via axe-core — the BottomSheet must pass a clean axe scan on
// its dialog role. Catches missing aria-modal, missing focus trap,
// orphaned interactive controls outside the dialog.
test("bottom-sheet axe-core scan: 0 violations on dialog role", async ({ page }) => {
	test.fixme(true, "Wave 1 (Plan 57-02 Task 2) BottomSheet ships WCAG-clean dialog");
	await page.setViewportSize(MOBILE_VIEWPORT);
	await page.goto("/teams/builder");
	await page.getByTestId("open-assignment-picker").click();
	await expect(page.getByTestId("bottom-sheet")).toBeVisible();
	const results = await new AxeBuilder({ page })
		.include('[data-testid="bottom-sheet"]')
		.analyze();
	expect(results.violations).toEqual([]);
});
