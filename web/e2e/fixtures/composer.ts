import type { Locator, Page } from "@playwright/test";
// `expect` is re-exported by the fixture root rather than imported straight
// from "@playwright/test": a VALUE import of the package from a fixture can
// resolve a second copy and trip the "did not expect test.describe()" runtime
// guard (see picker-helpers.ts). `hydration.ts` is the root every tier loads
// (test-base extends it, real-auth imports it directly), so going through it
// reuses the exact module instance without dragging in the fetch mocks.
import { expect } from "./hydration.js";

/**
 * Anything that can scope composer queries: the whole `Page` (main chat) or a
 * `Locator` for a sub-surface (the agent panel's drawer).
 */
export type ComposerScope = Pick<Page | Locator, "getByRole" | "locator">;

/**
 * The chat thread's message list — the correct scope for "did my message land
 * in the conversation?".
 *
 * Sending a message auto-titles the conversation with that same text, so on a
 * FULLY HYDRATED page an unscoped `page.getByText(sent)` matches twice: the
 * sidebar's conversation row and the chat bubble. Playwright's strict mode
 * then fails the assertion.
 *
 * That used to pass, and for the wrong reason: before `page.goto` gated on
 * hydration (issue #145), the assertion ran while the sidebar was still the
 * server's stale render, so exactly one node matched. Scoping is the fix —
 * `.first()` would just re-pick a race, and it can silently assert on the
 * SIDEBAR row instead of the message.
 */
export function threadMessages(scope: ComposerScope): Locator {
  return scope.locator('[data-testid="chat-messages-container"]');
}

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
 *
 * STILL NEEDED after the hydration gate landed (`fixtures/hydration.ts` now
 * makes every `page.goto` wait for `<html data-hydrated="true">`). Hydration
 * is NECESSARY for the composer to be interactive but not SUFFICIENT: the
 * send button additionally needs `/api/models` to answer and the picker to
 * autoselect. The two gates are layered, not redundant.
 */
export async function sendComposerMessage(scope: ComposerScope, text: string): Promise<void> {
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
