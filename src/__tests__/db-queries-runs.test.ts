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
} = await import("../db/queries/runs");
const { createProject } = await import("../db/queries/projects");

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
