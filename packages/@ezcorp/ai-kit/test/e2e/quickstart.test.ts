// @ezcorp-host-integration
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady, skipUnless } from "./_guard";

/** Live-server counterpart to `docs/quickstart-curl.md`. Runs the auth →
 *  create conversation → send message → stream → run:complete recipe against
 *  a real bun --hot server. */

const NEEDS_MODEL_PIN = "skip: precondition EZCORP_E2E_MODEL missing; tracked: leftovers-2026-10-16 ai-kit-deployed-lane";
/** The deterministic model the lane pins, as "<provider>/<model>" (e.g. "ezcorp-mock/mock:<script key>"). */
const MODEL_PIN = process.env.EZCORP_E2E_MODEL;

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY) || skipUnless(Boolean(MODEL_PIN), NEEDS_MODEL_PIN))("e2e: quickstart", () => {
  beforeAll(requireE2eReady);

  test("create conversation → send message → stream until run:complete", async () => {
    let markStreamOpen!: () => void;
    const streamOpen = new Promise<void>((resolve) => {
      markStreamOpen = resolve;
    });
    const observedFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (String(input).includes("/api/runtime-events")) markStreamOpen();
        return response;
      },
      { preconnect: fetch.preconnect },
    );
    const client = new EzcorpClient({
      baseUrl: E2E_BASE_URL!,
      apiKey: E2E_API_KEY!,
      fetch: observedFetch,
    });

    const health = await client.health();
    expect(health).toMatchObject({ ok: true });

    const slash = MODEL_PIN!.indexOf("/");
    const conv = await client.createConversation({ projectId: "global", title: "e2e quickstart", provider: MODEL_PIN!.slice(0, slash), model: MODEL_PIN!.slice(slash + 1) });
    expect(conv.id).toBeString();

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 30_000);
    const seen: string[] = [];
    const collect = (async () => {
      for await (const ev of client.streamEvents({ signal: ac.signal })) {
        const data = ev.data as Record<string, unknown>;
        if (data["conversationId"] !== conv.id) continue;
        seen.push(ev.type);
        if (ev.type === "run:complete" || ev.type === "run:error") return;
      }
    })();
    try {
      await streamOpen;
      const { runId } = await client.sendMessage(conv.id, { content: "Reply with the word READY." });
      expect(runId).toBeString();
      await collect;
    } finally {
      clearTimeout(timeout);
      ac.abort();
    }

    expect(seen).toContain("run:complete");
  }, 60_000);

  afterAll(() => {
    // no teardown — conversations persist in the live DB
  });
});
