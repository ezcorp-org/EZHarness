import type { Locator, Page } from "@playwright/test";
// `expect` is re-exported by test-base rather than imported straight from
// "@playwright/test": a VALUE import of the package from a fixture can
// resolve a second copy and trip the "did not expect test.describe()"
// runtime guard (see picker-helpers.ts). Going through test-base reuses the
// exact module instance every spec already loads.
import { expect } from "./test-base";

/**
 * Anything that can scope composer queries: the whole `Page` (main chat) or a
 * `Locator` for a sub-surface (the agent panel's drawer).
 */
export type ComposerScope = Pick<Page | Locator, "getByRole" | "locator">;

/**
 * Type a message into a composer and send it — waiting for the composer to be
 * genuinely INTERACTIVE first.
 *
 * WHY THIS EXISTS (CI failure on PR #141, `Visual evidence` job):
 * the chat route is server-rendered, and the SSR payload already contains the
 * empty-state paragraph, the `<textarea>` AND the send button — 33 KB of HTML
 * with zero JavaScript executed. So the obvious gate,
 *
 *     await expect(page.getByText("Send a message to start the conversation"))
 *         .toBeVisible();
 *
 * is satisfied at FIRST PAINT and proves nothing about the app being alive.
 * A `fill()` right after it lands on the pre-hydration DOM node; hydration
 * then re-creates the composer with `value = ""`, the typed text is silently
 * discarded, and `disabled={(!value.trim() && …) || …}` stays true FOREVER.
 * The click then burns its full timeout against a permanently-disabled button
 * (30s on the CI runner) — a terminal state, not a slow one. Locally the
 * window is a few milliseconds wide, so it never reproduced; on a 4-core
 * runner the client data-load started ~590ms AFTER the click had begun.
 *
 * The reliable gate is a property that CANNOT be true before hydration: the
 * send button's `title` flips from "Select a model first" to "Send message"
 * only once `selectedModel` resolves, which needs hydration + `/api/models` +
 * the picker's autoselect. SSR always emits the "Select a model first" form
 * (verified against the raw HTML), so this cannot false-pass.
 *
 * The post-fill `toBeEnabled()` is the second half: if the value is ever lost
 * again the spec fails fast and legibly on the assertion instead of hanging on
 * an un-clickable button.
 */
export async function sendComposerMessage(
	scope: ComposerScope,
	text: string,
): Promise<void> {
	const sendBtn = scope.getByRole("button", { name: "Send message" });
	// 1. Composer is hydrated and has resolved a model (NOT SSR-satisfiable).
	await expect(sendBtn).toHaveAttribute("title", "Send message", {
		timeout: 20_000,
	});
	// 2. Now the textarea is a live component, so the value will stick.
	await scope.locator("textarea").fill(text);
	// 3. Prove it stuck before clicking — a lost value fails here, loudly.
	await expect(sendBtn).toBeEnabled({ timeout: 10_000 });
	await sendBtn.click();
}
