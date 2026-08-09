/**
 * Chat DAG graph — visual evidence.
 *
 * Frontend-visual change (`web/src/lib/components/chat/ChatGraphPanel.svelte`,
 * `GraphCanvas.svelte`, the header button in `ChatHeader.svelte`, and the chat
 * route that mounts them), so the feature contract requires an
 * `@evidence`-tagged spec that calls `captureEvidence`. See
 * `web/e2e/evidence-covers.json` for the source globs these captures cover.
 *
 * Three shots, one per surface a reviewer needs to look at:
 *   1. LEVEL 1 — the conversation map, including the rewind fork (one leg
 *      greyed) and the sub-agent spawn on its dashed edge.
 *   2. LEVEL 2 — one turn's trace, including the em-dash duration that the
 *      contract demands in place of a fabricated "0ms".
 *   3. The observability Execution Timeline, because `WaterfallTimeline` was
 *      re-pointed at the shared `$lib/timeline-normalize` module this feature
 *      extracted — it is a visual surface touched by this change, so it is
 *      rendered here rather than merely claimed in the covers map.
 *
 * Every test asserts before it captures: a screenshot of a broken render is
 * worse than no screenshot.
 */

import { test, expect, captureEvidence } from "./fixtures/test-base.js";
import {
  CONV_ID,
  LABEL_BENCH,
  LABEL_PLAN,
  LABEL_REPLY,
  LABEL_ROLLBACK,
  LABEL_SUBAGENT,
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
  conversation,
  messages,
  mockGraphApi,
  project,
} from "./fixtures/graph-data.js";

test.describe("Chat DAG graph visual evidence", () => {
  test("conversation map and turn trace render both graph levels @evidence", async ({
    page,
    mockApi,
  }, testInfo) => {
    await mockApi({ projects: [project], conversations: [conversation], messages });
    // AFTER mockApi so this newer route wins over the `**/api/**` catch-all.
    await mockGraphApi(page);
    await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
    await page.waitForLoadState("networkidle");

    await page.getByTestId("chat-graph-btn").click();
    const panel = page.getByTestId("chat-graph-panel");
    await expect(panel).toBeVisible();
    // The drawer mounts off-screen at translateX(100%) and slides in; wait
    // for the settled transform so the capture is never mid-transition.
    await expect(
      page.locator('[data-testid="swipe-drawer-panel"]:has([data-testid="chat-graph-panel"])'),
    ).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");

    // ── Level 1: the conversation map ───────────────────────────────
    await expect(panel.getByRole("heading", { name: "Conversation map" })).toBeVisible();
    await expect(panel.locator('[data-testid="chat-graph-node"][data-kind="prompt"]')).toHaveCount(
      3,
    );
    await expect(panel.locator(`[data-node-id="${PROMPT_PLAN}"]`)).toContainText(LABEL_PLAN);
    // The fork: one leg greyed, one live, and the sub-agent hanging off the
    // live turn — the three things this drawing exists to show.
    await expect(panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`)).toHaveAttribute(
      "data-excluded",
      "true",
    );
    await expect(panel.locator(`[data-node-id="${PROMPT_BENCH}"]`)).toContainText(LABEL_BENCH);
    await expect(panel.locator(`[data-node-id="${SUBCONV_ID}"]`)).toContainText(LABEL_SUBAGENT);
    await expect(panel.locator('[data-testid="chat-graph-edge"][data-kind="branch"]')).toHaveCount(
      2,
    );
    await expect(panel.locator(`[data-node-id="${PROMPT_ROLLBACK}"]`)).toContainText(
      LABEL_ROLLBACK,
    );
    // The key, open by default, is part of what the screenshot must show —
    // the accent bars and dot colours are meaningless without it.
    const legend = panel.locator('[data-testid="chat-graph-legend"]');
    await expect(legend).toBeVisible();
    await expect(
      legend.locator('[data-legend-group="bar"][data-legend-id="subagent"]'),
    ).toContainText("Sub-agent");
    await expect(
      legend.locator('[data-legend-group="line"][data-legend-id="spawn"]'),
    ).toContainText("Spawns");
    await captureEvidence(page, testInfo, "chat-graph-level-1-conversation-map");

    // ── Level 2: one turn's trace ───────────────────────────────────
    await panel.locator(`[data-node-id="${PROMPT_BENCH}"]`).click();
    await expect(panel.locator(`[data-node-id="thinking:${REPLY_BENCH}"]`)).toContainText(
      LABEL_THINKING,
    );
    await expect(panel.locator(`[data-node-id="${REPLY_BENCH}"]`)).toContainText(LABEL_REPLY);
    await expect(panel.locator('[data-testid="chat-graph-node"][data-kind="tool"]')).toHaveCount(2);
    // The em dash is the point of this shot: an unknown duration is never 0ms.
    const unknownDuration = panel.locator(`[data-node-id="${TOOL_WITHOUT_DURATION}"]`);
    await expect(unknownDuration).toContainText(LABEL_TOOL_WITHOUT_DURATION);
    await expect(unknownDuration).toContainText("Tool · —");
    // The duration SLOT never says 0ms (a bare "0ms" substring would also
    // match the legitimate "840ms" on the neighbouring node).
    await expect(panel).not.toContainText(/·\s*0ms/);
    await expect(panel.getByTestId("chat-graph-crumb")).toHaveText(["Conversation", LABEL_BENCH]);

    // Select a node so the detail pane is in frame too.
    await unknownDuration.click();
    // Em dash in the Duration ROW; the glance omits an unknown duration.
    await expect(panel.getByTestId("chat-graph-detail")).toContainText("Tool · succeeded");
    await expect(panel.getByTestId("chat-graph-detail")).toContainText("Duration —");
    await expect(panel.getByTestId("chat-graph-detail")).not.toContainText("0ms");
    await expect(panel.getByTestId("chat-graph-node-ring")).toHaveCount(1);
    await captureEvidence(page, testInfo, "chat-graph-level-2-turn-trace");
  });

  test("observability execution timeline renders the shared normalizer's bars @evidence", async ({
    page,
    mockApi,
  }, testInfo) => {
    await mockApi({
      projects: [project],
      conversations: [conversation],
      messages,
      routes: {
        "/api/settings/global:showObservability": () => ({ value: true }),
        [`/api/observability/${CONV_ID}`]: () => ({
          events: [
            {
              id: "evt-read",
              eventType: "tool_call",
              data: {
                toolName: LABEL_TOOL_WITH_DURATION,
                extensionId: "builtin",
                input: { path: "schema.sql" },
                output: { bytes: 2048 },
              },
              durationMs: 840,
              createdAt: "2026-04-01T00:02:05.000Z",
            },
            {
              id: "evt-bench",
              eventType: "tool_call",
              data: {
                toolName: LABEL_TOOL_WITHOUT_DURATION,
                extensionId: "builtin",
                input: { command: "pgbench -c 8" },
                output: { exitCode: 0 },
              },
              durationMs: 3100,
              createdAt: "2026-04-01T00:02:15.000Z",
            },
          ],
          stats: {
            totalInputTokens: 1200,
            totalOutputTokens: 450,
            totalToolCalls: 2,
            avgDurationMs: 1970,
            turnCount: 1,
          },
        }),
      },
    });
    await page.goto(`/project/${PROJECT_ID}/chat/${CONV_ID}`);
    await page.waitForLoadState("networkidle");

    const obsButton = page.getByRole("button", { name: "Inspect observability" });
    await expect(obsButton).toBeVisible();
    await obsButton.click();

    // The Execution Timeline section is `WaterfallTimeline`, now fed by the
    // shared normalizer this feature extracted.
    await expect(page.getByText("Execution Timeline")).toBeVisible();
    await expect(page.getByText(LABEL_TOOL_WITH_DURATION, { exact: true })).toBeVisible();
    await expect(page.getByText(LABEL_TOOL_WITHOUT_DURATION, { exact: true })).toBeVisible();
    await captureEvidence(page, testInfo, "chat-graph-waterfall-timeline");
  });
});
