import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

/**
 * E2E coverage for the "click a per-call row in the context-usage
 * popover → scroll to that tool card in the chat" feature.
 *
 * Builds on the existing chat-context-indicator.spec.ts pattern:
 *   - mocks /api/models so the indicator has a contextWindow,
 *   - seeds an assistant message with `usage.inputTokens` so the
 *     indicator pill renders,
 *   - uses `messageToolCalls` so the conversation's
 *     `withToolCalls=true` GET hands back persisted tool calls — these
 *     get hydrated through `inlineToolStore.hydrateToolCalls`, fed into
 *     `computeToolBreakdown`, and surfaced as click targets in the
 *     popover.
 *
 * The contract under test is the round trip: a click on a
 * `[data-testid="ctx-bd-call-row"][data-call-id="<id>"]` button
 * scrolls `#tool-call-<id>` into view and dismisses the popover.
 */

const proj = makeProject({ id: "proj-jump", name: "Jump To Tool Call" });

async function stubModels(page: import("@playwright/test").Page) {
	await page.route("**/api/models", (route) => {
		const url = new URL(route.request().url());
		if (url.pathname !== "/api/models") return route.fallback();
		return route.fulfill({
			json: [
				{
					provider: "anthropic",
					model: "claude-sonnet-4-20250514",
					tier: "balanced",
					costTier: "medium",
					displayName: "Claude Sonnet 4",
					available: true,
					contextWindow: 200_000,
				},
			],
		});
	});
}

/**
 * Inject enough vertical filler above the assistant message that the
 * tool card sits well below the viewport on initial load. Without this
 * the card is already visible and `scrollIntoView` is a no-op — we
 * couldn't observe whether the click did anything.
 */
function makeFillerMessages(convId: string, count: number) {
	return Array.from({ length: count }, (_, i) =>
		makeMessage({
			id: `filler-${i}`,
			conversationId: convId,
			role: i % 2 === 0 ? "user" : "assistant",
			content: `Filler message ${i} — ${"x".repeat(180)}`,
			parentMessageId: i === 0 ? null : `filler-${i - 1}`,
			createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
		}),
	);
}

test.describe("Chat — jump to tool call from context popover", () => {
	test("clicking a per-call row scrolls the matching tool card into view and closes the popover", async ({ page, mockApi }) => {
		const conv = makeConversation({
			id: "conv-jump-1",
			projectId: proj.id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});

		// 12 fillers push the assistant turn (and its tool card) below the
		// fold on a typical viewport.
		const filler = makeFillerMessages(conv.id, 12);
		const userMsg = makeMessage({
			id: "user-final",
			conversationId: conv.id,
			role: "user",
			content: "run a quick check",
			parentMessageId: "filler-11",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		// Assistant message MUST report usage so the context-usage pill renders.
		const assistantMsg = makeMessage({
			id: "assistant-final",
			conversationId: conv.id,
			role: "assistant",
			content: "ran your check — see tool output below",
			parentMessageId: "user-final",
			usage: { inputTokens: 50_000, outputTokens: 200 },
			createdAt: "2026-01-01T00:01:01.000Z",
		});

		// One inline tool call attached to the assistant message. The
		// conversation's `withToolCalls=true` GET hands this back; the chat
		// page hydrates it into `inlineToolStore` keyed by `id`. That same
		// id flows through `computeToolBreakdown → ToolCallBreakdownItem.callId`
		// and lands as `data-call-id="tc-jump-1"` on the popover row, while
		// `ChatMessage.svelte` wraps the rendered card in `#tool-call-tc-jump-1`.
		const toolCallId = "tc-jump-1";
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [...filler, userMsg, assistantMsg],
			messageToolCalls: {
				[assistantMsg.id]: [
					{
						id: toolCallId,
						extensionId: "builtin",
						toolName: "Bash",
						input: { command: "ls -la" },
						outputSummary: "total 8\ndrwxr-xr-x  2 user user 4096 .",
						fullOutput: "total 8\ndrwxr-xr-x  2 user user 4096 .",
						success: true,
						durationMs: 42,
						status: "success",
						messageId: assistantMsg.id,
					},
				],
			},
		});
		await stubModels(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		// Pill present + correct.
		await expect(page.getByTestId("context-usage-indicator")).toBeVisible({ timeout: 10_000 });
		await expect(page.getByTestId("context-usage-pct")).toHaveText("25%");

		// Confirm the tool-call DOM anchor exists (proves ChatMessage wired
		// the `id="tool-call-${tc.id}"` wrapper around the rendered card).
		const card = page.locator(`#tool-call-${toolCallId}`);
		await expect(card).toHaveCount(1);

		// Open the popover (hover the indicator), then expand the Bash row.
		await page.getByTestId("context-usage-indicator").hover();
		await expect(page.getByTestId("context-usage-popover")).toBeVisible({ timeout: 5_000 });
		await page.getByTestId("ctx-bd-tool-row").click();

		// The per-call row carries the same id we seeded — proves
		// computeToolBreakdown plumbed `tc.id` through to `callId`.
		const callRow = page.locator(`[data-testid="ctx-bd-call-row"][data-call-id="${toolCallId}"]`);
		await expect(callRow).toBeVisible();
		// Should render as a button (clickable), not a plain div.
		await expect(callRow).toHaveJSProperty("tagName", "BUTTON");

		await callRow.click();

		// Three observable signals that the helper ran end-to-end:
		//   1. Popover dismissed so the scroll target isn't covered.
		//   2. The tool-card anchor is in the viewport.
		//   3. The transient ring-2 highlight has been applied.
		//
		// We deliberately skip a "card moved by N px" assertion: the chat
		// already auto-scrolls to the bottom on load, so the card may
		// already sit in the viewport. The ring + visibility checks are
		// what prove `scrollToToolCall` was actually invoked.
		await expect(page.getByTestId("context-usage-popover")).toHaveCount(0);
		await expect(card).toBeInViewport();
		await expect(card).toHaveClass(/ring-2/);
	});

	test("clicking a row whose anchor is missing is a graceful no-op (popover still closes)", async ({ page, mockApi }) => {
		// The popover lists every call from the breakdown; if a call's
		// anchor isn't currently mounted (e.g., older message outside the
		// loaded pagination window), the click must NOT throw and the
		// popover must still close so the user gets feedback.
		//
		// We synthesize this state by adding a click handler that
		// intercepts the row click and rewrites `data-call-id` to a
		// non-existent id BEFORE the indicator's onclick fires. That
		// drives the `getElementById(...) → null` branch of the helper
		// without needing to mock pagination.
		const conv = makeConversation({
			id: "conv-jump-2",
			projectId: proj.id,
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
		});
		const userMsg = makeMessage({
			id: "u",
			conversationId: conv.id,
			role: "user",
			content: "go",
			createdAt: "2026-01-01T00:01:00.000Z",
		});
		const assistantMsg = makeMessage({
			id: "a",
			conversationId: conv.id,
			role: "assistant",
			content: "done",
			parentMessageId: "u",
			usage: { inputTokens: 50_000, outputTokens: 200 },
			createdAt: "2026-01-01T00:01:01.000Z",
		});
		const toolCallId = "tc-present";
		await mockApi({
			projects: [proj],
			conversations: [conv],
			messages: [userMsg, assistantMsg],
			messageToolCalls: {
				[assistantMsg.id]: [
					{
						id: toolCallId,
						extensionId: "builtin",
						toolName: "Bash",
						input: { command: "echo hi" },
						outputSummary: "hi",
						fullOutput: "hi",
						success: true,
						durationMs: 5,
						status: "success",
						messageId: assistantMsg.id,
					},
				],
			},
		});
		await stubModels(page);
		await page.goto(`/project/${proj.id}/chat/${conv.id}`);

		await expect(page.getByTestId("context-usage-indicator")).toBeVisible({ timeout: 10_000 });

		// Remove the anchor from the DOM so the click resolves to "missing".
		await page.evaluate((id) => {
			document.getElementById(`tool-call-${id}`)?.remove();
		}, toolCallId);

		await page.getByTestId("context-usage-indicator").hover();
		await page.getByTestId("ctx-bd-tool-row").click();
		const callRow = page.locator(`[data-testid="ctx-bd-call-row"][data-call-id="${toolCallId}"]`);
		await expect(callRow).toBeVisible();

		// Listen for any uncaught exception during the click — a regression
		// in `scrollToToolCall` (e.g. `el.scrollIntoView(...)` on null) would
		// surface here.
		const pageErrors: Error[] = [];
		page.on("pageerror", (err) => pageErrors.push(err));

		await callRow.click();

		// Popover dismissed (so the user knows their click registered) and
		// no exceptions thrown.
		await expect(page.getByTestId("context-usage-popover")).toHaveCount(0);
		expect(pageErrors).toEqual([]);
	});
});
