import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

test.describe("Tool Call History Display", () => {
	const proj = makeProject({ id: "proj-1", name: "Tool Call Project" });
	const conv = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Tool Chat" });

	const userMsg = makeMessage({
		id: "m1",
		conversationId: "conv-1",
		role: "user",
		content: "Check the weather",
	});

	const assistantMsg = makeMessage({
		id: "m2",
		conversationId: "conv-1",
		role: "assistant",
		content: "Here is the forecast.",
		parentMessageId: "m1",
		createdAt: "2026-01-01T00:01:00.000Z",
	});

	const toolCallSuccess = {
		id: "tc-1",
		extensionId: "ext-weather",
		extensionName: "weather",
		toolName: "get_forecast",
		input: { location: "NYC" },
		outputSummary: "Sunny, 72F",
		output: "Sunny, 72F -- clear skies all day",
		success: true,
		durationMs: 450,
		status: "success" as const,
		createdAt: "2026-01-01T00:00:30.000Z",
	};

	const toolCallError = {
		id: "tc-2",
		extensionId: "ext-weather",
		extensionName: "weather",
		toolName: "get_alerts",
		input: {},
		outputSummary: null,
		output: null,
		success: false,
		durationMs: 120,
		status: "error" as const,
		error: "API timeout",
		createdAt: "2026-01-01T00:00:35.000Z",
	};

	const toolCallInterrupted = {
		id: "tc-3",
		extensionId: "ext-weather",
		extensionName: "weather",
		toolName: "get_radar",
		input: {},
		outputSummary: null,
		output: null,
		success: false,
		durationMs: 0,
		status: "interrupted" as const,
		createdAt: "2026-01-01T00:00:40.000Z",
	};

	const toolCallViaAgent = {
		id: "tc-4",
		extensionId: "ext-weather",
		extensionName: "weather",
		toolName: "get_humidity",
		input: {},
		outputSummary: "65%",
		output: "Humidity: 65%",
		success: true,
		durationMs: 200,
		status: "success" as const,
		createdAt: "2026-01-01T00:00:45.000Z",
	};

	function withToolCallsResponse(toolCalls: unknown[], subConversations: Array<Record<string, unknown>> = [], orphaned = false) {
		return (url: URL) => url.searchParams.get("withToolCalls") === "true" ? {
			messages: [userMsg, { ...assistantMsg, toolCalls: orphaned ? [] : toolCalls }],
			subConversations: subConversations.map((conversation) => ({
				parentMessageId: userMsg.id,
				parentConversationId: conv.id,
				...conversation,
			})),
			orphanedToolCalls: orphaned ? toolCalls : [],
			subConversationToolCalls: {},
		} : [userMsg, assistantMsg];
	}

	test("page loads with historical tool calls showing correct status icons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([
					toolCallSuccess,
					toolCallError,
					toolCallInterrupted,
				]),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByText("Check the weather")).toBeVisible();
		await expect(page.getByText("Here is the forecast.")).toBeVisible();

		// Success tool card: green checkmark and tool name visible
		const successCard = page.locator("div.rounded-md.border").filter({ hasText: "get_forecast" });
		await expect(successCard).toBeVisible({ timeout: 5000 });
		// Green check SVG present
		await expect(successCard.locator("svg.text-green-500")).toBeVisible();

		// Error tool card: red X
		const errorCard = page.locator("div.rounded-md.border").filter({ hasText: "get_alerts" });
		await expect(errorCard).toBeVisible();
		await expect(errorCard.locator("svg.text-red-500")).toBeVisible();

		// Interrupted assistant tool remains a failed execution.
		const interruptedCard = page.locator("div.rounded-md.border").filter({ hasText: "get_radar" });
		await expect(interruptedCard).toBeVisible();
		await expect(interruptedCard.locator("svg.text-red-500")).toBeVisible();
	});

	test("expanding historical tool card fetches full output", async ({ page, mockApi }) => {
		let outputFetched = false;

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([toolCallSuccess]),
				"/api/tool-calls/tc-1/output": () => {
					outputFetched = true;
					return { output: "Full detailed forecast: Sunny, 72F, wind NW 5mph, humidity 45%" };
				},
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const toolCard = page.locator("div.rounded-md.border").filter({ hasText: "get_forecast" });
		await expect(toolCard).toBeVisible({ timeout: 5000 });

		// Click to expand
		await toolCard.locator("button").first().click();

		// Verify output content appears
		await expect(toolCard.locator("pre").filter({ hasText: "Full detailed forecast" })).toBeVisible();
		expect(outputFetched).toBe(true);
	});

	test("interrupted tool cards show gray with no action buttons", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([toolCallInterrupted], [], true),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const interruptedCard = page.locator("div.rounded-md.border").filter({ hasText: "get_radar" });
		await expect(interruptedCard).toBeVisible({ timeout: 5000 });
		await expect(interruptedCard.getByText("Interrupted")).toBeVisible();

		// No retry or edit buttons
		await expect(interruptedCard.getByRole("button", { name: /retry/i })).not.toBeVisible();
		await expect(interruptedCard.getByRole("button", { name: /edit/i })).not.toBeVisible();
	});

	test("historical agent tool stays attached to its assistant turn", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([toolCallViaAgent]),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const toolCard = page.locator("div.rounded-md.border").filter({ hasText: "get_humidity" });
		await expect(toolCard).toBeVisible({ timeout: 5000 });
		await expect(page.locator('[data-message-id="m2"]').getByText("get_humidity", { exact: true })).toBeVisible();
		await expect(page.locator('[data-message-id="m1"]').getByText("get_humidity", { exact: true })).toHaveCount(0);
	});

	test("historical agent chip shows completed status and result preview", async ({ page, mockApi }) => {
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([], [
					{
						id: "sub-1",
						agentName: "researcher",
						agentConfigId: "cfg-1",
						messageCount: 5,
						lastMessagePreview: "Found 3 results...",
					},
				]),
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const chip = page.getByTestId("agent-chip");
		await expect(chip).toContainText("@researcher");
		await expect(chip).toContainText("Found 3 results...");
		await expect(chip.locator(".agent-chip-complete")).toBeVisible();
	});

	test("expanding sub-conversation fetches messages", async ({ page, mockApi }) => {
		const subMessages = [
			{ id: "sm-1", role: "user", content: "Search for articles", createdAt: "2026-01-01T00:00:30.000Z" },
			{ id: "sm-2", role: "assistant", content: "Found 3 relevant articles about AI.", createdAt: "2026-01-01T00:00:35.000Z" },
		];

		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			routes: {
				"active-run": () => ({ runId: null }),
				"/api/conversations/conv-1/messages": withToolCallsResponse([], [
					{
						id: "sub-1",
						agentName: "researcher",
						agentConfigId: "cfg-1",
						messageCount: 2,
						lastMessagePreview: "Found 3 relevant articles...",
					},
				]),
				"/api/conversations/sub-1/messages": () => subMessages,
			},
		});
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/conversations/sub-1/messages");
		await page.getByTestId("agent-chip").click();
		expect((await response).status()).toBe(200);

		// Verify messages render after expansion
		await expect(page.getByText("Found 3 relevant articles about AI.")).toBeVisible({ timeout: 5000 });
	});
});
