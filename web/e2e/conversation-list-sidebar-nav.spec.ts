import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeSearchHit } from "./fixtures/data.js";
import { expectReadable, expectWarningTinted, useLightTheme } from "./fixtures/readable.js";

/**
 * Read-page excerpt fix — sidebar landmark.
 *
 * `read_page`'s content excerpt (`serializePageContext` /
 * `collectContentText` in `web/src/lib/ez/page-context.ts`) walks `<main>`
 * and skips chrome via `CONTENT_SKIP_SELECTOR`, which already excludes
 * `<nav>`. The ConversationList sidebar used to render as a plain `<div>`
 * inside `<main>` on chat routes, so its conversation titles ate into the
 * excerpt budget before the LLM ever reached the user's latest message —
 * on a long thread, the final assistant reply could be cut off entirely.
 * The fix renders the sidebar as `<nav aria-label="Conversations">`, which
 * the selector already excludes.
 *
 * This spec is the behavioral/visual-evidence half of that fix: it asserts
 * the sidebar is a real `<nav>` landmark with its accessible name. The
 * content-windowing behavior itself (head+tail excerpt, detail-aware caps)
 * is covered by `web/src/lib/ez/__tests__/page-context.unit.test.ts`.
 */
test.describe("Conversation list sidebar — nav landmark", () => {
	const proj = makeProject({ id: "proj-nav" });
	const conv = makeConversation({ id: "conv-active", projectId: "proj-nav", title: "Active chat" });
	const other = makeConversation({ id: "conv-other", projectId: "proj-nav", title: "Another conversation" });

	test("renders as a <nav> landmark with an accessible name, not a plain chrome div @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({
			projects: [proj],
			conversations: [conv, other],
			messages: [
				makeMessage({ id: "u1", conversationId: conv.id, role: "user", content: "what's on the roadmap?" }),
				makeMessage({
					id: "a1",
					conversationId: conv.id,
					role: "assistant",
					content: "Preorders open next week.",
					parentMessageId: "u1",
				}),
			],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// The desktop sidebar renders unconditionally; the mobile one lives in
		// a closed-by-default SwipeDrawer, opened via the header's hamburger
		// button. Same <ConversationList> component either way — this just
		// gets it on screen so the landmark assertion below applies to both.
		if (testInfo.project.name === "mobile-chromium") {
			await page.getByRole("button", { name: "Open conversations" }).click();
		}

		// Behavioral assertion: the sidebar is a real <nav> landmark with the
		// accessible name CONTENT_SKIP_SELECTOR keys off of — a plain <div>
		// (the pre-fix shape) would not be findable via this role query.
		const sidebar = page.getByRole("navigation", { name: "Conversations" });
		await expect(sidebar).toBeVisible();
		await expect(sidebar.getByText("Active chat")).toBeVisible();
		await expect(sidebar.getByText("Another conversation")).toBeVisible();

		await captureEvidence(page, testInfo, "conversation-list-sidebar-nav");
	});

	/**
	 * Delete-confirm dialog — modal a11y attributes.
	 *
	 * `DeleteConfirmDialog.svelte` (opened from this sidebar's per-row
	 * "Delete" action) renders a backdrop + Escape handler +
	 * backdrop-click-to-close, i.e. a real modal, but was missing
	 * `role="dialog"` / `aria-modal="true"` — a screen-reader user got no
	 * signal that focus had moved into a modal that traps interaction,
	 * unlike every sibling dialog (FlagDialog, PublishDialog,
	 * ShareAgentDialog, DelegationConsentDialog, ModeFormModal). Fixed by
	 * adding both, plus `aria-labelledby` wired to the dialog's own
	 * heading so its accessible name is "Delete conversation".
	 */
	test("delete-confirm dialog exposes modal a11y attributes and removes the conversation @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		const mobile = testInfo.project.name === "mobile-chromium";

		await mockApi({
			projects: [proj],
			conversations: [conv, other],
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		if (mobile) {
			await page.getByRole("button", { name: "Open conversations" }).click();
		}
		const sidebar = mobile
			? page.getByTestId("swipe-drawer").getByRole("navigation", { name: "Conversations" })
			: page.getByRole("navigation", { name: "Conversations" });
		await expect(sidebar).toBeVisible();
		if (!mobile) await sidebar.getByText("Active chat").hover();
		const deleteButton = sidebar.getByTitle("Delete").first();
		if (mobile) {
			// Touch users have no hover state. The row actions must remain on
			// screen and meet the 44 px target after the drawer finishes opening.
			// Polling waits for the drawer's CSS transform, without a fixed delay;
			// a genuine overflow remains red once the transition settles.
			await expect.poll(async () => deleteButton.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return rect.left >= 0 && rect.right <= window.innerWidth;
			})).toBe(true);
			const box = await deleteButton.boundingBox();
			const viewport = page.viewportSize();
			expect(box).not.toBeNull();
			expect(viewport).not.toBeNull();
			// Chromium's device scale can report 44 CSS px as 43.99998.
			expect(box!.width).toBeGreaterThanOrEqual(43.99);
			expect(box!.height).toBeGreaterThanOrEqual(43.99);
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
		}
		await deleteButton.click();

		// Modal semantics: role + aria-modal, accessible name from the
		// dialog's own heading (via aria-labelledby). A generous timeout here:
		// this assertion round-trips through the browser's accessibility tree
		// (role + aria-labelledby-derived name), which on a heavily loaded
		// shared box can lag behind the DOM mutation it reflects.
		const dialog = page.getByRole("dialog", { name: "Delete conversation" });
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog).toHaveAttribute("aria-modal", "true");
		await expect(dialog.getByText(/This can't be undone/)).toBeVisible();

		await captureEvidence(page, testInfo, "conversation-list-delete-confirm-dialog");

		await dialog.getByRole("button", { name: "Delete", exact: true }).click();

		// Confirming removes the conversation from the sidebar; the other
		// conversation is untouched.
		await expect(dialog).not.toBeVisible();
		await expect(sidebar.getByText("Active chat")).not.toBeVisible();
		await expect(sidebar.getByText("Another conversation")).toBeVisible();
	});

	/**
	 * Degraded-search notice — readable on the LIGHT theme.
	 *
	 * This notice used to be `bg-amber-500/10` + `text-amber-300`, a pairing
	 * tuned on a dark surface. `:root` is the LIGHT theme, so by default it
	 * rendered pale amber prose on a near-white tint — the one line telling
	 * the user their results are NOT what they asked for was the least
	 * readable line in the sidebar. It now takes its colour from the theme's
	 * own text token while keeping the warning tint behind it.
	 */
	test("the degraded-search notice is legible on the light theme @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await useLightTheme(page);
		await mockApi({
			projects: [proj],
			conversations: [conv, other],
			searchMessages: {
				degraded: true,
				servedMode: "keyword",
				hits: [
					makeSearchHit({
						conversationId: conv.id,
						conversationTitle: "Active chat",
						messageId: "hit-1",
						snippet: "a <mark>roadmap</mark> match",
					}),
				],
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const mobile = testInfo.project.name === "mobile-chromium";
		if (mobile) {
			await page.getByRole("button", { name: "Open conversations" }).click();
			await expect(page.getByTestId("swipe-drawer")).toBeVisible({ timeout: 3000 });
		}
		// Scope to the VISIBLE ConversationList: both a desktop and a mobile
		// instance are mounted, so an unscoped testid would be ambiguous.
		const sidebar = mobile
			? page.getByTestId("swipe-drawer").locator(".flex.h-full.w-full")
			: page.locator(".flex.h-full.w-full").first();

		await sidebar.locator('[title="Search conversations"]').click();
		await sidebar.locator('input[placeholder="Search..."]').fill("roadmap");

		const notice = sidebar.getByTestId("search-degraded-notice");
		await expect(notice).toBeVisible({ timeout: 3000 });
		await expect(notice).toHaveText(/Semantic search unavailable/);

		// The visual claim, asserted numerically: the notice's prose clears
		// WCAG AA against the surface it is actually composited onto. Before
		// the fix this measured ≈1.4:1.
		const m = await expectReadable(notice, "ConversationList degraded-search notice");
		expect(m.dark, "the regression only shows on light surfaces").toBe(false);
		// ...and it is still visibly a WARNING, not plain body text.
		await expectWarningTinted(notice, "ConversationList degraded-search notice");

		await captureEvidence(page, testInfo, "conversation-list-degraded-notice");
	});
});
