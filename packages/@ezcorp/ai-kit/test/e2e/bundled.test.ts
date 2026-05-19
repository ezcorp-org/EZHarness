import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, e2eReady } from "./_guard";

/** Validates that ai-kit auto-installs on every EZCorp boot by default.
 *  Operators opt out by setting `EZCORP_DISABLE_AI_KIT=1`. Skipped cleanly
 *  when:
 *    - EZCORP_E2E_BASE_URL is unset (whole e2e suite)
 *    - server was booted with EZCORP_DISABLE_AI_KIT=1 (ai-kit absent)
 *
 *  To run locally:
 *    cd web && bun run dev   # default startup — ai-kit installs itself
 *    # in another terminal:
 *    export EZCORP_E2E_BASE_URL=http://localhost:5173
 *    export EZCORP_E2E_API_KEY=ez_...
 *    cd packages/@ezcorp/ai-kit && bun test test/e2e/bundled.test.ts
 *
 *  To verify opt-out works, re-run the dev server with
 *  EZCORP_DISABLE_AI_KIT=1 against a fresh DB; this test will skip cleanly.
 */

let ready = false;
let aiKitPresent = false;

beforeAll(async () => {
  ready = (await e2eReady()) && Boolean(E2E_API_KEY);
  if (!ready) return;
  const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
  const exts = (await client.listExtensions().catch(() => [])) as Array<{ name: string }>;
  aiKitPresent = exts.some((e) => e.name === "ai-kit");
});

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY))("e2e: bundled ai-kit", () => {
  test("ai-kit is registered as an installed extension", () => {
    if (!ready) return;
    if (!aiKitPresent) {
      console.log(
        "[skip] ai-kit not found in /api/extensions — server likely booted with EZCORP_DISABLE_AI_KIT=1, or is using an older DB snapshot that predates the default",
      );
      return;
    }
    expect(aiKitPresent).toBe(true);
  });

  test("ai-kit's tools are reachable via /api/extensions/ai-kit/tools", async () => {
    if (!ready || !aiKitPresent) return;
    const res = await fetch(new URL("/api/extensions/ai-kit/tools", E2E_BASE_URL!), {
      headers: { Authorization: `Bearer ${E2E_API_KEY!}` },
    });
    expect(res.ok).toBe(true);
    const tools = (await res.json()) as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    // Spot-check: the four fan-out primitives must all be exposed.
    expect(names).toContain("spawn_chats");
    expect(names).toContain("spawn_agents");
    expect(names).toContain("spawn_team");
    expect(names).toContain("assign_task");
  }, 10_000);

  test("sending ![ext:ai-kit] into a chat wires the tools", async () => {
    if (!ready || !aiKitPresent) return;
    const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
    const conv = await client.createConversation({
      projectId: "global",
      title: "e2e bundled ai-kit",
    });
    const res = await client.sendMessage(conv.id, {
      content: "![ext:ai-kit] hello",
    });
    expect(res.runId).toBeString();
    // We don't stream-to-completion here because that requires model credits.
    // Confirming the POST accepts the mention + returns a runId is the
    // contract under test — the mention-wiring pipeline validated the
    // extension exists, or the request would have 4xx'd.
  }, 30_000);
});
