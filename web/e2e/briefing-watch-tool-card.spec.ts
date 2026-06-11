/**
 * Daily Briefing Phase 3 e2e — the briefing_watch / briefing_unwatch
 * chat-tool confirmation card, viewed from the chat UI (spec §5.5:
 * every conversational watchlist write confirms in-chat).
 *
 * Pure render-path spec (no Docker): the chat page runs against
 * mockApi; the tool events are pushed over SSE with `emitSse` (NOT
 * `emitWs` — runtime events flow over /api/runtime-events; mirrors
 * substack-review-card.spec.ts). The tools carry no custom cardType,
 * so the result renders through ToolCallCard's default path: a
 * collapsed header showing the tool name, expanding to the plain-text
 * confirmation the tool returned. The tool's actual write behavior is
 * covered by the bun PGlite suite (briefing-chat-tools.test.ts).
 */

import { test, expect } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const proj = makeProject({ id: "proj-bw", name: "Briefing Watch Project" });
const conv = makeConversation({
	id: "conv-bw",
	projectId: "proj-bw",
	title: "Normal chat",
});

// Seed a settled user→assistant turn so the chat view renders WITHOUT a
// backend (mirrors the no-Docker tool-card siblings).
const userMsg = makeMessage({
	id: "m1",
	conversationId: conv.id,
	role: "user",
	content: "keep an eye on the Bun 2.0 release for me",
});
const assistantMsg = makeMessage({
	id: "m2",
	conversationId: conv.id,
	role: "assistant",
	content: "Will do.",
	parentMessageId: "m1",
	createdAt: "2026-01-01T00:01:00.000Z",
});

const WATCH_CONFIRMATION =
	'Added "Bun 2.0 release" to your briefing watchlist — manage it in Settings → Briefing.';
const UNWATCH_CONFIRMATION =
	'Removed "Bun 2.0 release" from your briefing watchlist — manage it in Settings → Briefing.';

/** Navigate, send a message (establishing the streaming run the live
 *  tool-card push path needs), then stream one tool call over SSE. */
async function streamToolCall(
	page: import("@playwright/test").Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	emitSse: (e: { type: string; data: unknown }) => Promise<void>,
	opts: { toolName: string; input: Record<string, unknown>; output: string },
) {
	await mockApi({
		projects: [proj],
		conversations: [conv],
		messages: [userMsg, assistantMsg],
	});

	await page.goto(`/project/${proj.id}/chat/${conv.id}`);

	// Gate on a hydrated composer before driving it (see
	// substack-review-card.spec.ts — kills the slow-hydration flake).
	const textarea = page.locator("textarea").first();
	await expect(textarea).toBeEnabled({ timeout: 15_000 });
	await textarea.fill("keep an eye on the Bun 2.0 release for me");
	await Promise.all([
		page.waitForResponse(
			(r) => r.url().includes("/messages") && r.request().method() === "POST",
			{ timeout: 15_000 },
		),
		textarea.press("Enter"),
	]);

	const invocationId = `inv-${opts.toolName}`;
	await emitSse({
		type: "tool:start",
		data: {
			conversationId: conv.id,
			toolName: opts.toolName,
			invocationId,
			input: opts.input,
			timestamp: Date.now(),
			// No cardType — host tools render through the default card.
		},
	});
	await emitSse({
		type: "tool:complete",
		data: {
			conversationId: conv.id,
			toolName: opts.toolName,
			invocationId,
			output: opts.output,
			duration: 40,
			success: true,
		},
	});
}

test.describe("briefing chat-tool confirmation card", () => {
	test("briefing_watch renders a card with the in-chat confirmation text", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await streamToolCall(page, mockApi, emitSse, {
			toolName: "briefing_watch",
			input: { topic: "Bun 2.0 release" },
			output: WATCH_CONFIRMATION,
		});

		// Collapsed header identifies the tool call.
		const toolName = page.getByText("briefing_watch").first();
		await expect(toolName).toBeVisible();

		// The header is the expand button — expanding reveals the
		// confirmation the user is promised by spec §5.5.
		const headerBtn = toolName.locator("xpath=ancestor::button[1]");
		await expect(headerBtn).toBeVisible();
		await headerBtn.click();

		await expect(page.getByText(/Added "Bun 2\.0 release" to your briefing watchlist/)).toBeVisible();
		await expect(page.getByText(/manage it in Settings → Briefing/).first()).toBeVisible();
	});

	test("briefing_unwatch renders its removal confirmation the same way", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await streamToolCall(page, mockApi, emitSse, {
			toolName: "briefing_unwatch",
			input: { topic: "Bun 2.0 release" },
			output: UNWATCH_CONFIRMATION,
		});

		const toolName = page.getByText("briefing_unwatch").first();
		await expect(toolName).toBeVisible();
		await toolName.locator("xpath=ancestor::button[1]").click();
		await expect(
			page.getByText(/Removed "Bun 2\.0 release" from your briefing watchlist/),
		).toBeVisible();
	});

	test("briefing_status renders the multi-line status readout", async ({
		page,
		mockApi,
		emitSse,
	}) => {
		await streamToolCall(page, mockApi, emitSse, {
			toolName: "briefing_status",
			input: {},
			output: [
				"Daily briefing is enabled — Weekdays at 07:00, timezone Europe/Berlin.",
				"Last run: delivered at 2026-06-11T07:00:00.000Z.",
				"Next run: 2026-06-12T07:00:00.000Z.",
				'Watchlist: "Bun 2.0 release".',
				'Recent briefings: "Daily Briefing — Thu, Jun 11" (2026-06-11).',
			].join("\n"),
		});

		const toolName = page.getByText("briefing_status").first();
		await expect(toolName).toBeVisible();
		await toolName.locator("xpath=ancestor::button[1]").click();
		await expect(page.getByText(/Daily briefing is enabled — Weekdays at 07:00/)).toBeVisible();
		await expect(page.getByText(/Recent briefings: "Daily Briefing — Thu, Jun 11"/)).toBeVisible();
	});
});
