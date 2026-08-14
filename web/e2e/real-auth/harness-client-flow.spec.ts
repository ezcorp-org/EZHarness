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
import { test, expect } from "../fixtures/hydration.js";
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

  test("createConversation persists modeId at CREATE — no follow-up PUT", async ({ request, baseURL }) => {
    // The route validated `modeId` (404 unknown, 403 for the reserved 'ez'
    // slug) and then built the create opts WITHOUT it, so an external harness
    // got a 201 for a field the server discarded and had to PUT afterwards to
    // make it stick. Proven against the real DB because the bug was precisely
    // that the accepted value never reached one.
    const keyRes = await request.post("/api/settings/developer/api-keys", {
      data: { name: "e2e-harness-mode", scopes: ["read", "chat"] },
    });
    expect(keyRes.status(), await keyRes.text()).toBe(201);
    const { key } = (await keyRes.json()) as { key: string };

    // Any seeded builtin mode except the reserved Ez one (403 by design).
    const modesRes = await request.get("/api/modes");
    expect(modesRes.status(), await modesRes.text()).toBe(200);
    const modes = (await modesRes.json()) as Array<{ id: string; slug: string; builtin: boolean }>;
    const mode = modes.find((m) => m.builtin && m.slug !== "ez");
    expect(mode, "expected a seeded builtin mode other than 'ez'").toBeTruthy();

    const ez = new HarnessClient({ baseUrl: baseURL!, apiKey: key });
    const conv = await ez.createConversation({ title: "e2e-harness-mode", modeId: mode!.id });
    expect(conv.modeId).toBe(mode!.id);

    // Re-read through a separate request: the assertion above reads the
    // INSERT's RETURNING row, this one reads the stored row back.
    const readRes = await request.get(`/api/conversations/${conv.id}`);
    expect(readRes.status(), await readRes.text()).toBe(200);
    const stored = (await readRes.json()) as { modeId: string | null };
    expect(stored.modeId).toBe(mode!.id);
  });

  test("PUT /api/conversations/:id resolves modeId through the same visibility gate", async ({ request }) => {
    // The update path used to write `modeId` with no existence and no owner
    // check, leaning on the FK — so it was looser than the create path that
    // resolves the id through `getVisibleMode`. Both halves are proven here
    // against real PGlite because "the FK will catch it" was exactly the
    // assumption that made an unknown id a 500 rather than a 404.
    const seedRes = await request.post("/api/__test/seed", { data: { title: "e2e-put-mode" } });
    expect(seedRes.status(), await seedRes.text()).toBe(201);
    const { conversationId } = (await seedRes.json()) as { conversationId: string };

    // A mode this caller owns. Created through the API, so its id is a real
    // UUID — the seeded builtins are text literals (`builtin-plan`) that
    // `updateConversationSchema`'s `z.string().uuid()` rejects outright.
    const modeRes = await request.post("/api/modes", {
      data: {
        name: "E2E Put Mode",
        slug: `e2e-put-mode-${Date.now()}`,
        systemPromptInstruction: "Be brief.",
      },
    });
    expect(modeRes.status(), await modeRes.text()).toBe(201);
    const ownMode = (await modeRes.json()) as { id: string };

    const okRes = await request.put(`/api/conversations/${conversationId}`, {
      data: { modeId: ownMode.id },
    });
    expect(okRes.status(), await okRes.text()).toBe(200);
    expect(((await okRes.json()) as { modeId: string | null }).modeId).toBe(ownMode.id);

    // An id no mode carries: one fail-closed 404, not an FK explosion.
    const ghostRes = await request.put(`/api/conversations/${conversationId}`, {
      data: { modeId: "00000000-0000-4000-8000-0000000000ff" },
    });
    expect(ghostRes.status()).toBe(404);
    expect((await ghostRes.json()) as { error?: string }).toMatchObject({
      error: "Mode not found",
    });

    // The refused write left the previous mode in place.
    const afterRes = await request.get(`/api/conversations/${conversationId}`);
    expect(afterRes.status(), await afterRes.text()).toBe(200);
    expect(((await afterRes.json()) as { modeId: string | null }).modeId).toBe(ownMode.id);
  });
});
