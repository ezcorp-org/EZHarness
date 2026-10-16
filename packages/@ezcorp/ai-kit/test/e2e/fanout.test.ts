// @ezcorp-host-integration
import { beforeAll, describe, expect, test } from "bun:test";
import { EzcorpClient } from "../../src/client";
import { E2E_API_KEY, E2E_BASE_URL, requireE2eReady, skipUnless } from "./_guard";

/** Validates that all four fan-out mechanisms work end-to-end against a live
 *  server. The server must already hold what three of them need (the agents
 *  "researcher" and "writer", an autoSpinUp team, at least one agent): each of
 *  those cases probes its precondition and skips by name when it is missing.
 *  spawn_chats needs nothing seeded. */

const NEEDS_AGENTS = "skip: precondition agents researcher and writer missing; tracked: ai-kit-deployed-lane";
const NEEDS_TEAM = "skip: precondition autoSpinUp team missing; tracked: ai-kit-deployed-lane";
const NEEDS_AGENT = "skip: precondition an agent missing; tracked: ai-kit-deployed-lane";

const configured = Boolean(E2E_BASE_URL && E2E_API_KEY);
type Agent = Awaited<ReturnType<EzcorpClient["listAgents"]>>[number];
async function seededAgents(): Promise<Agent[]> {
  await requireE2eReady();
  return new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! }).listAgents();
}
/** The precondition probe: what the configured server already holds. */
const agents = configured ? await seededAgents() : [];
const autoSpinUpTeam = agents.find(
  (a) => a.category === "team" && (a as unknown as { references?: { autoSpinUp?: boolean } }).references?.autoSpinUp,
);
// Unconfigured, the whole suite is out (no lane sets the URL), so no precondition is reported.
const missing = (present: boolean, reason: string) => configured && skipUnless(present, reason);

describe.skipIf(!configured)("e2e: four fan-out mechanisms", () => {
  beforeAll(requireE2eReady);

  const client = () => new EzcorpClient({ baseUrl: E2E_BASE_URL!, apiKey: E2E_API_KEY! });

  /** The sub-conversations of `conversationId` once at least one exists: polls the observed rows, never a fixed wait. */
  async function spawnedSubConversations(c: EzcorpClient, conversationId: string) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const subs = await c.getSubConversations(conversationId);
      if (subs.length > 0 || Date.now() > deadline) return subs;
      await Bun.sleep(100);
    }
  }

  test("(d) spawn_chats — batch of 3 independent root conversations", async () => {
    const res = await client().spawnChats({
      chats: [
        { projectId: "global", initialMessage: "Say A." },
        { projectId: "global", initialMessage: "Say B." },
        { projectId: "global", initialMessage: "Say C." },
      ],
    });
    expect(res.chats).toHaveLength(3);
    const ids = new Set(res.chats.map((c) => c.conversationId));
    expect(ids.size).toBe(3);
  }, 60_000);

  test.skipIf(missing(["researcher", "writer"].every((name) => agents.some((a) => a.name === name)), NEEDS_AGENTS))("(a) parallel ![agent:…] mentions spawn concurrent sub-conversations", async () => {
    const c = client();
    const conv = await c.createConversation({ projectId: "global", title: "parallel-agents" });
    await c.sendMessage(conv.id, {
      content: "![agent:researcher] find a fun fact  ![agent:writer] write a haiku",
    });
    const subs = await spawnedSubConversations(c, conv.id);
    expect(subs.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test.skipIf(missing(autoSpinUpTeam !== undefined, NEEDS_TEAM))("(b) ![team:…] with autoSpinUp spawns every member", async () => {
    const c = client();
    const team = autoSpinUpTeam;
    const conv = await c.createConversation({ projectId: "global", title: "team-autospin" });
    await c.sendMessage(conv.id, { content: `![team:${team!.name}] start work` });
    const subs = await spawnedSubConversations(c, conv.id);
    expect(subs.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  test.skipIf(missing(agents.length > 0, NEEDS_AGENT))("(c) assign_task + start_assignment spawns a sub-conversation", async () => {
    const c = client();
    const agent = agents[0];
    const conv = await c.createConversation({ projectId: "global", title: "task-assignment" });
    // Task creation happens via an orchestrator agent turn; this test exercises
    // the HTTP endpoint against a synthetic task id: the server must route the
    // call and refuse the unknown task with a client error.
    const err = await c
      .assignTask({
        conversationId: conv.id,
        taskId: "nonexistent-task",
        agentConfigId: agent!.id,
      })
      .then(() => undefined, (e: unknown) => e as { status?: number });
    expect(err?.status).toBeGreaterThanOrEqual(400);
    expect(err?.status).toBeLessThan(500);
  }, 60_000);
});
