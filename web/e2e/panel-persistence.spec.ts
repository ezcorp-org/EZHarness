/**
 * E2E tests for side-panel state persistence across page refreshes.
 *
 * Verifies the contract documented in panel-persistence.ts: opening a
 * panel writes its state to localStorage; refreshing the page reads
 * that state and reopens the panel automatically.
 *
 * NOTE on storage cleanup: we cannot use `page.addInitScript` to clear
 * localStorage because it also runs on `page.reload()` — wiping our own
 * persisted state right before the assertion that should observe the
 * restore. Instead, each test uses a unique conversationId so prior-run
 * entries do not collide, and clears storage explicitly between phases.
 */
import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

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
`;

test.describe("Panel persistence across page refresh", () => {
	const proj = makeProject({ id: "proj-pp", name: "Persistence Project" });

	test("diff panel: open, refresh → reopens automatically", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-pp-reopen", projectId: proj.id, title: "Persistence Chat" });
		const userMsg = makeMessage({ id: "m1", conversationId: conv.id, role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: conv.id,
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		// Clear any leaked storage from previous tests, then load fresh
		await page.evaluate(() => window.localStorage.clear());
		await page.reload({ waitUntil: "networkidle" });

		// Open the diff panel
		const btn = page.locator('[data-testid="diff-panel-btn"]');
		await expect(btn).toBeVisible({ timeout: 5000 });
		await btn.click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });

		// Verify the panel state was written to localStorage
		const stored = await page.evaluate(
			(id) => window.localStorage.getItem(`ezcorp-panel-chat:${id}`),
			conv.id,
		);
		expect(stored).not.toBeNull();
		const parsed = JSON.parse(stored!);
		expect(parsed.diffPanelOpen).toBe(true);

		// Refresh the page
		await page.reload({ waitUntil: "networkidle" });

		// Diff panel should be visible again automatically
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
	});

	test("diff panel: close, refresh → stays closed", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-pp-closed", projectId: proj.id, title: "Persistence Chat" });
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await page.evaluate(() => window.localStorage.clear());
		await page.reload({ waitUntil: "networkidle" });

		// Open then close
		const btn = page.locator('[data-testid="diff-panel-btn"]');
		await expect(btn).toBeVisible({ timeout: 5000 });
		await btn.click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
		await page.locator('[data-testid="diff-panel-close"]').click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();

		// Verify storage reflects closed state
		const stored = await page.evaluate(
			(id) => window.localStorage.getItem(`ezcorp-panel-chat:${id}`),
			conv.id,
		);
		const parsed = JSON.parse(stored!);
		expect(parsed.diffPanelOpen).toBe(false);

		// Refresh — panel should NOT auto-open
		await page.reload({ waitUntil: "networkidle" });
		await expect(btn).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();
	});

	test("conversation isolation: opening a panel in conv-A does not leak into conv-B", async ({ page, mockApi }) => {
		const projTwo = makeProject({ id: "proj-pp2", name: "Two-conv project" });
		const convA = makeConversation({ id: "conv-pp-A", projectId: projTwo.id, title: "Conversation A" });
		const convB = makeConversation({ id: "conv-pp-B", projectId: projTwo.id, title: "Conversation B" });

		await mockApi({ projects: [projTwo], conversations: [convA, convB], messages: [] });

		// Initial load to clear storage cleanly
		await page.goto(`/project/${projTwo.id}/chat/${convA.id}`, { waitUntil: "networkidle" });
		await page.evaluate(() => window.localStorage.clear());
		await page.reload({ waitUntil: "networkidle" });

		// Open the diff panel on conversation A
		await page.locator('[data-testid="diff-panel-btn"]').click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });

		// Navigate to conversation B
		await page.goto(`/project/${projTwo.id}/chat/${convB.id}`, { waitUntil: "networkidle" });
		await expect(page.locator('[data-testid="diff-panel-btn"]')).toBeVisible({ timeout: 5000 });

		// Diff panel should NOT be visible on conv-B (it's only persisted for conv-A)
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();

		// Verify localStorage has separate keys per conversation
		const keysA = await page.evaluate(() => window.localStorage.getItem("ezcorp-panel-chat:conv-pp-A"));
		const keysB = await page.evaluate(() => window.localStorage.getItem("ezcorp-panel-chat:conv-pp-B"));
		expect(keysA).not.toBeNull();
		expect(JSON.parse(keysA!).diffPanelOpen).toBe(true);
		// conv-B may be null (untouched) OR present with diffPanelOpen=false; both are acceptable.
		if (keysB) {
			expect(JSON.parse(keysB).diffPanelOpen).toBe(false);
		}

		// Refresh on conv-B — diff panel still hidden
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.locator('[data-testid="diff-panel-btn"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();

		// Navigate back to conv-A — diff panel should reopen automatically
		await page.goto(`/project/${projTwo.id}/chat/${convA.id}`, { waitUntil: "networkidle" });
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
	});

	test("corrupt localStorage entry is handled gracefully (no crash, panel closed)", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-pp-corrupt", projectId: proj.id, title: "Corrupt Chat" });
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });

		// Pre-corrupt localStorage. This addInitScript runs on every navigation
		// (including reload), so it stays in effect for the whole test —
		// guaranteeing the corrupt value is present when the page reads storage.
		await page.addInitScript(() => {
			try {
				window.localStorage.setItem("ezcorp-panel-chat:conv-pp-corrupt", "{not-valid-json");
				window.localStorage.setItem("ezcorp-panel-team", "[also not the right shape]");
			} catch { /* ignore */ }
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		// Page should load successfully — diff panel stays closed (default)
		await expect(page.locator('[data-testid="diff-panel-btn"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();
	});

	test("toggle multiple times → final state is what gets persisted", async ({ page, mockApi }) => {
		const conv = makeConversation({ id: "conv-pp-toggle", projectId: proj.id, title: "Toggle Chat" });
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await page.evaluate(() => window.localStorage.clear());
		await page.reload({ waitUntil: "networkidle" });

		const btn = page.locator('[data-testid="diff-panel-btn"]');
		await expect(btn).toBeVisible({ timeout: 5000 });

		// Open
		await btn.click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
		// Close
		await page.locator('[data-testid="diff-panel-close"]').click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).not.toBeVisible();
		// Open again
		await btn.click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });

		// Refresh — panel reopens (final state was open)
		await page.reload({ waitUntil: "networkidle" });
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
	});
});
