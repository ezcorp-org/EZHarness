/**
 * Code review panel — visual evidence.
 *
 * A frontend-visual change (`DiffSummaryPanel.svelte` plus the new
 * `components/review/*` cards and the `github-review.css` skin), so the
 * feature contract requires an `@evidence`-tagged spec that calls
 * `captureEvidence`. See `web/e2e/evidence-covers.json` for the source globs
 * these captures cover.
 *
 * Four shots, one per thing a reviewer needs to eyeball on the GitHub clone:
 *   1. The full review at 75% width — toolbar, file tree, GitHub file cards.
 *   2. Unified (single-column) mode, the other diff layout.
 *   3. Mid-review state — one file ticked Viewed (collapsed + progress moved)
 *      and the filter box applied.
 *   4. Dark mode, because the Primer diff palette has its own dark tokens.
 *
 * Every test asserts before it captures: a screenshot of a broken render is
 * worse than no screenshot.
 */

import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-rev", name: "Review Evidence" });
const conv = makeConversation({ id: "conv-rev", projectId: "proj-rev", title: "Review Chat" });

const REVIEW_DIFFS = `Refactored the auth path and the db helper:

\`\`\`diff
--- a/src/lib/auth.ts
+++ b/src/lib/auth.ts
@@ -10,6 +10,9 @@ import { createHash } from "node:crypto";
 export function login(user: string) {
-  return false;
+  const token = generateToken(user);
+  setSession(token);
+  return true;
 }
\`\`\`

\`\`\`diff
--- a/src/lib/db.ts
+++ b/src/lib/db.ts
@@ -1,4 +1,4 @@
-const POOL_SIZE = 4;
+const POOL_SIZE = 16;
 export const pool = createPool(POOL_SIZE);
\`\`\`

\`\`\`diff
--- a/web/routes/login.svelte
+++ b/web/routes/login.svelte
@@ -1,2 +1,4 @@
 <script lang="ts">
+  import { login } from "$lib/auth";
+  let error = $state("");
 </script>
\`\`\``;

function seed() {
	return [
		makeMessage({
			id: "rm1",
			conversationId: conv.id,
			role: "user",
			content: "Fix the login flow",
		}),
		makeMessage({
			id: "rm2",
			conversationId: conv.id,
			role: "assistant",
			content: REVIEW_DIFFS,
			parentMessageId: "rm1",
			createdAt: "2026-01-01T00:01:00.000Z",
		}),
	];
}

async function openReview(page: import("@playwright/test").Page) {
	await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
	// Gate on a hydrated composer: the diff button ships in the SSR markup and
	// is clickable before its handler attaches, so an early click is a no-op.
	await expect(page.locator("textarea").first()).toBeEnabled({ timeout: 15_000 });
	const panel = page.locator('[data-testid="diff-summary-panel"]');
	if (!(await panel.isVisible())) {
		await page.locator('[data-testid="diff-panel-btn"]').click();
		await expect(panel).toBeVisible({ timeout: 5000 });
		// Reload so the panel comes back from its persisted open-state. Opening
		// by click leaves the pointer parked on the chat header's diff button,
		// whose hover tooltip then floats over the review for as long as the
		// drawer covers it — noise the evidence should not carry.
		await page.reload({ waitUntil: "networkidle" });
	}
	await expect(panel).toBeVisible({ timeout: 5000 });
	await expect(page.getByTestId("diff-file-card")).toHaveCount(3);
	return panel;
}

test.describe("Code review panel visual evidence", () => {
	test("split review at 75% width with the file tree @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seed() });
		const panel = await openReview(page);

		// Assert the GitHub shape before shooting it.
		await expect(panel.locator("h2")).toHaveText("Files changed");
		await expect(page.getByTestId("diff-review-count")).toHaveText("3");
		await expect(page.getByTestId("diff-file-tree")).toBeVisible();
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).toBeVisible({
			timeout: 3000,
		});
		const box = (await panel.boundingBox())!;
		expect(box.width).toBeCloseTo(page.viewportSize()!.width * 0.75, -1);

		await captureEvidence(page, testInfo, "code-review-split");
	});

	test("unified single-column review @evidence", async ({ page, mockApi }, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seed() });
		await openReview(page);

		await page.getByTestId("diff-view-toggle").getByRole("button", { name: "Unified" }).click();
		await expect(page.locator(".diff-panel-content .d2h-file-side-diff").first()).not.toBeVisible();
		await expect(page.locator(".diff-panel-content .d2h-wrapper").first()).toBeVisible();

		await captureEvidence(page, testInfo, "code-review-unified");
	});

	test("mid-review: a file ticked Viewed and the filter applied @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seed() });
		await openReview(page);

		await page.getByTestId("diff-viewed-checkbox").first().check();
		await expect(page.getByTestId("diff-file-card").first()).toHaveAttribute("data-viewed", "true");
		await expect(page.getByTestId("diff-viewed-progress")).toContainText("1 / 3 files viewed");

		await page.getByTestId("diff-file-filter").fill("src/lib");
		await expect(page.getByTestId("diff-file-card")).toHaveCount(2);

		await captureEvidence(page, testInfo, "code-review-viewed-and-filtered");
	});

	test("dark-mode review uses the Primer dark diff palette @evidence", async ({
		page,
		mockApi,
	}, testInfo) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seed() });
		await page.addInitScript(() => localStorage.setItem("theme", "dark"));
		await openReview(page);
		await page.evaluate(() => document.documentElement.classList.add("dark"));

		const added = page.locator(".diff-panel-content .d2h-ins").first();
		await expect(added).toBeVisible({ timeout: 3000 });
		const bg = await added.evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(bg).toContain("rgba(46, 160, 67");

		await captureEvidence(page, testInfo, "code-review-dark");
	});
});
