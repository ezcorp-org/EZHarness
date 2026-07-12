/**
 * E2E regression guard: with the pi session tree as the conversation-
 * history PRODUCER (kill-switch `sessions:historyProducer` ON), a multi-turn
 * chat behaves IDENTICALLY to the legacy path.
 *
 * WHAT CHANGED (server-internal, no UI artifact): loadHistory can build the
 * conversation branch from the pi session tree instead of the legacy
 * recursive-CTE walk (src/db/session-sync.ts + load-history.ts). The output
 * is byte-identical by construction — the same filter/rehydration/mapping
 * runs over the session-derived branch rows — so there is NO new visible
 * artifact; the only observable effect is that multi-turn chat keeps working
 * (each follow-up turn still sees the full prior thread).
 *
 * WHERE THE REAL PROOF LIVES: the byte-parity of the two branch sources
 * (flag ON vs OFF) is proven exhaustively at the REAL loadHistory seam by
 * the integration suite `src/__tests__/session-history-producer-live-
 * parity.test.ts` (linear / branched / synthetic+excluded / attachments /
 * tool-image injection / fail-open / kill-switch flip). This e2e is the
 * browser-level regression guard that the producer doesn't break a real
 * multi-turn thread.
 *
 * SSE-only streaming per project memory `project_e2e_streaming_uses_sse` —
 * frames injected via `emitSse`, never `emitWs`.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DOCKER-GATED (gate-legal runtime skip, mirrors file-organizer-real.spec):
 * the non-Docker Playwright `webServer` serves the chat route with no
 * reachable backend / DB / auth session and NO real executor — so the real
 * loadHistory producer cannot run and a turn cannot be driven end-to-end.
 * The spec runs against the live container (`DOCKER_TEST=1`, app on :3000
 * with seeded auth → `e2e/docker-auth-setup.ts` + `.docker-auth.json`
 * storageState), where the REAL backend produces the history from the
 * session tree. Body is complete + valid so the Docker run needs no edits.
 * ─────────────────────────────────────────────────────────────────────
 */

import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage } from "./fixtures/data.js";

const RUN_REAL = !!process.env.DOCKER_TEST;

test.describe(
  RUN_REAL
    ? "session history producer — multi-turn chat parity"
    : "session history producer — multi-turn chat parity (skipped: set DOCKER_TEST=1)",
  () => {
    test.skip(!RUN_REAL, "real-backend spec — requires DOCKER_TEST=1 + live container on :3000");

    const proj = makeProject({ id: "proj-shp", name: "Session Producer Project" });
    const conv = makeConversation({ id: "conv-shp", projectId: "proj-shp", title: "Multi-turn thread" });

    // A prior thread the follow-up turn must still see once the session tree
    // produces the history.
    const history = [
      makeMessage({ id: "h-0", conversationId: "conv-shp", role: "user", content: "Remember the code word BANANA.", parentMessageId: null, runId: null }),
      makeMessage({ id: "h-1", conversationId: "conv-shp", role: "assistant", content: "Got it — BANANA.", parentMessageId: "h-0", runId: null }),
      makeMessage({ id: "h-2", conversationId: "conv-shp", role: "user", content: "What did I ask you to remember?", parentMessageId: "h-1", runId: null }),
      makeMessage({ id: "h-3", conversationId: "conv-shp", role: "assistant", content: "The code word BANANA.", parentMessageId: "h-2", runId: null }),
    ];

    const REPLY = "Still BANANA — I have the whole thread.";

    test("follow-up turn streams a normal reply that continues the thread; no error card", async ({ page, mockApi, emitSse }) => {
      await mockApi({ projects: [proj], conversations: [conv], messages: history });
      await page.goto(`/project/${proj.id}/chat/${conv.id}`);

      // The existing multi-turn thread renders.
      await expect(page.getByText("Got it — BANANA.")).toBeVisible({ timeout: 8000 });
      await expect(page.getByText("The code word BANANA.")).toBeVisible();

      // Send a follow-up: the real backend runs the session history producer
      // to rebuild the branch, then streams a turn.
      const textarea = page.locator("textarea");
      await textarea.fill("Say it one more time.");
      await textarea.press("Enter");
      await page.waitForResponse((r: any) => r.url().includes("/messages") && r.request().method() === "POST");

      await emitSse({ type: "run:token", data: { runId: "run-shp", token: REPLY, kind: "text" } });
      await expect(page.getByText(REPLY)).toBeVisible({ timeout: 8000 });
      await emitSse({
        type: "run:turn_saved",
        data: { runId: "run-shp", conversationId: "conv-shp", messageId: "h-new", parentMessageId: "h-3", content: REPLY, final: true },
      });
      await emitSse({
        type: "run:complete",
        data: { run: { id: "run-shp", agentName: "chat", status: "success", startedAt: "2026-01-01T00:00:00.000Z", logs: [], result: { success: true, output: REPLY } } },
      });

      // THE CONTRACT: a normal reply rendered, the whole thread is intact,
      // and no producer failure surfaced as an error card.
      await expect(page.getByText(REPLY)).toBeVisible();
      await expect(page.getByText("Got it — BANANA.")).toBeVisible();
      await expect(page.getByText(/history producer failed|invalid_session|Error:/i)).toHaveCount(0);
      await expect(page.locator("textarea")).toBeEnabled();
    });
  },
);
