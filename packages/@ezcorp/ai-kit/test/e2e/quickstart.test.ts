// @ezcorp-host-integration
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady } from "./_guard";

/** Live-server counterpart to `docs/quickstart-curl.md`. Runs the auth →
 *  create conversation → send message → stream → run:complete recipe against
 *  a real bun --hot server. */

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY))("e2e: quickstart", () => {
  beforeAll(requireE2eReady);

  test("create conversation → send message → stream until run:complete", async () => {
    let markStreamOpen!: () => void;
    const streamOpen = new Promise<void>((resolve) => {
      markStreamOpen = resolve;
    });
    const observedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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

    const conv = await client.createConversation({ projectId: "global", title: "e2e quickstart" });
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
