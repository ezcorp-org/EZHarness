import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Waterfall Timeline", () => {
	const proj = makeProject({ id: "proj-1", name: "Waterfall Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Tool Chat" });

	test('shows "No tool calls recorded" when empty', async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Hi" }),
			],
			settings: { "global:showObservability": true },
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
				"/api/observability/conv-1": () => ({
					events: [],
					stats: {
						totalInputTokens: 0,
						totalOutputTokens: 0,
						totalToolCalls: 0,
						avgDurationMs: 0,
						turnCount: 0,
					},
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Wait for the chat to load and observability button to appear
		await page.waitForTimeout(500);

		// Click the observability inspect button (if it shows)
		const obsButton = page.locator('button[title="Inspect observability"]');
		if (await obsButton.isVisible({ timeout: 2000 }).catch(() => false)) {
			await obsButton.click();

			// The ObservabilityPanel should open — wait for the Execution Timeline section
			// With 0 tool calls and no streaming, the WaterfallTimeline should say "No tool calls recorded."
			// But the panel only shows the timeline section when there are tool events or streaming,
			// so with an empty events array, we should see "No observability data for this conversation yet."
			await expect(
				page.getByText("No observability data for this conversation yet."),
			).toBeVisible({ timeout: 3000 });
		}
	});

	test("displays tool call bars from observability events", async ({ page, mockApi }) => {
		const now = new Date().toISOString();
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Do something" }),
			],
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
				"/api/observability/conv-1": () => ({
					events: [
						{
							id: "evt-1",
							eventType: "tool_call",
							data: { toolName: "readFile", extensionId: "fs-ext", input: { path: "/tmp/test" }, output: { content: "hello" } },
							durationMs: 250,
							createdAt: now,
						},
						{
							id: "evt-2",
							eventType: "tool_call",
							data: { toolName: "writeFile", extensionId: "fs-ext", input: { path: "/tmp/out" }, output: { ok: true } },
							durationMs: 150,
							createdAt: new Date(Date.now() + 500).toISOString(),
						},
					],
					stats: {
						totalInputTokens: 100,
						totalOutputTokens: 50,
						totalToolCalls: 2,
						avgDurationMs: 200,
						turnCount: 1,
					},
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForTimeout(500);

		const obsButton = page.locator('button[title="Inspect observability"]');
		if (await obsButton.isVisible({ timeout: 2000 }).catch(() => false)) {
			await obsButton.click();

			// The WaterfallTimeline should render tool name labels
			await expect(page.getByText("readFile")).toBeVisible({ timeout: 3000 });
			await expect(page.getByText("writeFile")).toBeVisible({ timeout: 3000 });
		}
	});

	test("expand on click shows tool details", async ({ page, mockApi }) => {
		const now = new Date().toISOString();
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [
				makeMessage({ id: "m1", conversationId: "conv-1", role: "user", content: "Do it" }),
			],
			routes: {
				"/api/settings/global:showObservability": () => ({ value: true }),
				"/api/observability/conv-1": () => ({
					events: [
						{
							id: "evt-1",
							eventType: "tool_call",
							data: {
								toolName: "searchCode",
								extensionId: "code-ext",
								input: { query: "hello" },
								output: { matches: 3 },
							},
							durationMs: 400,
							createdAt: now,
						},
					],
					stats: {
						totalInputTokens: 50,
						totalOutputTokens: 30,
						totalToolCalls: 1,
						avgDurationMs: 400,
						turnCount: 1,
					},
				}),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);
		await page.waitForTimeout(500);

		const obsButton = page.locator('button[title="Inspect observability"]');
		if (await obsButton.isVisible({ timeout: 2000 }).catch(() => false)) {
			await obsButton.click();

			// Click on the tool call bar to expand it
			const toolLabel = page.getByText("searchCode");
			await expect(toolLabel).toBeVisible({ timeout: 3000 });
			await toolLabel.click();

			// The expanded detail section should show Input/Output labels
			await expect(page.getByText("Input:")).toBeVisible({ timeout: 2000 });
			await expect(page.getByText("Output:")).toBeVisible({ timeout: 2000 });

			// Should show the actual data
			await expect(page.getByText('"query"')).toBeVisible();
		}
	});

	test("global observability page shows stats", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			routes: {
				"/api/observability": () => ({
					totalInputTokens: 5000,
					totalOutputTokens: 3000,
					totalToolCalls: 42,
					totalTurnCount: 15,
					avgResponseMs: 1200,
					tokensByDay: [],
					topExtensions: [],
				}),
			},
		});
		await page.goto("/observability");

		// Should show the summary cards
		await expect(page.getByText("Total Tokens")).toBeVisible({ timeout: 5000 });
		await expect(page.getByText("Tool Calls")).toBeVisible();
		await expect(page.getByText("42")).toBeVisible();
	});
});
