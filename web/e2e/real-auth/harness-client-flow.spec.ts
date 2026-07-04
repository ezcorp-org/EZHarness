/**
 * Headline e2e: an EXTERNAL harness fully controls a live instance.
 *
 * Proves the whole remote-control + determinism stack against a real built +
 * previewed server (PI_E2E_REAL=1, NODE_ENV=test per playwright.real.config):
 *
 *   1. Mint an `ezk_*` API key via the authenticated admin cookie.
 *   2. Seed a conversation through the gated test surface.
 *   3. Drive a DETERMINISTIC run as a pure bearer client (no cookie) using
 *      @ezcorp/harness-client: script a tool-call turn + a text turn, send the
 *      message with the mock provider, and block for the terminal result.
 *
 * Everything between the message and the result is the real harness — the
 * mock only replaces the LLM's HTTP boundary.
 */
import { test, expect } from "@playwright/test";
// Relative import: the package isn't a web dependency; Playwright's TS loader
// resolves the workspace source directly.
import { HarnessClient } from "../../../packages/@ezcorp/harness-client/src/index";

test.describe("external harness — remote control end-to-end", () => {
  test("mint key → seed → deterministic scripted run via the client", async ({ request, baseURL }) => {
    // 1. Mint a key with the admin session cookie (storageState).
    const keyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-harness", scopes: ["read", "chat", "admin"] },
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };
    expect(key.startsWith("ezk_")).toBe(true);

    // 2. Seed a conversation via the gated determinism surface.
    const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-harness" } });
    expect(seedRes.status(), await seedRes.text()).toBe(201);
    const { conversationId } = (await seedRes.json()) as { conversationId: string };

    // 3. Drive deterministically as an external bearer client.
    const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: key });
    const result = await ez.runScripted(
      conversationId,
      "introduce yourself",
      [{ text: "Hello from the deterministic mock LLM." }],
      { timeoutMs: 30_000 },
    );

    expect(result.outcome).toBe("complete");
    expect(result.run.status).toBe("success");

    // 4. Script a TOOL-CALL turn + a closing text turn: the mock only fakes
    // the LLM's HTTP boundary, so this drives the real tool loop (execute →
    // feed result back → next scripted turn) through the same bearer client.
    const conv2 = await ez.createConversation({ title: "e2e-harness-tools" });
    const toolResult = await ez.runScripted(
      conv2.id,
      "list the project files",
      [
        { toolCalls: [{ name: "listFiles", arguments: { path: "." } }] },
        { text: "Listed the files." },
      ],
      { timeoutMs: 30_000 },
    );

    expect(toolResult.outcome).toBe("complete");
    expect(toolResult.run.status).toBe("success");
  });
});
