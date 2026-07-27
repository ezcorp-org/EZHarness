import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import { makeProject, makeConversation } from "./fixtures/data.js";
import { openChatWithTasks } from "./fixtures/task-seed.js";

/**
 * @evidence — the task panel's "work on this task" affordance.
 *
 * A PENDING task row is clickable: TaskPanel builds
 * `Work on task: **<title>**\n\n<description>` and hands it to
 * `onsendmessage`, which the chat route wires to
 * `ChatThreadChrome.sendMessage` → the thread's own `handleSend`. The user
 * sees the turn appear in the thread, exactly as if they had typed it.
 *
 * The sibling assertion in `task-panel.spec.ts` proves the POST body; this
 * one exists for the VISIBLE outcome — the rendered turn — and screenshots
 * it, because the wiring lives in `ChatThread.svelte` and a change there has
 * to land with a browser-level shot behind it.
 */

const proj = makeProject({ id: "proj-click", name: "Task Click Project" });
const conv = makeConversation({
	id: "conv-click",
	projectId: "proj-click",
	title: "Task Click Convo",
});

function pendingTaskSnapshot() {
	return {
		conversationId: "conv-click",
		tasks: [
			{
				id: "t1",
				title: "Refactor billing",
				description: "Clean up the billing module",
				status: "pending" as const,
				priority: 0,
				subtasks: [],
				assignments: [],
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

test.describe("@evidence task-panel pending-task click", () => {
	test("clicking a pending task sends the turn and it renders in the thread", async ({
		page,
		mockApi,
	}, testInfo) => {
		await openChatWithTasks(page, mockApi, {
			project: proj,
			conversation: conv,
			snapshot: pendingTaskSnapshot(),
		});

		// Only pending tasks are clickable, so the row is a button.
		const taskButton = page.getByRole("button", { name: /Refactor billing/ });
		await expect(taskButton).toBeVisible();

		// Nothing has been sent yet — the description text lives ONLY in the
		// message TaskPanel builds, never in the panel row itself, so its
		// absence here is a real "no turn yet" assertion.
		await expect(page.getByText("Clean up the billing module")).toHaveCount(0);

		await captureEvidence(page, testInfo, "task-panel-pending-task-before-click");

		await taskButton.click();

		// The turn lands in the thread, carrying the whole message TaskPanel
		// built. Scoped to the message paragraph so the conversation-list
		// preview in the sidebar (same text, truncated) can't satisfy this.
		// User turns render verbatim, so the `**` markdown markers are literal.
		const sentTurn = page.locator("p", { hasText: "Work on task:" });
		await expect(sentTurn).toHaveText(
			"Work on task: **Refactor billing** Clean up the billing module",
		);

		await captureEvidence(page, testInfo, "task-panel-work-on-task-turn-in-thread");
	});
});
