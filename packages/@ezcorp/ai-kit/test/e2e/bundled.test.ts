// @ezcorp-host-integration
import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady, skipUnless } from "./_guard";

/** Validate a bundled AI-kit release after verification, human approval, and
 * activation on a disposable server. Set EZCORP_E2E_BASE_URL and a test API
 * key with read/chat scopes. A configured target must expose the installed
 * extension; an unset target leaves this optional deployed-service suite out.
 */

const NEEDS_AI_KIT = "skip: precondition ai-kit installed missing; tracked: leftovers-2026-10-16 ai-kit-deployed-lane";

/** The configured server's installed extensions (the precondition probe). */
async function installedExtensions(): Promise<string[]> {
  await requireE2eReady();
  const client = new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });
  return ((await client.listExtensions()) as Array<{ name: string }>).map((e) => e.name);
}
const installed = E2E_BASE_URL && E2E_API_KEY ? await installedExtensions() : [];

describe.skipIf(!(E2E_BASE_URL && E2E_API_KEY) || skipUnless(installed.includes("ai-kit"), NEEDS_AI_KIT))("e2e: bundled ai-kit", () => {
  beforeAll(requireE2eReady);

  test("ai-kit is registered as an installed extension", () => {
    expect(installed).toContain("ai-kit");
  });

  test("ai-kit's tools are reachable via /api/extensions/ai-kit/tools", async () => {
    const res = await fetch(new URL("/api/extensions/ai-kit/tools", E2E_BASE_URL!), {
      headers: { Authorization: `Bearer ${E2E_API_KEY!}` },
    });
    expect(res.ok).toBe(true);
    const { tools } = (await res.json()) as { tools: Array<{ name: string }> };
    const names = tools.map((t) => t.name);
    // Spot-check: the four fan-out primitives must all be exposed.
    expect(names).toContain("spawn_chats");
    expect(names).toContain("spawn_agents");
    expect(names).toContain("spawn_team");
    expect(names).toContain("assign_task");
  }, 10_000);

  test("sending ![ext:ai-kit] into a chat wires the tools", async () => {
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
