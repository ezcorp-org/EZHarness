import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { AgentRun, AgentLog } from "../types";

mockDbConnection();

const {
  insertRun,
  updateRun,
  insertLog,
  listRuns,
  getRunWithLogs,
  toAgentRun,
  getRunOwnership,
  getRunConversationId,
  resolveRootConversationOwner,
} = await import("../db/queries/runs");
const { createProject } = await import("../db/queries/projects");
const { createConversation } = await import("../db/queries/conversations");
const { createUser } = await import("../db/queries/users");

function makeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: crypto.randomUUID(),
    agentName: "writer",
    status: "running",
    startedAt: Date.now(),
    logs: [],
    ...overrides,
  };
}

describe("runs queries", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("insertRun stores a run row, retrievable via getRunWithLogs", async () => {
    const run = makeRun({ agentName: "alpha" });
    await insertRun(run);
    const fetched = await getRunWithLogs(run.id);
    expect(fetched).toBeDefined();
    expect(fetched!.agentName).toBe("alpha");
    expect(fetched!.status).toBe("running");
    expect(fetched!.projectId).toBeNull();
    expect(fetched!.input).toBeNull();
    expect(fetched!.logs).toEqual([]);
  });

  test("insertRun accepts projectId and input", async () => {
    const project = await createProject({ name: "runs-p", path: "/r" });
    const run = makeRun();
    await insertRun(run, project.id, { topic: "x" });

    const fetched = await getRunWithLogs(run.id);
    expect(fetched!.projectId).toBe(project.id);
    expect(fetched!.input).toEqual({ topic: "x" });
  });

  test("getRunWithLogs returns undefined for missing id", async () => {
    expect(await getRunWithLogs(crypto.randomUUID())).toBeUndefined();
  });

  test("updateRun changes status, sets finishedAt and result", async () => {
    const run = makeRun();
    await insertRun(run);

    const finished = Date.now() + 1000;
    await updateRun({
      ...run,
      status: "success",
      finishedAt: finished,
      result: { success: true, output: { value: 42 } },
    });

    const fetched = await getRunWithLogs(run.id);
    expect(fetched!.status).toBe("success");
    expect(fetched!.finishedAt).toBeInstanceOf(Date);
    expect(fetched!.finishedAt!.getTime()).toBe(finished);
    expect(fetched!.result).toEqual({ success: true, output: { value: 42 } });
  });

  test("updateRun without finishedAt sets it to null", async () => {
    const run = makeRun();
    await insertRun(run);
    await updateRun({ ...run, status: "error" });
    const fetched = await getRunWithLogs(run.id);
    expect(fetched!.status).toBe("error");
    expect(fetched!.finishedAt).toBeNull();
  });

  test("insertLog appends log entries returned by getRunWithLogs", async () => {
    const run = makeRun();
    await insertRun(run);

    const logs: AgentLog[] = [
      { timestamp: 1000, level: "info", message: "start" },
      { timestamp: 2000, level: "error", message: "boom" },
    ];
    for (const log of logs) await insertLog(run.id, log);

    const fetched = await getRunWithLogs(run.id);
    expect(fetched!.logs.length).toBe(2);
    const byLevel = Object.fromEntries(fetched!.logs.map((l) => [l.level, l]));
    expect(byLevel.info!.message).toBe("start");
    expect(byLevel.error!.message).toBe("boom");
    expect(byLevel.info!.timestamp).toBe(1000);
  });

  test("listRuns returns all rows when no projectId, ordered by startedAt desc", async () => {
    const earlier = makeRun({ startedAt: 1_000_000_000_000 });
    const later = makeRun({ startedAt: 2_000_000_000_000 });
    await insertRun(earlier);
    await insertRun(later);

    const all = await listRuns();
    expect(all.length).toBe(2);
    expect(all[0]!.id).toBe(later.id);
    expect(all[1]!.id).toBe(earlier.id);
  });

  test("listRuns filters by projectId", async () => {
    const p1 = await createProject({ name: "p1", path: "/1" });
    const p2 = await createProject({ name: "p2", path: "/2" });
    const r1 = makeRun();
    const r2 = makeRun();
    const r3 = makeRun();
    await insertRun(r1, p1.id);
    await insertRun(r2, p1.id);
    await insertRun(r3, p2.id);

    const p1Runs = await listRuns(p1.id);
    expect(p1Runs.length).toBe(2);
    expect(p1Runs.map((r) => r.id).sort()).toEqual([r1.id, r2.id].sort());

    const p2Runs = await listRuns(p2.id);
    expect(p2Runs.length).toBe(1);
    expect(p2Runs[0]!.id).toBe(r3.id);
  });

  test("listRuns returns empty array when none match", async () => {
    expect(await listRuns()).toEqual([]);
    expect(await listRuns(crypto.randomUUID())).toEqual([]);
  });

  test("toAgentRun converts DbRun + logs to AgentRun shape", async () => {
    const run = makeRun({ status: "success" });
    await insertRun(run);
    await insertLog(run.id, { timestamp: 100, level: "info", message: "hi" });

    const fetched = await getRunWithLogs(run.id);
    const agent = toAgentRun(fetched!);
    expect(agent.id).toBe(run.id);
    expect(agent.agentName).toBe(run.agentName);
    expect(agent.status).toBe("success");
    expect(typeof agent.startedAt).toBe("number");
    expect(agent.logs.length).toBe(1);
    expect(agent.logs[0]!.message).toBe("hi");
  });
});

describe("run ownership attribution (IDOR fix)", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  async function seedUser(id: string) {
    return createUser({ id, email: `${id}@x.com`, passwordHash: "h", name: id, role: "member" } as any);
  }

  test("insertRun with explicit userId stores it; getRunOwnership reads it back", async () => {
    await seedUser("owner-1");
    const run = makeRun();
    await insertRun(run, undefined, undefined, undefined, "owner-1");

    const own = await getRunOwnership(run.id);
    expect(own).toEqual({ userId: "owner-1", conversationId: null });
  });

  test("agent/CLI run with no user and no conversation → both null (unattributable, admin-only downstream)", async () => {
    const run = makeRun();
    await insertRun(run); // no conversation, no userId
    const own = await getRunOwnership(run.id);
    expect(own).toEqual({ userId: null, conversationId: null });
  });

  test("getRunOwnership returns undefined for a missing run", async () => {
    expect(await getRunOwnership(crypto.randomUUID())).toBeUndefined();
  });

  test("chat run on a top-level conversation auto-resolves the owner from the conversation", async () => {
    await seedUser("owner-2");
    const project = await createProject({ name: "ro-p", path: "/ro" });
    const conv = await createConversation(project.id, { userId: "owner-2" });

    const run = makeRun({ agentName: "chat" });
    // No explicit userId — insertRun must resolve it from the conversation.
    await insertRun(run, project.id, undefined, conv.id);

    const own = await getRunOwnership(run.id);
    expect(own).toEqual({ userId: "owner-2", conversationId: conv.id });
    // Conversation-id query still works for the legacy path.
    expect(await getRunConversationId(run.id)).toBe(conv.id);
  });

  test("chat run on a SUB-conversation resolves the ROOT owner (sub-conv userId is null)", async () => {
    await seedUser("owner-3");
    const project = await createProject({ name: "ro-sub", path: "/sub" });
    const root = await createConversation(project.id, { userId: "owner-3" });
    // Sub-conversation: userId null, parent points at the owned root.
    const sub = await createConversation(project.id, {
      parentConversationId: root.id,
    });
    expect(sub.userId).toBeNull();

    const run = makeRun({ agentName: "chat" });
    await insertRun(run, project.id, undefined, sub.id);

    const own = await getRunOwnership(run.id);
    expect(own!.userId).toBe("owner-3"); // walked to the root owner
    expect(own!.conversationId).toBe(sub.id);
  });

  test("resolveRootConversationOwner returns undefined for an ownerless chain (→ admin-only)", async () => {
    const project = await createProject({ name: "ro-orphan", path: "/orph" });
    const conv = await createConversation(project.id); // no userId
    expect(await resolveRootConversationOwner(conv.id)).toBeUndefined();

    const run = makeRun({ agentName: "chat" });
    await insertRun(run, project.id, undefined, conv.id);
    const own = await getRunOwnership(run.id);
    expect(own).toEqual({ userId: null, conversationId: conv.id });
  });

  test("resolveRootConversationOwner returns undefined for a missing conversation", async () => {
    expect(await resolveRootConversationOwner(crypto.randomUUID())).toBeUndefined();
  });

  test("explicit userId overrides conversation-derived owner", async () => {
    await seedUser("owner-4");
    await seedUser("explicit-5");
    const project = await createProject({ name: "ro-ovr", path: "/ovr" });
    const conv = await createConversation(project.id, { userId: "owner-4" });

    const run = makeRun({ agentName: "chat" });
    await insertRun(run, project.id, undefined, conv.id, "explicit-5");

    const own = await getRunOwnership(run.id);
    expect(own!.userId).toBe("explicit-5"); // explicit wins, no resolve
  });
});
