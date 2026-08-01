import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";
import type { Page } from "@playwright/test";

/**
 * Code review panel (GitHub "Files changed" clone) — browser-level behaviour.
 *
 * The panel used to be a narrow "Diff Summary" drawer with two separate lists;
 * it is now one GitHub-shaped review surface at 75% of the viewport with a
 * file tree, sticky file headers, Viewed checkboxes and a filter box. These
 * specs pin the user-visible contract of that surface: geometry, the merged
 * file list, expand/collapse, filtering, viewed progress + persistence, and
 * the split/unified preference.
 */

const DIFF_CONTENT = `Here is the diff:

\`\`\`diff
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,3 +10,5 @@
 export function login(user: string) {
-  return false;
+  const token = generateToken(user);
+  setSession(token);
+  return true;
 }
\`\`\`

That should fix the login issue.`;

const MULTI_DIFF_CONTENT = `Two changes:

\`\`\`diff
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1 +1 @@
-old auth
+new auth
\`\`\`

And another:

\`\`\`diff
--- a/web/db.ts
+++ b/web/db.ts
@@ -1 +1 @@
-old db
+new db
\`\`\``;

const proj = makeProject({ id: "proj-dp", name: "Diff Panel Project" });
const conv = makeConversation({ id: "conv-dp", projectId: "proj-dp", title: "Diff Panel Chat" });

function assistantWith(content: string) {
	return [
		makeMessage({ id: "m1", conversationId: "conv-dp", role: "user", content: "Show diff" }),
		makeMessage({
			id: "m2",
			conversationId: "conv-dp",
			role: "assistant",
			content,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		}),
	];
}

/**
 * Open the review panel and return its locator.
 *
 * Gates on a hydrated composer first: the diff button ships in the SSR markup
 * and is clickable long before its handler is attached, so an early click is a
 * silent no-op (same slow-hydration flake `briefing-watch-tool-card.spec.ts`
 * guards against). The panel's open-state also persists per conversation, so
 * only click when it isn't already showing.
 */
async function openReviewPanel(page: Page) {
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 15_000 });
	const btn = page.locator('[data-testid="diff-panel-btn"]');
	await expect(btn).toBeVisible({ timeout: 5000 });
	const panel = page.locator('[data-testid="diff-summary-panel"]');
	if (!(await panel.isVisible())) await btn.click();
	await expect(panel).toBeVisible({ timeout: 5000 });
	return panel;
}

test.describe("Code review panel", () => {
	test("panel toggle: click opens panel, close dismisses it", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const panel = await openReviewPanel(page);
		await page.locator('[data-testid="diff-panel-close"]').click();
		await expect(panel).not.toBeVisible();
	});

	test("panel toggle: backdrop dismisses panel", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const panel = await openReviewPanel(page);
		// Click the EXPOSED strip of backdrop on the left. The backdrop spans the
		// whole overlay (`inset-0`), so a default centre-point click lands on the
		// panel sitting on top of it (75vw, right-anchored) — which stops
		// propagation and leaves the panel open, exactly as a user clicking
		// inside the panel expects.
		await page.getByTestId("swipe-drawer-backdrop").click({ position: { x: 8, y: 8 } });
		await expect(panel).not.toBeVisible();
	});

	test("panel spans 75% of the viewport, right-anchored and full height", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const panel = await openReviewPanel(page);
		const viewport = page.viewportSize()!;
		// The drawer slides in over 300ms — poll until the right edge settles
		// against the viewport rather than measuring mid-animation.
		await expect
			.poll(async () => {
				const b = (await panel.boundingBox())!;
				return Math.round(b.x + b.width);
			})
			.toBe(viewport.width);

		const box = (await panel.boundingBox())!;
		expect(box.width).toBeCloseTo(viewport.width * 0.75, -1);
		expect(box.y).toBe(0);
		expect(box.height).toBe(viewport.height);
	});

	test("header reads 'Files changed' with the count and +/- totals", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const panel = await openReviewPanel(page);
		await expect(panel.locator("h2")).toHaveText("Files changed");
		await expect(page.getByTestId("diff-review-count")).toHaveText("2");
		await expect(page.getByTestId("diff-review-totals")).toContainText("+2");
		await expect(page.getByTestId("diff-review-totals")).toContainText("−2");
	});

	test("empty state: shows message when no diffs exist", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-panel-empty")).toBeVisible();
		await expect(page.getByTestId("diff-panel-empty")).toContainText("No file changes");
		// Nothing to review means no tree and a disabled bulk toggle.
		await expect(page.getByTestId("diff-file-tree")).toHaveCount(0);
		await expect(page.getByTestId("diff-toggle-all")).toBeDisabled();
	});

	test("one file card per changed file, showing the path", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const cards = page.getByTestId("diff-file-card");
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toHaveAttribute("data-path", "src/auth.ts");
		await expect(cards.first()).toContainText("src/auth.ts");
	});

	test("multiple diffs render multiple cards", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-file-card")).toHaveCount(2);
	});

	test("files open expanded and the chevron collapses one", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const card = page.getByTestId("diff-file-card").first();
		await expect(card).toHaveAttribute("data-expanded", "true");

		await page.getByTestId("diff-file-toggle").first().click();
		await expect(card).toHaveAttribute("data-expanded", "false");
		await expect(page.getByTestId("diff-file-body")).toHaveCount(0);
	});

	test("Collapse all / Expand all drives every card at once", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const cards = page.getByTestId("diff-file-card");
		await expect(cards).toHaveCount(2);

		await page.getByTestId("diff-toggle-all").click();
		await expect(cards.nth(0)).toHaveAttribute("data-expanded", "false");
		await expect(cards.nth(1)).toHaveAttribute("data-expanded", "false");
		await expect(page.getByTestId("diff-toggle-all")).toHaveText("Expand all");

		await page.getByTestId("diff-toggle-all").click();
		await expect(cards.nth(0)).toHaveAttribute("data-expanded", "true");
	});

	test("file tree lists the changed files and collapses a directory", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-file-tree")).toBeVisible();

		const dirs = page.getByTestId("review-tree-dir");
		await expect(dirs).toHaveCount(2);
		await expect(page.getByTestId("review-tree-file")).toHaveCount(2);

		await dirs.first().click();
		await expect(page.getByTestId("review-tree-file")).toHaveCount(1);
	});

	test("the file tree rail hides and comes back", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await page.getByTestId("diff-tree-hide").click();
		await expect(page.getByTestId("diff-file-tree")).toHaveCount(0);

		await page.getByTestId("diff-tree-show").click();
		await expect(page.getByTestId("diff-file-tree")).toBeVisible();
	});

	test("filter narrows the file list and the count follows it", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await page.getByTestId("diff-file-filter").fill("auth");

		await expect(page.getByTestId("diff-file-card")).toHaveCount(1);
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute(
			"data-path",
			"src/auth.ts",
		);
		await expect(page.getByTestId("diff-review-count")).toHaveText("1");
	});

	test("a filter matching nothing offers a Clear filter escape hatch", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await page.getByTestId("diff-file-filter").fill("no-such-file");

		await expect(page.getByTestId("diff-filter-empty")).toBeVisible();
		// The real empty state stays reserved for "no changes at all".
		await expect(page.getByTestId("diff-panel-empty")).toHaveCount(0);

		await page.getByTestId("diff-filter-empty").getByRole("button", { name: "Clear filter" }).click();
		await expect(page.getByTestId("diff-file-card")).toHaveCount(1);
	});

	test("Viewed collapses the file, advances progress, and survives a reload", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-viewed-progress")).toContainText("0 / 1 files viewed");

		await page.getByTestId("diff-viewed-checkbox").first().check();
		const card = page.getByTestId("diff-file-card").first();
		await expect(card).toHaveAttribute("data-viewed", "true");
		await expect(card).toHaveAttribute("data-expanded", "false");
		await expect(page.getByTestId("diff-viewed-progress")).toContainText("1 / 1 files viewed");

		await page.reload({ waitUntil: "networkidle" });
		await openReviewPanel(page);
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute("data-viewed", "true");
	});

	test("un-ticking Viewed re-opens the file", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const checkbox = page.getByTestId("diff-viewed-checkbox").first();
		await checkbox.check();
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute("data-viewed", "true");

		await checkbox.uncheck();
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute(
			"data-expanded",
			"true",
		);
	});

	test("user messages are ignored, only assistant diffs are reviewed", async ({ page, mockApi }) => {
		const userMsg = makeMessage({
			id: "m1",
			conversationId: "conv-dp",
			role: "user",
			content: "```diff\n--- a/user.ts\n+++ b/user.ts\n@@ -1 +1 @@\n-a\n+b\n```",
		});
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-dp",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-file-card")).toHaveCount(1);
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute(
			"data-path",
			"src/auth.ts",
		);
	});

	test("a diff with no filename falls back to the unnamed placeholder", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith("```diff\n@@ -1 +1 @@\n-old\n+new\n```"),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute(
			"data-path",
			"unnamed diff",
		);
	});

	test("file headers stick to the top of the diff column while scrolling", async ({
		page,
		mockApi,
	}) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: assistantWith(MULTI_DIFF_CONTENT),
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const header = page.getByTestId("diff-file-header").first();
		await expect(header).toBeVisible();
		const position = await header.evaluate((el) => getComputedStyle(el).position);
		expect(position).toBe("sticky");
	});

	test("diff rows use GitHub's add/delete tints", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);

		// Body cell of an added row (the line-number cell also carries .d2h-ins
		// but gets the stronger gutter tint).
		const addedBody = page
			.locator(".diff-panel-content td.d2h-ins:not(.d2h-code-side-linenumber)")
			.first();
		await expect(addedBody).toBeVisible({ timeout: 3000 });
		const bodyBg = await addedBody.evaluate((el) => getComputedStyle(el).backgroundColor);
		// Primer light `#e6ffec`; the dark theme uses the same hue at 15% alpha.
		expect(bodyBg).toMatch(/rgba?\(230, 255, 236|rgba\(46, 160, 67/);

		const gutter = page.locator(".diff-panel-content td.d2h-code-side-linenumber.d2h-ins").first();
		const gutterBg = await gutter.evaluate((el) => getComputedStyle(el).backgroundColor);
		// Primer light `#ccffd8`; dark is the same hue at 30% alpha.
		expect(gutterBg).toMatch(/rgba?\(204, 255, 216|rgba\(46, 160, 67/);

		const removed = page
			.locator(".diff-panel-content td.d2h-del:not(.d2h-code-side-linenumber)")
			.first();
		const removedBg = await removed.evaluate((el) => getComputedStyle(el).backgroundColor);
		// Primer light `#ffebe9`; dark is `rgba(248, 81, 73, .15)`.
		expect(removedBg).toMatch(/rgba?\(255, 235, 233|rgba\(248, 81, 73/);
	});

	test("view toggle: Split and Unified are both offered, Split is the default", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const toggle = page.getByTestId("diff-view-toggle");
		await expect(toggle).toContainText("Split");
		await expect(toggle).toContainText("Unified");
		await expect(toggle.getByRole("button", { name: "Split" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).toBeVisible({
			timeout: 3000,
		});
	});

	test("view toggle: Unified switches to one column and back to Split", async ({
		page,
		mockApi,
	}) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).toBeVisible({
			timeout: 3000,
		});

		await page.getByTestId("diff-view-toggle").getByRole("button", { name: "Unified" }).click();
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).not.toBeVisible();
		await expect(page.locator(".diff-panel-content .d2h-wrapper").first()).toBeVisible();

		await page.getByTestId("diff-view-toggle").getByRole("button", { name: "Split" }).click();
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).toBeVisible({
			timeout: 3000,
		});
	});

	test("view toggle: Unified choice persists across reload", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: assistantWith(DIFF_CONTENT) });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		await page.getByTestId("diff-view-toggle").getByRole("button", { name: "Unified" }).click();
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).not.toBeVisible();

		await page.reload({ waitUntil: "networkidle" });
		await openReviewPanel(page);
		await expect(page.locator(".diff-panel-content .d2h-wrapper").first()).toBeVisible({
			timeout: 3000,
		});
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).not.toBeVisible();
	});

	test("diff badge is hidden when no file changes exist", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await expect(page.locator('[data-testid="diff-panel-btn"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="diff-badge"]')).toHaveCount(0);
	});

	test("diff panel button reports the panel's open state", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const btn = page.locator('[data-testid="diff-panel-btn"]');
		await expect(btn).toBeVisible({ timeout: 5000 });
		const before = (await btn.getAttribute("class")) ?? "";
		expect(before).toContain("relative");

		await openReviewPanel(page);
		const after = (await btn.getAttribute("class")) ?? "";
		expect(after.length).toBeGreaterThan(before.length);
	});

	test("every settled assistant diff is reviewable", async ({ page, mockApi }) => {
		const msgs = [
			makeMessage({ id: "m1", conversationId: "conv-dp", role: "user", content: "First" }),
			makeMessage({
				id: "m2",
				conversationId: "conv-dp",
				role: "assistant",
				content: DIFF_CONTENT,
				parentMessageId: "m1",
				createdAt: "2026-01-01T00:01:00.000Z",
			}),
			makeMessage({
				id: "m3",
				conversationId: "conv-dp",
				role: "user",
				content: "Second",
				parentMessageId: "m2",
				createdAt: "2026-01-01T00:02:00.000Z",
			}),
			makeMessage({
				id: "m4",
				conversationId: "conv-dp",
				role: "assistant",
				content: MULTI_DIFF_CONTENT,
				parentMessageId: "m3",
				createdAt: "2026-01-01T00:03:00.000Z",
			}),
		];

		await mockApi({ projects: [proj], conversations: [conv], messages: msgs });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		// Not streaming, so nothing is held back: 1 diff from m2 + 2 from m4.
		await expect(page.getByTestId("diff-file-card")).toHaveCount(3);
		await expect(page.getByTestId("diff-review-count")).toHaveText("3");
	});

	test("backdrop covers full viewport behind panel", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		await openReviewPanel(page);
		const backdrop = page.getByTestId("swipe-drawer-backdrop");
		await expect(backdrop).toBeVisible({ timeout: 5000 });

		const box = (await backdrop.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(box.x).toBe(0);
		expect(box.y).toBe(0);
		expect(box.width).toBe(viewport.width);
		expect(box.height).toBe(viewport.height);
	});

	test("no raw tool name leaks into the review surface", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const panel = await openReviewPanel(page);
		const panelText = await panel.textContent();
		expect(panelText).not.toContain("editFile");
	});
});
