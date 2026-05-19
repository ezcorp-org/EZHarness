/**
 * E2E for the v1.4 generic `!EZ:<extName>:<tool>` dispatch.
 *
 * Sibling to `ez-actions-distill.spec.ts` — that file pins the legacy
 * `!EZ:distill` alias path; THIS file pins the NEW generic forwarder
 * surface that lets users invoke any bundled tool by name.
 *
 * Coverage targets (per plan §1.3):
 *   1. Popover behavior — typing `!EZ:` only suggests the static
 *      EZ-action registry (currently just `distill`); generic
 *      `<extName>:<tool>` strings are typed manually.
 *   2. Manual-typed `![EZ:memory-extractor:any-tool]` submits and
 *      renders the minimal-card success envelope (NOT the
 *      distiller-specific lesson card with ref-link).
 *   3. `![EZ:non-bundled-ext:do-thing]` renders an error card
 *      (mirroring the route's "extension not bundled" branch).
 *   4. Backward compat — `![EZ:distill]` still routes through the
 *      distiller-specific envelope and renders the lesson card.
 *
 * Resolution of the open question (popover behavior):
 *   The composer's popover routes `!EZ:` queries through
 *   `/api/mentions/search?type=EZ`. The mock's static action list
 *   (api-mocks.ts:~1141) only contains `distill` — and the real
 *   server's `getEzAction()` registry only registers static action
 *   names, not arbitrary `<ext>:<tool>` combinations. So the popover
 *   ONLY suggests `distill`; users invoke other bundled tools by
 *   typing the full `![EZ:<extName>:<tool>]` token verbatim. Tests
 *   below reflect that — the manual-typed flow is the supported v1.4
 *   surface for generic dispatch.
 */
import { test, expect } from "./fixtures/test-base.js";
import {
	makeProject,
	makeConversation,
	makeMessage,
} from "./fixtures/data.js";

const PROJECT_ID = "proj-ez-generic";
const CONV_ID = "conv-ez-generic";

const project = makeProject({ id: PROJECT_ID, name: "EZ Generic Project" });
const conv = makeConversation({
	id: CONV_ID,
	projectId: PROJECT_ID,
	title: "EZ generic chat",
});

async function gotoEmptyChat(page: any, mockApi: any) {
	await mockApi({
		projects: [project],
		conversations: [conv],
		messages: [],
	});
	await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeVisible({ timeout: 5000 });
	await page.waitForFunction(
		() => {
			const listeners = (window as any).__fakeWsListeners;
			if (listeners?.open) {
				for (const fn of listeners.open) {
					try {
						fn(new Event("open"));
					} catch {}
				}
			}
			const ta = document.querySelector("textarea");
			return ta && !(ta as HTMLTextAreaElement).disabled;
		},
		{ timeout: 5000 },
	);
	await expect(textarea).toBeEnabled({ timeout: 5000 });
	await page.waitForTimeout(100);
	await textarea.click();
	return textarea;
}

test.describe("!EZ: popover — restricted to static action registry", () => {
	test("typing `!EZ:` shows ONLY the static `distill` action — generic <ext>:<tool> is not auto-suggested", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		await textarea.focus();
		await textarea.pressSequentially("!EZ:", { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		// `distill` is the only registered EZ action — confirm it shows.
		await expect(listbox).toContainText("EZ actions");
		await expect(listbox).toContainText("!EZ:distill");

		// And confirm generic `<ext>:<tool>` strings do NOT auto-suggest
		// (the popover doesn't introspect the bundled-tool registry).
		// Two representative bundled tool names that would surface IF the
		// popover did introspect — both must be absent.
		await expect(listbox).not.toContainText("memory-extractor");
		await expect(listbox).not.toContainText("lessons-distiller:distill_now");
	});
});

test.describe("!EZ:<extName>:<tool> — generic dispatch (manual-typed token)", () => {
	test("manual-typed `![EZ:memory-extractor:any-tool]` submits + renders minimal success card (no ref-link)", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		// Override the messages POST to synthesize the minimal-card
		// envelope the route returns for non-distill bundled tools.
		// Mirrors the server-side mapping in
		// web/src/routes/api/ez-actions/[name]/+server.ts (covered by
		// api-ez-actions-generic.server.test.ts).
		await page.route(
			`**/api/conversations/${CONV_ID}/messages`,
			async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				const userMsg = makeMessage({
					id: "user-msg-generic",
					conversationId: CONV_ID,
					role: "user",
					content: "![EZ:memory-extractor:any-tool]",
				});
				return route.fulfill({
					json: {
						userMessage: userMsg,
						runId: null, // action-only; no LLM streaming.
						attachments: [],
						ezActionResults: [
							{
								id: "ez-generic-1",
								role: "ez-action-result",
								content: JSON.stringify({
									kind: "success",
									card: {
										title: "memory-extractor ran successfully",
										body: "compaction merged 3 memories",
										variant: "success",
									},
									// NO `ref` field — minimal-card envelope omits it.
								}),
							},
						],
					},
				});
			},
		);

		// Type the full structured token verbatim (no popover path —
		// the popover doesn't suggest `<ext>:<tool>` combinations).
		// Trailing space dismisses the popover (the `!` trigger regex
		// requires `[^\s]*$` at end-of-input — whitespace breaks it),
		// otherwise Enter would commit a popover selection instead of
		// sending the message.
		await textarea.focus();
		await textarea.pressSequentially("![EZ:memory-extractor:any-tool] ", {
			delay: 20,
		});
		// Dismiss the popover explicitly — even with the trailing space
		// the listbox can persist for a beat. Escape kills it cleanly.
		await page.keyboard.press("Escape");
		await page.waitForTimeout(100);
		await textarea.press("Enter");

		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("data-variant", "success");
		await expect(card).toHaveAttribute("data-kind", "success");
		await expect(card).toContainText("memory-extractor ran successfully");
		await expect(card).toContainText("compaction merged 3 memories");

		// Minimal cards MUST NOT carry a ref-link — that's distiller-specific.
		const link = page.locator("[data-testid='ez-action-card-ref-link']");
		await expect(link).toHaveCount(0);

		// No assistant turn was started — the action-only path returns
		// `runId: null`, so the streaming placeholder was never created.
		const streamingPlaceholder = page.locator(
			'[data-message-id^="streaming-"]',
		);
		await expect(streamingPlaceholder).toHaveCount(0);
	});

	test("manual-typed `![EZ:non-bundled-ext:do-thing]` → error card (extension-not-available envelope)", async ({
		page,
		mockApi,
	}) => {
		const textarea = await gotoEmptyChat(page, mockApi);

		// Mirror the server's "non-bundled extension" branch from
		// api-ez-actions-generic.server.test.ts — the route returns 200
		// with an error CARD (not HTTP 404); the EzActionResult contract
		// is "always render a card so the user sees what happened".
		await page.route(
			`**/api/conversations/${CONV_ID}/messages`,
			async (route) => {
				if (route.request().method() !== "POST") return route.continue();
				const userMsg = makeMessage({
					id: "user-msg-nonbundled",
					conversationId: CONV_ID,
					role: "user",
					content: "![EZ:non-bundled-ext:do-thing]",
				});
				return route.fulfill({
					json: {
						userMessage: userMsg,
						runId: null,
						attachments: [],
						ezActionResults: [
							{
								id: "ez-generic-error-1",
								role: "ez-action-result",
								content: JSON.stringify({
									kind: "error",
									card: {
										title: "non-bundled-ext not available",
										body: "Extension is not bundled with EZCorp; only bundled extensions can be invoked via !EZ.",
										variant: "error",
									},
								}),
							},
						],
					},
				});
			},
		);

		await textarea.focus();
		await textarea.pressSequentially("![EZ:non-bundled-ext:do-thing] ", {
			delay: 20,
		});
		// See note on the success-case test above — trailing space +
		// Escape ensure the popover doesn't swallow the Enter.
		await page.keyboard.press("Escape");
		await page.waitForTimeout(100);
		await textarea.press("Enter");

		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("data-variant", "error");
		await expect(card).toHaveAttribute("data-kind", "error");
		await expect(card).toContainText("non-bundled-ext not available");
		await expect(card).toContainText("only bundled extensions");

		// Error cards also MUST NOT carry a ref-link.
		const link = page.locator("[data-testid='ez-action-card-ref-link']");
		await expect(link).toHaveCount(0);
	});

	test("backward compat: `![EZ:distill]` still renders the distiller-specific lesson card with ref-link", async ({
		page,
		mockApi,
	}) => {
		// This test relies on the default api-mocks.ts messages POST
		// behavior for `distill` (lines ~580-595) — it synthesizes the
		// success envelope with `ref: {kind: "lesson", slug: "e2e-mock-slug"}`.
		// No per-spec route override needed; this is the regression
		// guarantee that the distiller path didn't get accidentally
		// re-routed through the generic minimal-card mapping.
		const textarea = await gotoEmptyChat(page, mockApi);

		// Use the popover path — that's the canonical UX for the legacy alias.
		await textarea.focus();
		await textarea.pressSequentially("!EZ:dist", { delay: 50 });
		await page.waitForTimeout(350);

		const listbox = page.locator("#mention-listbox");
		await expect(listbox).toBeVisible({ timeout: 5000 });
		await listbox.getByText("!EZ:distill").click();
		await textarea.press("Enter");

		const card = page.locator("[data-testid='ez-action-card']").first();
		await expect(card).toBeVisible({ timeout: 5000 });
		await expect(card).toHaveAttribute("data-variant", "success");
		await expect(card).toHaveAttribute("data-kind", "success");
		// Distiller-specific copy — NOT the generic
		// "<ext> ran successfully" minimal-card title.
		await expect(card).toContainText("Lesson captured");

		// Distiller success carries a ref-link to /memories?tab=lessons.
		const link = page
			.locator("[data-testid='ez-action-card-ref-link']")
			.first();
		await expect(link).toBeVisible({ timeout: 5000 });
		await expect(link).toHaveAttribute("data-ref-kind", "lesson");
		await expect(link).toHaveAttribute("data-ref-slug", "e2e-mock-slug");
	});
});
