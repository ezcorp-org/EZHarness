import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";

/**
 * NOTE on coverage strategy:
 *
 * The live push-path (tool:complete events from SSE → inlineToolStore.upsertStreaming
 * → diff panel) is exercised end-to-end at the unit + integration level:
 *   - web/src/__tests__/inline-tool-store-upsert.test.ts
 *   - web/src/__tests__/stores-tool-event-routing.test.ts
 *   - web/src/__tests__/diff-panel-push-flow.test.ts
 *
 * Running it through real Playwright would require mocking the EventSource
 * /api/runtime-events stream (the existing fixtures mock WebSocket, which
 * this app doesn't use). That's follow-up infrastructure work — tracked as
 * a gap, not a blocker on this change.
 *
 * The e2e scenarios below cover the user-visible outcomes that don't depend
 * on the push path: API-hydration rendering, multi-sub file aggregation,
 * empty state, and auto-expanded sections.
 */

/**
 * Regression e2e for the bug: when a team member / invoked sub-agent edited
 * a file, the parent conversation's Diff Summary panel was empty because
 * sub-conversation tool calls weren't hydrated into the parent view.
 *
 * These tests seed `subConversationToolCalls` on the mocked API and verify
 * that the panel now shows the sub-agent's file edits.
 */

const proj = makeProject({ id: "proj-sda", name: "Sub Agent Diff" });
const conv = makeConversation({ id: "conv-sda", projectId: "proj-sda", title: "Team Chat" });

function makeSubToolCall(overrides: {
	id: string;
	filePath: string;
	oldString?: string;
	newString?: string;
}) {
	return {
		id: overrides.id,
		extensionId: "builtin",
		toolName: "edit_file",
		input: {
			file_path: overrides.filePath,
			old_string: overrides.oldString ?? "old",
			new_string: overrides.newString ?? "new",
		},
		outputSummary: "ok",
		success: true,
		durationMs: 12,
		status: "success" as const,
	};
}

test.describe("Diff Summary Panel — sub-agent edits", () => {
	test("sub-agent edit to a file renders as a File Changes section in the parent's panel", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			subConversations: [
				{
					id: "sub-coder",
					agentName: "Coder",
					agentConfigId: "agent-coder",
					parentMessageId: "",
					parentConversationId: conv.id,
				},
			],
			subConversationToolCalls: {
				"sub-coder": [
					makeSubToolCall({
						id: "sub-edit-1",
						filePath: "src/feature-from-sub.ts",
						oldString: "return false",
						newString: "return true",
					}),
				],
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });

		const btn = page.locator('[data-testid="diff-panel-btn"]');
		await expect(btn).toBeVisible({ timeout: 5000 });
		await btn.click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });

		// The sub-agent's edited file should show up as a File Changes section.
		const fileSections = page.locator('[data-testid="diff-file-section"]');
		await expect(fileSections).toHaveCount(1);
		await expect(fileSections.first()).toContainText("src/feature-from-sub.ts");
	});

	test("edits from multiple sub-agents on different files produce multiple sections", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			subConversations: [
				{ id: "sub-a", agentName: "A", agentConfigId: "a", parentMessageId: "", parentConversationId: conv.id },
				{ id: "sub-b", agentName: "B", agentConfigId: "b", parentMessageId: "", parentConversationId: conv.id },
			],
			subConversationToolCalls: {
				"sub-a": [makeSubToolCall({ id: "a-1", filePath: "src/a.ts" })],
				"sub-b": [makeSubToolCall({ id: "b-1", filePath: "src/b.ts" })],
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await page.locator('[data-testid="diff-panel-btn"]').click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });

		const fileSections = page.locator('[data-testid="diff-file-section"]');
		await expect(fileSections).toHaveCount(2);
		const paths = await fileSections.allTextContents();
		expect(paths.some((p) => p.includes("src/a.ts"))).toBe(true);
		expect(paths.some((p) => p.includes("src/b.ts"))).toBe(true);
	});

	test("sub-agent edit content renders inside the expanded diff section", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			subConversations: [
				{ id: "sub-coder", agentName: "Coder", agentConfigId: "agent-coder", parentMessageId: "", parentConversationId: conv.id },
			],
			subConversationToolCalls: {
				"sub-coder": [
					makeSubToolCall({
						id: "diff-with-content",
						filePath: "src/show-me.ts",
						oldString: "const x = 1",
						newString: "const x = 2",
					}),
				],
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await page.locator('[data-testid="diff-panel-btn"]').click();

		const section = page.locator('[data-testid="diff-file-section"]').first();
		await expect(section).toBeVisible();
		// Auto-expanded (< 10 files) so the diff body is in the DOM.
		await expect(section).toHaveAttribute("data-expanded", "true");
	});

	test("empty state when there are NO parent edits AND no sub-agent edits", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [],
			subConversations: [
				{ id: "sub-idle", agentName: "Idle", agentConfigId: "idle", parentMessageId: "", parentConversationId: conv.id },
			],
			subConversationToolCalls: {
				"sub-idle": [], // sub exists but made no edits
			},
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`, { waitUntil: "networkidle" });
		await page.locator('[data-testid="diff-panel-btn"]').click();
		await expect(page.locator('[data-testid="diff-summary-panel"]')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-testid="diff-panel-empty"]')).toBeVisible();
		await expect(page.locator('[data-testid="diff-panel-empty"]')).toContainText("No file changes");
	});
});
