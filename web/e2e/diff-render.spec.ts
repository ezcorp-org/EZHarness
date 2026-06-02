import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const DIFF_CONTENT = `Here is the diff for the changes:

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
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,3 @@
 export const PORT = 3000;
+export const SECRET = "abc123";
\`\`\`

That should fix the login issue.`;

const AUTO_DETECT_CONTENT = `Check this out:

\`\`\`
--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
-const old = true;
+const updated = true;
\`\`\``;

test.describe("Diff Rendering", () => {
	const proj = makeProject({ id: "proj-1", name: "Diff Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Diff Chat" });

	test("diff block renders in chat with toggle and file headers", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show me the diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Diff container should render
		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });
		// Toggle button should exist
		await expect(page.locator(".diff-toggle-btn")).toBeVisible();
		// File headers with stats should be visible
		await expect(page.locator(".diff-file-toggle").first()).toBeVisible();
		await expect(page.locator(".diff-additions").first()).toBeVisible();
		await expect(page.locator(".diff-deletions").first()).toBeVisible();
	});

	test("view toggle switches between side-by-side and unified", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const container = page.locator(".diff-container");
		await expect(container).toBeVisible({ timeout: 5000 });

		// Initially side-by-side
		await expect(container).toHaveAttribute("data-view", "side-by-side");

		// Click toggle
		await page.locator(".diff-toggle-btn").click();
		await expect(container).toHaveAttribute("data-view", "unified");
		await expect(page.locator(".diff-toggle-btn")).toHaveText("Side-by-side");

		// Click again to toggle back
		await page.locator(".diff-toggle-btn").click();
		await expect(container).toHaveAttribute("data-view", "side-by-side");
		await expect(page.locator(".diff-toggle-btn")).toHaveText("Unified");
	});

	test("view mode persists across reload (global preference)", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const container = page.locator(".diff-container");
		await expect(container).toBeVisible({ timeout: 5000 });
		await expect(container).toHaveAttribute("data-view", "side-by-side");

		// Switch to unified, then reload — the choice must survive the refresh.
		await page.locator(".diff-toggle-btn").click();
		await expect(container).toHaveAttribute("data-view", "unified");

		await page.reload();
		const reloaded = page.locator(".diff-container");
		await expect(reloaded).toBeVisible({ timeout: 5000 });
		await expect(reloaded).toHaveAttribute("data-view", "unified");
		await expect(page.locator(".diff-toggle-btn")).toHaveText("Side-by-side");
	});

	test("file collapse works for multi-file diff", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });

		const sections = page.locator(".diff-file-section");
		// First file expanded, second collapsed
		await expect(sections.nth(0)).toHaveAttribute("data-expanded", "true");
		await expect(sections.nth(1)).toHaveAttribute("data-expanded", "false");

		// Click second file header to expand
		await page.locator(".diff-file-toggle").nth(1).click();
		await expect(sections.nth(1)).toHaveAttribute("data-expanded", "true");
	});

	test("auto-detected diff renders as diff container", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Check this" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: AUTO_DETECT_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Should render as diff-container, not plain code block
		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".diff-toggle-btn")).toBeVisible();
	});

	test("diff alongside regular code block renders both correctly", async ({ page, mockApi }) => {
		const mixedContent = `Here is some code:

\`\`\`js
const x = 1;
\`\`\`

And here is the diff:

${DIFF_CONTENT}`;

		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show both" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: mixedContent,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".code-block-wrapper")).toBeVisible();
	});

	test("multiple diff blocks in one message render independently", async ({ page, mockApi }) => {
		const twoDiffs = `First change:

\`\`\`diff
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
\`\`\`

Second change:

\`\`\`diff
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,2 +1,2 @@
-const b = 1;
+const b = 2;
\`\`\``;

		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Two diffs" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: twoDiffs,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const containers = page.locator(".diff-container");
		await expect(containers.first()).toBeVisible({ timeout: 5000 });
		await expect(containers).toHaveCount(2);

		// Toggle first diff, second should stay unchanged
		await page.locator(".diff-toggle-btn").first().click();
		await expect(containers.first()).toHaveAttribute("data-view", "unified");
		await expect(containers.nth(1)).toHaveAttribute("data-view", "side-by-side");
	});

	test("file stats show addition and deletion counts", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });
		// First file (auth.ts): +3 -1
		await expect(page.locator(".diff-additions").first()).toHaveText("+3");
		await expect(page.locator(".diff-deletions").first()).toHaveText("-1");
	});

	test("collapse first file (initially expanded) then re-expand", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });

		const firstSection = page.locator(".diff-file-section").nth(0);
		await expect(firstSection).toHaveAttribute("data-expanded", "true");

		// Collapse
		await page.locator(".diff-file-toggle").first().click();
		await expect(firstSection).toHaveAttribute("data-expanded", "false");

		// Re-expand
		await page.locator(".diff-file-toggle").first().click();
		await expect(firstSection).toHaveAttribute("data-expanded", "true");
	});

	test("toggle view multiple times settles to correct state", async ({ page, mockApi }) => {
		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Show diff" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: DIFF_CONTENT,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const container = page.locator(".diff-container");
		await expect(container).toBeVisible({ timeout: 5000 });

		const btn = page.locator(".diff-toggle-btn");
		// Click 3 times (odd = unified)
		await btn.click();
		await btn.click();
		await btn.click();
		await expect(container).toHaveAttribute("data-view", "unified");
		await expect(btn).toHaveText("Side-by-side");
	});

	test("new file diff shows correct filename and stats", async ({ page, mockApi }) => {
		const newFileContent = `Here is the new file:

\`\`\`diff
--- /dev/null
+++ b/src/brand-new.ts
@@ -0,0 +1,3 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
\`\`\``;

		const userMsg = makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "New file" });
		const assistantMsg = makeMessage({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: newFileContent,
			parentMessageId: "m1",
			createdAt: "2026-01-01T00:01:00.000Z",
		});

		await mockApi({ projects: [proj], conversations: [conv], messages: [userMsg, assistantMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.locator(".diff-container")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(".diff-file-toggle").first()).toContainText("brand-new.ts");
		await expect(page.locator(".diff-additions").first()).toHaveText("+3");
		await expect(page.locator(".diff-deletions").first()).toHaveText("-0");
	});
});
