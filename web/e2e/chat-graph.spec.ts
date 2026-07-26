/**
 * Chat DAG graph panel — functional coverage (mock tier, blocking gate lane).
 *
 * The headline interaction is the drill-in: level 1 is one node per user
 * prompt, and clicking a prompt node opens THAT turn's trace (level 2 —
 * thinking, each tool call, each sub-agent spawn, the reply). Everything
 * below is asserted against the seeded graph in `fixtures/graph-data.ts`,
 * whose payloads mirror what the real builders emit.
 *
 * Two contract rules get literal assertions because they are the ones that
 * rot silently:
 *   - an ABSENT `durationMs` renders an em dash, never "0ms"
 *     (`src/runtime/chat-graph/types.ts` — built-in tools persist a
 *     hardcoded 0, so a fabricated "0ms" would be a lie);
 *   - `degraded: true` is a quiet NOTICE, not an error state.
 *
 * The panel is read-only by design: nothing here writes, so the session-tree
 * invariant (`parentMessageId` is never mutated) is untouched.
 *
 * NOTE on the request-log assertions: the breadcrumb/heading flip
 * SYNCHRONOUSLY on click, before the fetch is even issued, so every
 * `expect(requested)` below is placed after an assertion on content that can
 * only exist once the response landed.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/test-base.js";
import type { MockOverrides } from "./fixtures/api-mocks.js";
import type { ChatGraph } from "../../src/runtime/chat-graph/types.js";
import {
	CONV_ID,
	DEGRADED_CONV_ID,
	LABEL_BENCH,
	LABEL_PLAN,
	LABEL_REPLY,
	LABEL_ROLLBACK,
	LABEL_SUBAGENT,
	LABEL_SUBAGENT_PROMPT,
	LABEL_THINKING,
	LABEL_TOOL_WITHOUT_DURATION,
	LABEL_TOOL_WITH_DURATION,
	PROJECT_ID,
	PROMPT_BENCH,
	PROMPT_PLAN,
	PROMPT_ROLLBACK,
	REPLY_BENCH,
	SUBCONV_ID,
	TOOL_WITHOUT_DURATION,
	TOOL_WITH_DURATION,
	conversation,
	degradedConversation,
	graphKey,
	level1Degraded,
	messages,
	mockGraphApi,
	project,
} from "./fixtures/graph-data.js";

/** Load the seeded chat with the graph endpoint mocked. Returns the request log. */
async function gotoChat(
	page: Page,
	mockApi: (overrides?: MockOverrides) => Promise<void>,
	opts: { convId?: string; table?: Record<string, ChatGraph> } = {},
): Promise<string[]> {
	await mockApi({
		projects: [project],
		conversations: [conversation, degradedConversation],
		messages,
	});
	// AFTER mockApi so this newer route wins over the `**/api/**` catch-all.
	const requested = await mockGraphApi(page, opts.table);
	await page.goto(`/project/${PROJECT_ID}/chat/${opts.convId ?? CONV_ID}`);
	await page.waitForLoadState("networkidle");
	return requested;
}

/**
 * Click the header button and wait for the drawer to finish sliding in.
 *
 * `toBeVisible()` alone is NOT enough: `SwipeDrawer` mounts the panel at
 * `translateX(100%)` (off-screen but with a non-empty box, so Playwright
 * already calls it visible) and only registers itself in the Esc-handling
 * drawer stack once the entry transition has started. Waiting for the settled
 * transform is the deterministic "the drawer is really open" signal.
 */
async function openPanel(page: Page) {
	await page.getByTestId("chat-graph-btn").click();
	const panel = page.getByTestId("chat-graph-panel");
	await expect(panel).toBeVisible();
	await expect(
		page.locator('[data-testid="swipe-drawer-panel"]:has([data-testid="chat-graph-panel"])'),
	).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
	return panel;
}

test.describe("Chat DAG graph panel", () => {
	test("header button opens the panel and level 1 renders one node per prompt", async ({
		page,
		mockApi,
	}) => {
		const requested = await gotoChat(page, mockApi);

		// Closed until asked for — the drawer must not mount on page load.
		await expect(page.getByTestId("chat-graph-panel")).toHaveCount(0);

		const panel = await openPanel(page);
		await expect(panel.getByRole("heading", { name: "Conversation map" })).toBeVisible();
		await expect(page.getByTestId("chat-graph-canvas")).toBeVisible();

		// Level 1 = the three user prompts, plus the one sub-agent spawn.
		const prompts = panel.locator('[data-testid="chat-graph-node"][data-kind="prompt"]');
		await expect(prompts).toHaveCount(3);
		await expect(panel.locator(`[data-node-id="${PROMPT_PLAN}"]`)).toContainText(LABEL_PLAN);
		await expect(panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`)).toContainText(LABEL_ROLLBACK);
		await expect(panel.locator(`[data-node-id="${PROMPT_BENCH}"]`)).toContainText(LABEL_BENCH);
		await expect(panel.getByTestId("chat-graph-node")).toHaveCount(4);

		// Every prompt is a drill-in target, and it says so to a screen reader.
		for (let i = 0; i < 3; i++) {
			await expect(prompts.nth(i)).toHaveAttribute("data-drillable", "true");
		}
		await expect(panel.locator(`[data-node-id="${PROMPT_BENCH}"]`)).toHaveAttribute(
			"aria-label",
			`Prompt: ${LABEL_BENCH}, succeeded. Opens this turn's trace.`,
		);

		// Level 1 is the bare endpoint — no `?turn=`.
		expect(requested).toEqual([`/api/conversations/${CONV_ID}/graph`]);
		// A level-1 frame is the bottom of the stack, so no breadcrumb yet.
		await expect(panel.getByTestId("chat-graph-breadcrumb")).toHaveCount(0);
	});

	test("clicking a prompt node drills into THAT turn's trace, and the breadcrumb comes back", async ({
		page,
		mockApi,
	}) => {
		const requested = await gotoChat(page, mockApi);
		const panel = await openPanel(page);

		await panel.locator(`[data-node-id="${PROMPT_BENCH}"]`).click();

		// That turn's internals: thinking, both tool calls, the sub-agent, the reply.
		await expect(panel.locator(`[data-node-id="thinking:${REPLY_BENCH}"]`)).toContainText(
			LABEL_THINKING,
		);
		await expect(panel.locator(`[data-node-id="${TOOL_WITH_DURATION}"]`)).toContainText(
			LABEL_TOOL_WITH_DURATION,
		);
		await expect(panel.locator(`[data-node-id="${TOOL_WITHOUT_DURATION}"]`)).toContainText(
			LABEL_TOOL_WITHOUT_DURATION,
		);
		await expect(panel.locator(`[data-node-id="${SUBCONV_ID}"]`)).toContainText(LABEL_SUBAGENT);
		await expect(panel.locator(`[data-node-id="${REPLY_BENCH}"]`)).toContainText(LABEL_REPLY);
		await expect(panel.locator('[data-testid="chat-graph-node"][data-kind="tool"]')).toHaveCount(2);
		await expect(panel.getByTestId("chat-graph-node")).toHaveCount(6);
		await expect(panel.getByRole("heading", { name: "Turn trace" })).toBeVisible();

		// It fetched level 2 for exactly this turn — not just "something changed".
		expect(requested).toEqual([
			`/api/conversations/${CONV_ID}/graph`,
			`/api/conversations/${CONV_ID}/graph?turn=${PROMPT_BENCH}`,
		]);

		// …and NOT the sibling turn. Drilling scoped the view to one turn.
		await expect(panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`)).toHaveCount(0);
		await expect(panel.locator(`[data-node-id="${PROMPT_PLAN}"]`)).toHaveCount(0);

		// The prompt is the level-2 root, so it is no longer a drill target.
		await expect(panel.locator(`[data-node-id="${PROMPT_BENCH}"]`)).toHaveAttribute(
			"data-drillable",
			"false",
		);

		// Breadcrumb: root frame + the turn we drilled into.
		await expect(panel.getByTestId("chat-graph-crumb")).toHaveText(["Conversation", LABEL_BENCH]);

		// Back returns to level 1 with every prompt restored.
		await panel.getByTestId("chat-graph-back").click();
		await expect(panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`)).toBeVisible();
		await expect(panel.getByRole("heading", { name: "Conversation map" })).toBeVisible();
		await expect(panel.locator('[data-testid="chat-graph-node"][data-kind="prompt"]')).toHaveCount(3);
		await expect(panel.getByTestId("chat-graph-breadcrumb")).toHaveCount(0);
	});

	test("a rewind fork renders two paths with the rewound-away one greyed", async ({
		page,
		mockApi,
	}) => {
		await gotoChat(page, mockApi);
		const panel = await openPanel(page);

		// Both legs of the fork leave the shared parent as `branch` edges.
		await expect(panel.locator('[data-testid="chat-graph-edge"][data-kind="branch"]')).toHaveCount(2);
		await expect(
			panel.locator(
				`[data-testid="chat-graph-edge"][data-from="${PROMPT_PLAN}"][data-to="${PROMPT_ROLLBACK}"]`,
			),
		).toHaveAttribute("data-kind", "branch");
		await expect(
			panel.locator(
				`[data-testid="chat-graph-edge"][data-from="${PROMPT_PLAN}"][data-to="${PROMPT_BENCH}"]`,
			),
		).toHaveAttribute("data-kind", "branch");

		// The two legs sit on the same row — a real fan-out, not a chain.
		const rewound = panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`);
		const live = panel.locator(`[data-node-id="${PROMPT_BENCH}"]`);
		const rewoundBox = await rewound.boundingBox();
		const liveBox = await live.boundingBox();
		expect(rewoundBox).not.toBeNull();
		expect(liveBox).not.toBeNull();
		expect(Math.round(rewoundBox!.y)).toBe(Math.round(liveBox!.y));
		expect(rewoundBox!.x).not.toBe(liveBox!.x);

		// The rewound-away leg is visibly dimmed; the live one is not.
		await expect(rewound).toHaveAttribute("data-excluded", "true");
		await expect(live).toHaveAttribute("data-excluded", "false");
		expect(await rewound.evaluate((el) => getComputedStyle(el).opacity)).toBe("0.45");
		expect(await live.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

		// Colour alone is not enough — the state is in the accessible name too.
		await expect(rewound).toHaveAttribute(
			"aria-label",
			`Prompt: ${LABEL_ROLLBACK}, succeeded, rewound away. Opens this turn's trace.`,
		);
	});

	test("a sub-agent node is present on both levels and drills into its own graph", async ({
		page,
		mockApi,
	}) => {
		const requested = await gotoChat(page, mockApi);
		const panel = await openPanel(page);

		// Level 1: the spawn hangs off the turn that made it, on a dashed edge.
		await expect(
			panel.locator(
				`[data-testid="chat-graph-edge"][data-from="${PROMPT_BENCH}"][data-to="${SUBCONV_ID}"]`,
			),
		).toHaveAttribute("data-kind", "spawn");

		// Drill through the turn so the sub-agent is reached from level 2 —
		// the deepest path a user actually walks.
		await panel.locator(`[data-node-id="${PROMPT_BENCH}"]`).click();
		const subagent = panel.locator('[data-testid="chat-graph-node"][data-kind="subagent"]');
		await expect(subagent).toHaveCount(1);
		await expect(subagent).toHaveAttribute("data-drillable", "true");
		await expect(subagent).toHaveAttribute(
			"aria-label",
			`Sub-agent: ${LABEL_SUBAGENT}, succeeded. Opens this sub-agent's graph.`,
		);

		await subagent.click();

		// It navigated to the CHILD conversation's own level 1.
		await expect(panel.locator('[data-node-id="s-measure"]')).toContainText(LABEL_SUBAGENT_PROMPT);
		await expect(panel.getByRole("heading", { name: "Conversation map" })).toBeVisible();
		expect(requested).toEqual([
			`/api/conversations/${CONV_ID}/graph`,
			`/api/conversations/${CONV_ID}/graph?turn=${PROMPT_BENCH}`,
			`/api/conversations/${SUBCONV_ID}/graph`,
		]);
		await expect(panel.getByTestId("chat-graph-crumb")).toHaveText([
			"Conversation",
			LABEL_BENCH,
			LABEL_SUBAGENT,
		]);

		// The breadcrumb pops all the way back to the root frame.
		await panel.getByTestId("chat-graph-crumb").first().click();
		await expect(panel.locator(`[data-node-id="${PROMPT_PLAN}"]`)).toContainText(LABEL_PLAN);
		await expect(panel.getByTestId("chat-graph-breadcrumb")).toHaveCount(0);
	});

	test("an unknown duration renders an em dash, never 0ms", async ({ page, mockApi }) => {
		await gotoChat(page, mockApi);
		const panel = await openPanel(page);
		await panel.locator(`[data-node-id="${PROMPT_BENCH}"]`).click();
		await expect(panel.getByRole("heading", { name: "Turn trace" })).toBeVisible();

		// The built-in tool with no observability row: em dash on the node box…
		const unknown = panel.locator(`[data-node-id="${TOOL_WITHOUT_DURATION}"]`);
		await expect(unknown).toContainText("Tool · —");
		await expect(unknown).not.toContainText("0ms");
		// …and the duration is OMITTED from the accessible name rather than
		// being read out as punctuation.
		await expect(unknown).toHaveAttribute(
			"aria-label",
			`Tool: ${LABEL_TOOL_WITHOUT_DURATION}, succeeded. Shows details.`,
		);

		// A genuinely known duration is still printed, so the em dash above is
		// "unknown" and not "the UI never shows durations".
		const known = panel.locator(`[data-node-id="${TOOL_WITH_DURATION}"]`);
		await expect(known).toContainText("Tool · 840ms");
		await expect(known).toHaveAttribute(
			"aria-label",
			`Tool: ${LABEL_TOOL_WITH_DURATION}, succeeded, 840ms. Shows details.`,
		);

		// Nowhere in the whole panel does a fabricated zero appear. Matched on
		// the rendered duration SLOT (`… · 0ms`) rather than the bare substring,
		// which a legitimate "840ms" also contains.
		await expect(panel).not.toContainText(/·\s*0ms/);

		// Selecting the unknown-duration node carries the em dash into the
		// detail pane too (a non-drillable node selects instead of navigating).
		await unknown.click();
		const detail = panel.getByTestId("chat-graph-detail");
		await expect(detail).toContainText(LABEL_TOOL_WITHOUT_DURATION);
		await expect(detail).toContainText("Tool · succeeded · —");
		await expect(panel.getByRole("heading", { name: "Turn trace" })).toBeVisible();
	});

	test("a degraded graph shows the quiet notice, not an error", async ({ page, mockApi }) => {
		await gotoChat(page, mockApi, {
			convId: DEGRADED_CONV_ID,
			table: { [graphKey(DEGRADED_CONV_ID, null)]: level1Degraded },
		});
		const panel = await openPanel(page);

		await expect(panel.getByTestId("chat-graph-notice")).toHaveText(
			"Branch history is unavailable, so this map is shown as a single chain.",
		);

		// Explicitly NOT an error: the graph still drew.
		await expect(panel.getByTestId("chat-graph-error")).toHaveCount(0);
		await expect(panel.getByTestId("chat-graph-retry")).toHaveCount(0);
		await expect(panel.getByTestId("chat-graph-empty")).toHaveCount(0);
		await expect(panel.getByTestId("chat-graph-canvas")).toBeVisible();
		await expect(panel.locator('[data-testid="chat-graph-node"][data-kind="prompt"]')).toHaveCount(2);
	});

	test("the panel closes from its own button and from Escape", async ({ page, mockApi }) => {
		await gotoChat(page, mockApi);
		const panel = await openPanel(page);

		await panel.getByTestId("chat-graph-close").click();
		await expect(page.getByTestId("chat-graph-panel")).toHaveCount(0);
		await expect(page.getByTestId("chat-graph-btn")).toHaveAttribute("aria-pressed", "false");

		// Reopen, then close with Escape (the drawer registry's topmost handler).
		await openPanel(page);
		await expect(page.getByTestId("chat-graph-btn")).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("chat-graph-panel")).toHaveCount(0);
		await expect(page.getByTestId("chat-graph-btn")).toHaveAttribute("aria-pressed", "false");
	});
});
