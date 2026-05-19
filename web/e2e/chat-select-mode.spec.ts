import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Chat Select Mode → New Chat", () => {
	const proj = makeProject({ id: "proj-sm-1", name: "Select Mode Project" });
	const conv = makeConversation({ id: "conv-sm-1", projectId: "proj-sm-1", title: "Original" });

	function seedTurns() {
		const m1 = makeMessage({
			id: "msg-sm-1",
			conversationId: "conv-sm-1",
			role: "user",
			content: "First user question",
			createdAt: "2026-04-01T00:00:00.000Z",
		});
		const m2 = makeMessage({
			id: "msg-sm-2",
			conversationId: "conv-sm-1",
			role: "assistant",
			content: "First assistant answer",
			parentMessageId: "msg-sm-1",
			createdAt: "2026-04-01T00:01:00.000Z",
		});
		const m3 = makeMessage({
			id: "msg-sm-3",
			conversationId: "conv-sm-1",
			role: "user",
			content: "Second user question",
			parentMessageId: "msg-sm-2",
			createdAt: "2026-04-01T00:02:00.000Z",
		});
		const m4 = makeMessage({
			id: "msg-sm-4",
			conversationId: "conv-sm-1",
			role: "assistant",
			content: "Second assistant answer",
			parentMessageId: "msg-sm-3",
			createdAt: "2026-04-01T00:03:00.000Z",
		});
		return [m1, m2, m3, m4];
	}

	test("Select toggle enters and exits select mode cleanly", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("First user question")).toBeVisible();

		// Enter select mode — composer should be replaced by the action bar.
		await page.getByTestId("select-mode-toggle").click();
		await expect(page.getByTestId("select-action-bar")).toBeVisible();
		await expect(page.getByTestId("selected-count")).toHaveText("0");
		await expect(page.getByTestId("new-chat-from-selection")).toBeDisabled();

		// Cancel exits select mode without side effects — composer returns.
		await page.getByRole("button", { name: "Cancel" }).click();
		await expect(page.getByTestId("select-action-bar")).toHaveCount(0);
	});

	test("Clicking messages toggles selection and updates the counter", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await expect(page.getByTestId("selected-count")).toHaveText("0");

		// Tick first turn — counter becomes 1, button enabled.
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await expect(page.getByTestId("selected-count")).toHaveText("1");
		await expect(page.getByTestId("new-chat-from-selection")).toBeEnabled();

		// Tick third turn — counter becomes 2.
		await page.getByTestId("select-checkbox-msg-sm-3").click();
		await expect(page.getByTestId("selected-count")).toHaveText("2");

		// Untick first — counter drops back to 1.
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await expect(page.getByTestId("selected-count")).toHaveText("1");
	});

	test("New Chat button forks selected turns into a new conversation", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		// Select user+assistant pair (2 turns).
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await page.getByTestId("select-checkbox-msg-sm-2").click();

		await page.getByTestId("new-chat-from-selection").click();

		// Navigates to the new conversation URL (mock returns id "cloned-conv").
		await page.waitForURL(/\/chat\/cloned-conv$/);

		// Seeded turns render in the new chat, in the original order.
		await expect(page.getByText("First user question")).toBeVisible();
		await expect(page.getByText("First assistant answer")).toBeVisible();
		// Turns NOT selected must NOT appear in the new chat.
		await expect(page.getByText("Second user question")).toHaveCount(0);
		await expect(page.getByText("Second assistant answer")).toHaveCount(0);
	});

	test("System messages are not selectable", async ({ page, mockApi }) => {
		const systemMsg = makeMessage({
			id: "msg-sys",
			conversationId: "conv-sm-1",
			role: "system",
			content: "System notice",
			createdAt: "2026-04-01T00:00:30.000Z",
		});
		await mockApi({ projects: [proj], conversations: [conv], messages: [...seedTurns(), systemMsg] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();

		// Non-system turns get a checkbox.
		await expect(page.getByTestId("select-checkbox-msg-sm-1")).toBeVisible();
		// System turn does not.
		await expect(page.getByTestId("select-checkbox-msg-sys")).toHaveCount(0);
	});

	test("Inline edit on seeded assistant turn updates content via PATCH (no regen)", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Fork with an assistant turn in the selection.
		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await page.getByTestId("select-checkbox-msg-sm-2").click();
		await page.getByTestId("new-chat-from-selection").click();
		await page.waitForURL(/\/chat\/cloned-conv$/);

		// The seeded assistant turn has a new id in the clone — grab the
		// cloned-msg-2 (i.e. second in the ordered clone).
		const assistantTurn = page.getByText("First assistant answer").locator("xpath=ancestor::*[starts-with(@data-testid, 'edit-text-form-') or @role='checkbox' or (self::div and .//button)]").first();
		// Hover to reveal the toolbar, then click the "Edit text" button.
		await assistantTurn.hover();
		await page.getByTestId("edit-text-btn").first().click();

		// Edit the content and save.
		const textarea = page.getByTestId(/^edit-text-form-/).locator("textarea");
		await textarea.fill("Revised assistant answer");
		await page.getByTestId("edit-text-save").click();

		// New content shows up; old does not.
		await expect(page.getByText("Revised assistant answer")).toBeVisible();
		await expect(page.getByText("First assistant answer")).toHaveCount(0);
	});

	test("Select toggle is disabled while a streaming turn is in flight", async ({ page, mockApi, emitWs }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: [] });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Baseline: toggle is enabled with no streaming.
		await expect(page.getByTestId("select-mode-toggle")).toBeEnabled();

		// Kick off a send — the mock POST response returns `runId: "run-stream"`,
		// which the chat page latches onto as `activeRunId`.
		const textarea = page.locator("textarea").first();
		await textarea.fill("Tell me a joke");
		await page.getByRole("button", { name: "Send message" }).click();
		// Wait until the user message is rendered, so we know the send resolved
		// before we fire WS tokens against the run id.
		await expect(page.getByText("Tell me a joke")).toBeVisible({ timeout: 5000 });
		// Token tick populates `store.streamingMessages[runId]`, flipping
		// `isStreaming` true and the toggle disabled.
		await emitWs({ type: "run:token", data: { runId: "run-stream", token: "Hi " } });

		await expect(page.getByTestId("select-mode-toggle")).toBeDisabled({ timeout: 5000 });
		// The custom Tooltip component renders its text into a separate
		// fixed-position div on hover (with a 300ms delay) — there's no
		// native `title` attribute. Hover the button and wait for the
		// guard message to appear, covering the user-facing affordance
		// in addition to the disabled attribute.
		await page.getByTestId("select-mode-toggle").hover();
		await expect(
			page.getByText("Finish streaming turn before selecting"),
		).toBeVisible({ timeout: 2000 });
	});

	test("Tool-call card survives the clone and renders in the new chat", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: seedTurns(),
			messageToolCalls: {
				"msg-sm-2": [
					{
						id: "tc-orig-1",
						extensionId: "ext-test",
						toolName: "read_file_special_marker",
						input: { path: "README.md" },
						outputSummary: "ok",
						success: true,
						durationMs: 12,
						status: "success",
						messageId: "msg-sm-2",
					},
				],
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Source conv renders the tool card.
		await expect(page.getByText("read_file_special_marker").first()).toBeVisible();

		// Fork user + assistant pair (tool call is anchored on msg-sm-2).
		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await page.getByTestId("select-checkbox-msg-sm-2").click();
		await page.getByTestId("new-chat-from-selection").click();
		await page.waitForURL(/\/chat\/cloned-conv$/);

		// Cloned conv still shows the tool card — mock re-parents under the
		// new message id exactly like the real server clone does.
		await expect(page.getByText("read_file_special_marker").first()).toBeVisible();
	});

	test("Inline edit on seeded user turn opens the existing edit textarea", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await page.getByTestId("new-chat-from-selection").click();
		await page.waitForURL(/\/chat\/cloned-conv$/);

		// Hover the seeded user turn, click the (existing) Edit button.
		const userTurn = page.getByText("First user question").locator("xpath=ancestor::div[contains(@class, 'group')]").first();
		await userTurn.hover();
		await page.getByRole("button", { name: "Edit message" }).click();

		// The existing branching-edit textarea appears, pre-filled with the
		// seeded content — lets the user modify before re-sending.
		// `textContent` matching doesn't work for textareas (value isn't DOM
		// text), so assert via `toHaveValue`.
		await expect(page.getByRole("button", { name: "Save & Submit" })).toBeVisible();
		const editTextarea = page.locator("textarea").filter({ has: page.locator(":scope") }).first();
		await expect(editTextarea).toHaveValue("First user question");
	});

	test("Shows an error banner when the clone endpoint fails", async ({ page, mockApi }) => {
		await mockApi({ projects: [proj], conversations: [conv], messages: seedTurns() });
		// Override the clone-turns route with a 500 AFTER mockApi has registered
		// the default handler. Playwright tries the most-recently-added route
		// first, so this takes precedence.
		await page.route("**/api/conversations/*/clone-turns", (route) => {
			route.fulfill({ status: 500, json: { error: "Failed to clone turns" } });
		});

		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await page.getByTestId("select-mode-toggle").click();
		await page.getByTestId("select-checkbox-msg-sm-1").click();
		await page.getByTestId("new-chat-from-selection").click();

		// Stays on the source page; surfaces the error and re-enables the button.
		await expect(page).toHaveURL(new RegExp(`/chat/${conv.id}$`));
		await expect(page.getByRole("alert")).toContainText(/500|fail/i);
		await expect(page.getByTestId("new-chat-from-selection")).toBeEnabled();
	});
});
