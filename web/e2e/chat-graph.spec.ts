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
 *     (`src/runtime/chat-graph/types.d.ts` — built-in tools persist a
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
	FULL_LABEL_PLAN,
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
	SUBAGENT_PROMPT_ID,
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

/** Escape a fixture string for use inside a RegExp (labels contain punctuation). */
function escapeRe(v: string): string {
	return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
			// The turn's elapsed span rides the accessible name too, so a screen
			// reader hears how long the turn took without opening the card.
			`Prompt: ${LABEL_BENCH}, succeeded, 8s. Opens this turn's trace.`,
		);

		// Level 1 is the bare endpoint — no `?turn=`.
		expect(requested).toEqual([`/api/conversations/${CONV_ID}/graph`]);
		// A level-1 frame is the bottom of the stack, so no breadcrumb yet.
		await expect(panel.getByTestId("chat-graph-breadcrumb")).toHaveCount(0);
	});

	test("a label too wide for its box fades out and keeps its full text reachable", async ({
		page,
		mockApi,
	}) => {
		await gotoChat(page, mockApi);
		const panel = await openPanel(page);
		const wide = panel.locator(`[data-node-id="${PROMPT_PLAN}"]`);

		// `LABEL_PLAN` sits at the builder's 60-char boundary; a 168px box shows
		// roughly 23. The overflow is a soft mask fade, not a clip that slices
		// the last glyph in half — so the text group carries a mask and the
		// canvas defines no clipPath at all.
		await expect(wide.locator("g[mask]")).toHaveAttribute("mask", /^url\(#.*-nodemask\)$/);
		await expect(page.getByTestId("chat-graph-canvas").locator("clipPath")).toHaveCount(0);

		// Truncation is never lossy: the untruncated prompt is one hover away.
		// The native <title> was REMOVED with the hover card — browsers layer it
		// as a second, slower tooltip on top — so the card body is now where the
		// full text lives, and the accessible name carries it for screen readers.
		await expect(wide.locator("title")).toHaveCount(0);
		await expect(wide).toHaveAttribute("aria-label", new RegExp(escapeRe(FULL_LABEL_PLAN)));
		await wide.hover();
		await expect(panel.locator('[data-testid="chat-graph-hover-card"]')).toContainText(
			FULL_LABEL_PLAN,
		);
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

		// The rewound-away leg is visibly dimmed — but only its BOX, never its
		// text. Dimming the whole `<g>` (which is what this used to do) drops the
		// label to 2.69:1 and the meta line to 1.83:1 against the panel, both
		// under the WCAG AA 4.5:1 floor. The greyed read now comes from the box,
		// the accent bar, the status dot and the dashed stroke.
		await expect(rewound).toHaveAttribute("data-excluded", "true");
		await expect(live).toHaveAttribute("data-excluded", "false");
		const opacityOf = (node: typeof rewound, sel: string) =>
			node.locator(sel).evaluate((el) => getComputedStyle(el).opacity);
		expect(await opacityOf(rewound, ".node-box")).toBe("0.45");
		expect(await opacityOf(rewound, ".node-accent")).toBe("0.45");
		expect(await opacityOf(rewound, ".node-status")).toBe("0.45");
		expect(await opacityOf(rewound, ".node-label")).toBe("1");
		expect(await opacityOf(rewound, ".node-meta")).toBe("1");
		// The group itself must stay opaque, or the children's opacity compounds
		// with it and the text is dimmed after all.
		expect(await rewound.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
		// The live leg is undimmed throughout, so the two are still tellable apart.
		expect(await opacityOf(live, ".node-box")).toBe("1");
		expect(await live.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
		// Dashed vs solid is the second, non-colour signal.
		expect(
			await rewound.locator(".node-box").evaluate((el) => getComputedStyle(el).strokeDasharray),
		).not.toBe(await live.locator(".node-box").evaluate((el) => getComputedStyle(el).strokeDasharray));

		// Colour alone is not enough — the state is in the accessible name too.
		await expect(rewound).toHaveAttribute(
			"aria-label",
			`Prompt: ${LABEL_ROLLBACK}, succeeded, rewound away. Opens this turn's trace.`,
		);
	});

	/**
	 * Keyboard-only walk of the headline interaction, end to end: Tab into the
	 * graph, arrow to a prompt, Enter to drill, again into a sub-agent, and back
	 * out — asserting at every level that the graph is still enterable and that
	 * focus lands on a node of the CURRENT map.
	 *
	 * Scope note, so nobody mistakes what this defends. `GraphCanvas` also had a
	 * bug where a `focusedId` left over from the previous layout matched nothing
	 * and every node fell to `tabindex="-1"`. That one is NOT observable here —
	 * the panel unmounts the canvas on every navigation, which resets its focus
	 * state — and is pinned by the component test "switching levels re-homes the
	 * tab stop" instead.
	 *
	 * What IS observable here, and asserted below, is the consequence of that
	 * same unmount: the focused node is destroyed mid-navigation, so without a
	 * deliberate hand-off the browser drops focus to `<body>` and a keyboard
	 * user is dumped out of the graph on every drill-in.
	 */
	test("the graph is reachable and walkable by keyboard alone, across a level switch", async ({
		page,
		mockApi,
	}) => {
		await gotoChat(page, mockApi);
		const panel = await openPanel(page);
		/** The single node holding the roving tabindex — what one Tab press reaches. */
		const stops = panel.locator('[data-testid="chat-graph-node"][tabindex="0"]');
		const nodeAt = (id: string) => panel.locator(`[data-node-id="${id}"]`);

		// Every focus assertion below uses `toBeFocused`, which auto-retries.
		// Reading `document.activeElement` once is a race: a keypress moves
		// focus, and the panel may still be re-rendering around it.

		// Exactly one node is tab-reachable, so Tab enters the graph in one stop
		// rather than walking every node in it.
		await expect(stops).toHaveCount(1);
		await stops.focus();
		await expect(nodeAt(PROMPT_PLAN)).toBeFocused();

		// Arrows walk it and Enter drills in — no mouse anywhere in this test.
		await page.keyboard.press("ArrowDown");
		await expect(nodeAt(PROMPT_ROLLBACK)).toBeFocused();
		await page.keyboard.press("ArrowRight");
		await expect(nodeAt(PROMPT_BENCH)).toBeFocused();
		await page.keyboard.press("Enter");

		// Wait on a node that exists ONLY on level 2. The heading flips
		// synchronously on activation, before the fetch is even issued (see this
		// file's header), so it is not a signal that the new graph is drawn.
		await expect(nodeAt(SUBCONV_ID)).toBeVisible();
		// Focus followed the user into level 2 instead of being dropped on the
		// floor when the old canvas was unmounted — no re-Tabbing required.
		await expect(stops).toHaveCount(1);
		await expect(stops).toBeFocused();

		// Now the harder switch: drilling a sub-agent swaps in a DIFFERENT
		// conversation's map, sharing no node ids with the one we came from.
		await page.keyboard.press("End");
		await expect(nodeAt(SUBCONV_ID)).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(nodeAt(SUBAGENT_PROMPT_ID)).toBeVisible();
		// Nothing of the old graph survives — the id the canvas had focused is
		// simply gone.
		await expect(nodeAt(SUBCONV_ID)).toHaveCount(0);
		// Handed over again, onto a node of the NEW map.
		await expect(stops).toHaveCount(1);
		await expect(nodeAt(SUBAGENT_PROMPT_ID)).toBeFocused();

		// Going back is the deliberate exception: it is driven from the
		// breadcrumb, so focus is on a button outside the canvas and nothing was
		// lost — the graph must NOT grab it. It stays enterable all the same.
		await panel.getByTestId("chat-graph-back").click();
		await expect(nodeAt(SUBCONV_ID)).toBeVisible();
		await expect(stops).toHaveCount(1);
		await expect(stops).not.toBeFocused();
		await stops.focus();
		await expect(nodeAt(PROMPT_BENCH)).toBeFocused();
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
		// The em dash now lives in the Duration ROW: the glance line omits an
		// unknown duration rather than trailing a dash after the status. The
		// contract that matters is unchanged — never a fabricated "0ms".
		await expect(detail).toContainText("Tool · succeeded");
		await expect(detail).toContainText("Duration —");
		await expect(detail).not.toContainText("0ms");
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

test("the legend explains the colours and link styles, and collapses", async ({ page, mockApi }) => {
	await gotoChat(page, mockApi);
	const panel = await openPanel(page);

	// Open by default: an unexplained colour key is worse than none.
	const legend = panel.locator('[data-testid="chat-graph-legend"]');
	await expect(legend).toBeVisible();

	// One row per thing the canvas can draw. `error` appears twice on purpose —
	// once as a node kind, once as a status — so both are addressed by group.
	await expect(legend.locator('[data-legend-group="bar"][data-legend-id="prompt"]')).toContainText(
		"Prompt",
	);
	await expect(legend.locator('[data-legend-group="bar"][data-legend-id="error"]')).toContainText(
		"Error",
	);
	await expect(legend.locator('[data-legend-group="dot"][data-legend-id="error"]')).toContainText(
		"failed",
	);
	await expect(legend.locator('[data-legend-group="line"][data-legend-id="branch"]')).toContainText(
		"Fork",
	);
	await expect(
		legend.locator('[data-legend-group="line"][data-legend-id="excluded"]'),
	).toContainText("Rewound away");
	// Each kind row carries its icon alongside the colour swatch.
	await expect(
		legend.locator('[data-legend-group="bar"][data-legend-id="thinking"] svg.kind-icon'),
	).toBeVisible();

	// Collapsible, so it can be moved out of the way of the graph.
	const toggle = panel.locator('[data-testid="chat-graph-legend-toggle"]');
	await toggle.click();
	await expect(legend).toBeHidden();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(legend).toBeVisible();
});

test("hovering a node opens a card at the cursor that follows it between nodes", async ({
	page,
	mockApi,
}) => {
	await gotoChat(page, mockApi);
	const panel = await openPanel(page);

	const card = panel.locator('[data-testid="chat-graph-hover-card"]');
	await expect(card).toBeHidden();

	// A prompt: prose kind, so the card carries the full text and a drill hint.
	await panel.locator(`[data-node-id="${PROMPT_PLAN}"]`).hover();
	await expect(card).toBeVisible();
	await expect(card).toHaveAttribute("data-detail-for", PROMPT_PLAN);
	await expect(panel.locator('[data-testid="chat-graph-hover-glance"]')).toContainText("Prompt");
	// A turn reports its elapsed span as "Took", plus a breakdown of what it
	// contained. Zero counts are dropped, so the rollback turn shows none.
	await expect(card).toContainText("Took");
	await expect(card).toContainText("42s");
	await expect(card).toContainText("Replies 2");
	await expect(card).toContainText("Tool calls 3");
	await expect(card).toContainText("Sub-agents 1");
	await expect(card).toContainText("Thinking steps 1");
	// Each count is marked with the icon of the thing it counts.
	for (const kind of ["assistant", "tool", "subagent", "thinking"]) {
		await expect(card.locator(`svg.row-icon[data-kind="${kind}"]`)).toBeVisible();
	}
	// Token cost as a single line, compacted.
	await expect(card).toContainText("12k in · 980 out · 13k total");
	await expect(card).toContainText("Started");
	// The kind icon is drawn next to the heading, tinted by kind.
	await expect(card.locator('svg.kind-icon[data-kind="prompt"]')).toBeVisible();

	// It is anchored to the cursor, not pinned to a corner.
	const box = await card.boundingBox();
	expect(box).not.toBeNull();

	// A rewound-away node states the branch in words, not only in colour.
	await panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`).hover();
	await expect(card).toHaveAttribute("data-detail-for", PROMPT_ROLLBACK);
	await expect(card).toContainText("Rewound away");
	// A turn that produced nothing: replies still shown at 0, the rest dropped.
	await expect(card).toContainText("Replies 0");
	await expect(card).not.toContainText("Tool calls");

	// The sub-agent names the chat it opens, and its heading is kind-coloured.
	await panel.locator(`[data-node-id="${SUBCONV_ID}"]`).hover();
	await expect(card).toHaveAttribute("data-detail-for", SUBCONV_ID);
	await expect(card).toContainText("Sub-chat");
	const kind = card.locator(".hover-kind");
	await expect(kind).toHaveAttribute("data-kind", "subagent");
	await expect(kind).toHaveText("Sub-agent");
	await expect(card.locator('svg.kind-icon[data-kind="subagent"]')).toBeVisible();

	// Transparent to the pointer: the node underneath is still clickable even
	// with the card over it. This is what a previous interactive version broke.
	await expect(card).toHaveCSS("pointer-events", "none");

	// Moving off the graph closes it.
	await panel.locator('[data-testid="chat-graph-legend"]').hover();
	await expect(card).toBeHidden();
});
