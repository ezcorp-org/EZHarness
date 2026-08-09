import { test as base, type Page } from "@playwright/test";

/**
 * The one readiness gate for an e2e navigation: wait until the client app has
 * actually hydrated.
 *
 * WHY THIS EXISTS (issue #145, first observed on PR #141's `Visual evidence`
 * job, run 31139375254):
 *
 * Every route in this app is SERVER-RENDERED, so the obvious gate
 *
 *     await page.goto(`/project/${id}/chat/${convId}`);
 *     await expect(page.getByText("Send a message to start…")).toBeVisible();
 *     await page.locator("textarea").fill("hello");     // <- pre-hydration
 *
 * proves nothing. Measured against the running preview with `curl` and zero
 * JavaScript executed, that chat route returns 33 440 bytes of HTML already
 * containing the empty-state paragraph, the `<textarea>` AND the send button.
 * The assertion is satisfied at FIRST PAINT. Everything after it races
 * hydration. Locally hydration lands within milliseconds so the window never
 * opens; on a starved 4-core runner (preview server + 4 Playwright workers)
 * it does, and then:
 *
 *   1. `fill()` writes into the pre-hydration `<textarea>` node.
 *   2. Hydration re-creates the composer with component state `value = ""`.
 *   3. The typed text is silently discarded.
 *   4. `disabled={(!value.trim() && …) || …}` is now PERMANENTLY true.
 *   5. The click burns its whole timeout against a button that can never
 *      enable — a TERMINAL state, not a slow one.
 *
 * Auditing the suite found 489 such windows across 150 specs, so the fix has
 * to be structural rather than 489 hand-written gates: `app.html` ships
 * `data-hydrated="false"`, the root `+layout.svelte` onMount flips it to
 * `"true"`, and `fixtures/test-base.ts` wraps `page.goto` so EVERY navigation
 * passes through here. No spec has to remember.
 *
 * The marker cannot false-pass the way a text assertion does: `"false"` is
 * literally what the server sends, so only the client app can produce
 * `"true"`.
 */
export const HYDRATION_ATTR = "data-hydrated";

/** Default budget. Hydration is a few ms locally; this is CI-starvation slack. */
export const HYDRATION_TIMEOUT_MS = 20_000;

/**
 * Block until `<html data-hydrated="true">`.
 *
 * A document with NO `data-hydrated` attribute at all is not an EZCorp app
 * document — a non-HTML navigation such as `page.goto("/manifest.json")`, or
 * anything served outside the SvelteKit app. Nothing will ever hydrate it, so
 * the gate is vacuously satisfied instead of hanging for the full timeout.
 * That branch is safe precisely because `app.html` wraps every document the
 * app itself serves (routes AND the SvelteKit error page), so "no marker"
 * can never mean "an app page that has not hydrated yet".
 */
export async function waitForHydration(
	page: Page,
	timeout: number = HYDRATION_TIMEOUT_MS,
): Promise<void> {
	await page.waitForFunction(
		(attr: string) => {
			const state = document.documentElement.getAttribute(attr);
			if (state === null) return true; // not an app document — nothing to hydrate
			return state === "true";
		},
		HYDRATION_ATTR,
		{ timeout },
	);
}

/**
 * The base `test` for EVERY tier: a `page` whose `goto` is hydration-gated.
 *
 * It lives here, and NOT in `test-base.ts`, because the real-auth tier must
 * not import `test-base` — that module pulls in the fetch mocks, which is
 * exactly what `playwright.real.config.ts` isolates its `testDir` to prevent.
 * Both tiers still share one gate: `test-base.ts` extends this with the mock
 * fixtures, and `e2e/real-auth/**` imports this module directly.
 *
 * Wrapping `goto` is the whole fix for issue #145. The alternative — a gate
 * written out at each call site — would be 489 of them across 150 specs, and
 * the 490th would reintroduce the bug.
 */
export const test = base.extend({
	page: async ({ page }, use) => {
		const navigate = page.goto.bind(page);
		page.goto = async (url: string, options?: Parameters<Page["goto"]>[1]) => {
			const response = await navigate(url, options);
			await waitForHydration(page);
			return response;
		};
		await use(page);
	},
});

export { expect } from "@playwright/test";
