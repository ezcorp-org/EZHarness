import { test, expect } from "./fixtures/test-base.js";
import { makeProject, makeConversation, makeMessage, makeRun } from "./fixtures/data.js";

// E2E regression guard for the reverse-RPC provenance fix.
//
// THE BUG: an `![ext:extension-author] make a weather extension` flow
// drives the bundled `extension-author` `create_extension` tool, which
// fires host-mediated reverse-RPCs (`ezcorp/fs.mkdir`, `ezcorp/fs.write`)
// back into the host. Those handlers used to read caller identity from
// the process-wide `ToolExecutor.currentUserId/currentConversationId`
// singletons. Under concurrency / background fires the singleton was
// wrong or absent → the capability handler threw "missing onBehalfOf"
// → the tool call NEVER returned → the chat sat in "Working…" until the
// 90s watchdog killed the run (the `extension-author__create_extension`
// 90s-hang symptom). The fix threads a host-issued `ezCallId` token so
// the reverse-RPC always resolves the right user (or cleanly soft-fails)
// and the tool call COMPLETES.
//
// ── WHAT THIS SPEC PROVES, AND WHAT IT DOES NOT ───────────────────────
//
// This is the MOCK tier: the runtime is faked over SSE, so the spec is
// the STIMULUS for the runtime events it asserts on. Being blunt about
// the boundary:
//
//   PROVES  — the browser half of the contract. Given the exact event
//             sequence the fixed runtime emits (tool:start → tool:complete
//             success → run:complete), the chat renders a running card,
//             then a COMPLETED card carrying the tool's result, tears the
//             streaming UI down, and re-enables the composer. Every one of
//             those is a real client-side pipeline (ws.ts EventSource →
//             stores.svelte.ts → ChatThread/ToolCallCard) that can and does
//             break independently of the server.
//   DOES NOT — prove the host-side `call-provenance.ts` ↔ SDK ↔ host token
//             round-trip. Nothing here spawns an extension subprocess.
//             That seam is covered server-side by
//             tool-executor.fs-provenance.test.ts,
//             dispatcher-provenance.test.ts and the call-provenance suite,
//             and end-to-end against a live server by
//             `web/e2e/real-auth/extension-release-gate.spec.ts`.
//
// To keep the injection from making the spec unfalsifiable, each phase
// asserts the state BEFORE its event as well as after: the result text is
// asserted ABSENT while the call is running and PRESENT only after
// tool:complete lands. A client that ignored the events (or rendered the
// result unconditionally) fails.
//
// Runtime events stream over SSE (`ws.ts` EventSource →
// `stores.svelte.ts`), so events are injected with `emitSse` (NOT the
// deprecated `emitWs` WebSocket transport — see project memory
// "E2E streaming uses SSE"). Harness mirrors substack-pipeline.spec.ts,
// the proven passing extension-tool-call SSE pattern.

test.describe("extension-author provenance — create_extension tool call completes (no 90s hang)", () => {
  const proj = makeProject({ id: "proj-1", name: "Test Project" });
  const conv = makeConversation({
    id: "conv-1",
    projectId: "proj-1",
    title: "Extension Author Chat",
  });
  const userMsg = makeMessage({
    id: "m1",
    conversationId: "conv-1",
    role: "user",
    content: "![ext:extension-author] make a weather extension",
  });
  const assistantMsg = makeMessage({
    id: "m2",
    conversationId: "conv-1",
    role: "assistant",
    content: "On it.",
    parentMessageId: "m1",
    createdAt: "2026-01-01T00:01:00.000Z",
  });

  const RESULT_TEXT = "Created extension 'weather' (manifest + handler scaffolded).";

  async function setupAndSend(
    page: import("@playwright/test").Page,
    mockApi: (overrides?: Record<string, unknown>) => Promise<void>,
  ) {
    await mockApi({
      projects: [proj],
      conversations: [conv],
      messages: [userMsg, assistantMsg],
    });
    await page.goto(`/project/${proj.id}/chat/${conv.id}`);
    // Gate on a hydrated (enabled) composer before driving it, then TYPE
    // rather than `fill()`: the composer maintains a compact display
    // string projected over a wire string and re-syncs the two from a
    // keydown-scheduled pass, so a programmatic `fill` leaves the draft
    // empty and the Send button disabled.
    const textarea = page.locator("textarea.chat-textarea");
    await expect(textarea).toBeEnabled({ timeout: 15_000 });
    await textarea.click();
    await textarea.pressSequentially("make a weather extension", { delay: 10 });
    const sent = page.waitForResponse(
      (r) => r.url().includes("/messages") && r.request().method() === "POST",
      { timeout: 20_000 },
    );
    await textarea.press("Enter");
    await sent;
  }

  test("create_extension streams running → tool:complete (success draft), no error / no stuck Working state", async ({
    page,
    mockApi,
    emitSse,
  }) => {
    await setupAndSend(page, mockApi);

    // Run begins streaming.
    await emitSse({
      type: "run:token",
      data: { runId: "run-stream", token: "Building the extension…" },
    });

    // The bundled extension-author tool starts. Pre-fix, the
    // host-mediated fs.mkdir/fs.write reverse-RPCs this tool issues
    // would throw "missing onBehalfOf" and the call would never
    // resolve — the card would stay in the running state forever
    // until the 90s watchdog killed the run.
    await emitSse({
      type: "tool:start",
      data: {
        conversationId: "conv-1",
        extensionId: "ext-extension-author",
        toolName: "extension-author.create_extension",
        input: { name: "weather", description: "A weather extension" },
        timestamp: Date.now(),
        invocationId: "tc-create-ext-1",
      },
    });

    // The running card is visible (chat progressed past "Thinking…").
    const cardLabel = page.getByText("extension-author.create_extension").first();
    await expect(cardLabel).toBeVisible({ timeout: 8000 });

    // The collapsed card header IS the expand button; open it NOW, while
    // the call is still running, so the result body is on screen for both
    // halves of the control below.
    await cardLabel.locator("xpath=ancestor::button[1]").click();

    // CONTROL: with the card already expanded, the result text is still
    // absent — the call has not returned. This is what makes the
    // post-complete assertion falsifiable: a client that rendered results
    // unconditionally (or a spec merely echoing its own fixture string)
    // fails right here.
    await expect(page.getByText(RESULT_TEXT, { exact: false })).toHaveCount(0);

    // THE FIX'S OBSERVABLE EFFECT: the reverse-RPC resolves, so the
    // tool call returns a real result instead of hanging. The runtime
    // emits tool:complete with a successful draft (the new extension
    // scaffold) — NOT a watchdog timeout/error.
    await emitSse({
      type: "tool:complete",
      data: {
        conversationId: "conv-1",
        extensionId: "ext-extension-author",
        toolName: "extension-author.create_extension",
        output: {
          content: [
            {
              type: "text",
              text: RESULT_TEXT,
            },
          ],
          isError: false,
        },
        duration: 1200,
        success: true,
        invocationId: "tc-create-ext-1",
      },
    });

    // 1) The completed result surfaced in the chat — the card moved out
    //    of its running state and rendered the tool's output.
    await expect(page.getByText(RESULT_TEXT, { exact: false }).first()).toBeVisible({
      timeout: 8000,
    });

    // 2) The card is in its SUCCESS shape: the failure marker the
    //    watchdog path produces ("Run failed") is absent.
    await expect(page.getByText("Run failed", { exact: false })).toHaveCount(0);

    // 3) No provenance error text leaked into the UI.
    await expect(page.getByText(/missing onBehalfOf/i)).toHaveCount(0);

    // Run finishes cleanly — the chat did NOT sit until the watchdog.
    // The client's terminal-run payload is `{ run }` (stores.svelte.ts
    // `case "run:complete"` destructures `event.data.run`), same shape
    // streaming-race.spec.ts uses.
    await emitSse({
      type: "run:complete",
      data: { run: makeRun({ id: "run-stream", status: "success" }), conversationId: "conv-1" },
    });

    // 4) The run terminalized: the streaming affordances are gone. This
    //    is the direct inverse of the 90s-hang symptom (a chat pinned in
    //    "Working…" behind a tool call that never returned), and the
    //    composer is interactive again — the user is unblocked.
    await expect(page.locator(".streaming-cursor")).toHaveCount(0, { timeout: 8000 });
    await expect(page.getByRole("button", { name: /stop generating/i })).toHaveCount(0, {
      timeout: 8000,
    });
    await expect(page.locator("textarea.chat-textarea")).toBeEnabled({ timeout: 8000 });
  });
});
