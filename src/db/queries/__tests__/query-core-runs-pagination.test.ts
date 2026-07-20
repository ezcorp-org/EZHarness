/**
 * query-core db-audit fix: listRuns' project-scoped path must be BOUNDED (it
 * previously returned every run for the project, unbounded, with the wide
 * input/result jsonb columns). A default cap now applies to BOTH paths and
 * limit/offset pagination is supported.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "../../../__tests__/helpers/test-pglite";
import type { AgentRun } from "../../../types";

mockDbConnection();

const { insertRun, listRuns } = await import("../runs");
const { createProject } = await import("../projects");

function makeRun(startedAt: number): AgentRun {
  return {
    id: crypto.randomUUID(),
    agentName: "writer",
    status: "running",
    startedAt,
    logs: [],
  };
}

describe("listRuns pagination (project-scoped path is bounded)", () => {
  beforeEach(async () => await setupTestDb());
  afterAll(async () => await closeTestDb());

  test("project-scoped path honours an explicit limit and orders by startedAt desc", async () => {
    const p = await createProject({ name: "rp", path: "/rp" });
    const runs = [1, 2, 3, 4, 5].map((n) => makeRun(1_000_000_000_000 + n * 1000));
    for (const r of runs) await insertRun(r, p.id, { topic: "t" });

    const page = await listRuns(p.id, undefined, { limit: 2 });
    expect(page).toHaveLength(2);
    // Most recent two, newest first.
    expect(page.map((r) => r.id)).toEqual([runs[4]!.id, runs[3]!.id]);
  });

  test("offset walks the project-scoped page window", async () => {
    const p = await createProject({ name: "rp2", path: "/rp2" });
    const runs = [1, 2, 3, 4, 5].map((n) => makeRun(1_000_000_000_000 + n * 1000));
    for (const r of runs) await insertRun(r, p.id);

    const second = await listRuns(p.id, undefined, { limit: 2, offset: 2 });
    expect(second.map((r) => r.id)).toEqual([runs[2]!.id, runs[1]!.id]);
  });

  test("unscoped path stays bounded and ordered (prior 100-cap semantics)", async () => {
    const a = makeRun(1_000_000_000_000);
    const b = makeRun(2_000_000_000_000);
    await insertRun(a);
    await insertRun(b);
    const all = await listRuns(undefined, undefined, { limit: 1 });
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(b.id);
  });
});
