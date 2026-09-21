/**
 * A unique-key conflict on `workflow_runs.idempotency_key` is a CONCURRENT
 * START, never a durability failure — in every namespace.
 *
 * C10 asks stage 2b for "discrimination of a unique-key conflict from a
 * persistence failure in the executor's catch". The landed discrimination was
 * gated on the `factory:` prefix, so a `nested:` conflict still reported
 * `run-persistence-failed`: a message that says the row was not confirmed
 * when a row with that exact key demonstrably exists. Two things had to
 * change for the `nested:` case to work at all, and this file pins both.
 *
 * 1. The gate. `usesFactoryKey && isUniqueViolation(error)` became
 *    `idempotencyKey !== undefined && isUniqueViolation(violation)`.
 * 2. The envelope. An extension-sourced start writes through
 *    `persistCritical`, which wraps the driver error in a
 *    `WorkflowCursorWriteError`. `isUniqueViolation` looks exactly one level
 *    down from what it is handed, and drizzle already spends that level, so
 *    the SQLSTATE was out of reach until the executor unwrapped its own
 *    envelope.
 *
 * The release-authority check in front of that path is replaced by a
 * controlled fault, and only that one: it is a live-delegation question this
 * test is not about, and leaving it in place would mean the catch is never
 * reached at all.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgentsStatic } from "../runtime/loader";
import { isUniqueViolation } from "../db/unique-violation";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { AgentEvents, WorkflowDefinition } from "../types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (statement: string, params: (string | null)[] = []) => pglite.query(statement, params),
}));

const releaseAssets = await import("../runtime/workflow-release-assets");
mock.module("../runtime/workflow-release-assets", () => ({
  ...releaseAssets,
  // The controlled fault, and the only one. An extension-sourced start is
  // otherwise refused before it can reach the insert this test is about.
  workflowReleaseCanExecute: async () => true,
}));

const { WorkflowExecutor, WorkflowCursorWriteError, nestedRunKey } = await import("../runtime/workflow-executor");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");

/** Extension-sourced, because only that path writes through `persistCritical`. */
const definition: WorkflowDefinition = {
  name: "reporting:child",
  description: "an extension-sourced nested child",
  steps: [{ name: "emit", kind: "transform", output: { state: "done" } }],
};

function makeExecutor(): InstanceType<typeof WorkflowExecutor> {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, { persist: true });
}

describe("a nested-key conflict is a concurrent start, not a lost row", () => {
  beforeAll(async () => {
    pglite = await PGlite.create({ extensions: { vector, pg_trgm } });
    db = drizzle(pglite, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('nested-user','nested-conflict@example.test','x','Nested','admin')`);
  });

  // The release-authority stub must not outlive this file: a leaked one would
  // grant authority to every later test in the pool.
  afterAll(async () => { restoreModuleMocks(); await pglite?.close(); });

  test("the envelope hides the SQLSTATE, which is why the executor unwraps it", async () => {
    const key = nestedRunKey(crypto.randomUUID(), "child", 0);
    const shared = { workflowName: definition.name, input: {}, startedAt: new Date(), idempotencyKey: key };
    await insertWorkflowRun({ id: crypto.randomUUID(), ...shared });
    const driverError = await insertWorkflowRun({ id: crypto.randomUUID(), ...shared }).then(() => null, (error: unknown) => error);

    expect(driverError).not.toBeNull();
    expect(isUniqueViolation(driverError)).toBe(true);
    const wrapped = new WorkflowCursorWriteError("insert", driverError);
    expect(isUniqueViolation(wrapped)).toBe(false);
    expect(isUniqueViolation(wrapped.cause)).toBe(true);
  });

  test("a second start on the same nested key returns the first run rather than refusing", async () => {
    const parentRunId = crypto.randomUUID();
    const key = nestedRunKey(parentRunId, "child", 0);
    const input = { topic: "quarterly" };
    const firstId = crypto.randomUUID();
    await insertWorkflowRun({
      id: firstId,
      workflowName: definition.name,
      input,
      userId: "nested-user",
      startedAt: new Date(Date.now() - 5_000),
      idempotencyKey: key,
      parentRunId: null,
    });
    // The pre-insert lookup is gated on the factory namespace, so the second
    // start really does reach the INSERT and really does trip the index.
    const executor = makeExecutor();
    const second = await executor.runWorkflow(definition, input, undefined, "nested-user", undefined, { idempotencyKey: key });

    expect(second.id).toBe(firstId);
    expect(second.result?.error).toBeUndefined();
    const stored = await db.execute(sql`SELECT id FROM workflow_runs WHERE workflow_name=${definition.name} AND idempotency_key=${key}`);
    expect((stored as unknown as { rows: { id: string }[] }).rows.map(row => row.id)).toEqual([firstId]);
  });

  test("a nested key whose input disagrees is still an idempotency conflict", async () => {
    const key = nestedRunKey(crypto.randomUUID(), "child", 1);
    await insertWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: definition.name,
      input: { topic: "first" },
      userId: "nested-user",
      startedAt: new Date(),
      idempotencyKey: key,
    });
    const executor = makeExecutor();

    await expect(executor.runWorkflow(definition, { topic: "second" }, undefined, "nested-user", undefined, { idempotencyKey: key }))
      .rejects.toMatchObject({ name: "WorkflowIdempotencyConflictError", code: "idempotency_conflict" });
  });

  test("a persistence failure that is NOT a conflict still refuses, so the unwrap widened nothing", async () => {
    const executor = makeExecutor();
    const run = await executor.runWorkflow(
      definition,
      {},
      `missing-project-${crypto.randomUUID()}`,
      "nested-user",
      undefined,
      { idempotencyKey: nestedRunKey(crypto.randomUUID(), "child", 2) },
    );

    expect(run.result).toMatchObject({ success: false, error: { code: "run-persistence-failed" } });
  });
});
