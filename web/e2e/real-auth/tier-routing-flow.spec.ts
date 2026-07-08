/**
 * WS3 — quality-tier routing, end-to-end through the real server.
 *
 * The routing decision lives in `src/runtime/stream-chat/setup-tools.ts`:
 * when a turn has NO established model it classifies a tier (pure heuristic,
 * `src/runtime/tier-classifier.ts`) and routes; when a model IS pinned it
 * passes that model straight through (Level-1 passthrough) so an
 * established/pinned model is never re-routed mid-conversation (cache
 * protection).
 *
 * This spec drives a DETERMINISTIC scripted run against a live built +
 * previewed server (PI_E2E_REAL=1). `runScripted` pins the `ezcorp-mock`
 * provider + model, so it exercises the **explicit-pin passthrough** branch
 * end-to-end: the new `resolveModel(provider, model, routedTier)` signature
 * must honor the pin (routedTier is skipped) and the run must complete on
 * the exact pinned model. If the routing wiring ever regressed and started
 * re-routing a pinned turn, this run would leave the mock model and the mock
 * LLM would never answer — a hard, observable failure.
 *
 * HARNESS LIMITATION (documented follow-up): the mock LLM is only reachable
 * via a Level-1 pin (`provider === "ezcorp-mock"`), which is exactly the
 * passthrough path. The no-model tier-CLASSIFICATION path routes to a real
 * provider tier (anthropic/openai/…) that has no key in CI, so it cannot be
 * completed end-to-end until the mock is made routing-reachable (a WS-H mock
 * harness extension). The classification logic itself is exhaustively proven
 * by `src/__tests__/tier-classifier.test.ts` (100%) and the real-executor
 * integration in `src/__tests__/executor-streamchat.test.ts` (a model-less
 * turn drives the classifier through the real `setupTools`).
 */
import { test, expect } from "@playwright/test";
// Relative import: the package isn't a web dependency; Playwright's TS loader
// resolves the workspace source directly.
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";

test.describe("WS3 tier routing — pinned-model passthrough end-to-end", () => {
  test("a pinned model completes unchanged through the routing decision point", async ({
    request,
    baseURL,
  }) => {
    // Mint a chat-scoped key with the admin session cookie.
    const keyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-tier-routing", scopes: ["read", "chat"] },
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };
    expect(key.startsWith("ezk_")).toBe(true);

    // Seed a conversation via the gated determinism surface.
    const seedRes = await request.post("/api/__test/seed", {
      data: { title: "e2e-tier-routing" },
    });
    expect(seedRes.status(), await seedRes.text()).toBe(201);
    const { conversationId } = (await seedRes.json()) as { conversationId: string };

    // Drive a deterministic run as a bearer client. runScripted pins the
    // mock provider+model → the passthrough branch of the routing wiring.
    const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: key });
    const result = await ez.runScripted(
      conversationId,
      "route me",
      [{ text: "Routed to the pinned mock model." }],
      { timeoutMs: 30_000 },
    );

    // The run reached the mock LLM and completed = the pin was honored
    // through the routing decision point. The mock only answers when ITS
    // model is the one selected, so a successful terminal run is direct
    // proof the pinned model was never re-routed away.
    expect(result.outcome).toBe("complete");
    expect(result.run.status).toBe("success");
  });
});
