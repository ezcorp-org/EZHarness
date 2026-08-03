/**
 * The data repair for runs the daemon bricked — and, just as importantly,
 * everything it must refuse to touch.
 *
 * `repairDaemonBrickedWorkflowRuns` puts back runs that the claim-race
 * defect terminalized: the daemon's claim CAS took a parked row
 * `suspended → running`, and `resumeWorkflow`'s status guard then wrote
 * `error` / `not-resumable` over a healthy run whose human prompt was
 * still pending. Only `status`, `finished_at` and `result` were
 * overwritten, so the cursor, phase, step rows and approval all survived
 * and the run genuinely can continue.
 *
 * A migration that revived a genuinely failed run would be a worse bug
 * than the one it fixes, so the negative cases here are not garnish —
 * they are half the specification. Each one changes exactly ONE field of
 * the defect's signature and asserts the row is left alone.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgentsStatic } from "../runtime/loader";
import type { AgentEvents, WorkflowDefinition, WorkflowStep } from "../types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

const { getWorkflowRunRow, insertWorkflowRun, repairDaemonBrickedWorkflowRuns } = await import(
  "../db/queries/workflow-runs"
);
const { getWorkflowApproval } = await import("../db/queries/workflow-approvals");
const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { answerApproval } = await import("../runtime/workflow-answer-approval");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM workflow_approvals`);
  await db.execute(sql`DELETE FROM workflow_step_runs`);
  await db.execute(sql`DELETE FROM workflow_runs`);
});

const T0 = new Date("2026-08-02T12:00:00.000Z");
const CURSOR = JSON.stringify({ batchIndex: 0, completedSteps: [], prevStepName: null });

const approvalWorkflow: WorkflowDefinition = {
  name: "needs-a-human",
  description: "",
  steps: [
    { name: "gate", kind: "approval", prompt: "Ship it?", choices: ["approve"] } as WorkflowStep,
    { name: "after", kind: "transform", output: { done: "yes" } } as WorkflowStep,
  ],
};

function realExecutor(): InstanceType<typeof WorkflowExecutor> {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
    persist: true,
  });
}

/**
 * A row in exactly the state the defect left behind, written directly.
 *
 * Reproducing it through the fixed code is no longer possible — that is
 * the point of the fix — so the shape is asserted here as data. Every
 * field matches what `finalizeWorkflowRunRow` wrote over the park:
 * `status`/`finished_at`/`result` clobbered, everything else surviving.
 */
async function brickedRow(
  id: string,
  overrides: {
    status?: string;
    code?: string;
    message?: string;
    runPhase?: string;
    cursor?: string | null;
    suspendedReason?: string | null;
  } = {},
): Promise<void> {
  await insertWorkflowRun({
    id,
    workflowName: approvalWorkflow.name,
    input: {},
    startedAt: T0,
    definitionHash: null,
  });
  const result = JSON.stringify({
    success: false,
    output: null,
    error: {
      code: overrides.code ?? "not-resumable",
      message: overrides.message ?? `Workflow run ${id} is running, not suspended`,
    },
  });
  await db.execute(sql`
    UPDATE workflow_runs
       SET status = ${overrides.status ?? "error"},
           finished_at = ${T0},
           result = ${result}::jsonb,
           run_phase = ${overrides.runPhase ?? "boundary"},
           cursor = ${overrides.cursor === null ? null : (overrides.cursor ?? CURSOR)}::jsonb,
           suspended_reason = ${
             overrides.suspendedReason === null ? null : (overrides.suspendedReason ?? "approval")
           },
           claimed_by = 'inst-A',
           lease_expires_at = ${new Date(T0.getTime() + 60_000)}
     WHERE id = ${id}
  `);
}

describe("a bricked run IS repaired", () => {
  test("the row goes back to suspended with its position and claim cleared", async () => {
    await brickedRow("bricked-1");

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(1);

    const row = await getWorkflowRunRow("bricked-1");
    expect(row?.status).toBe("suspended");
    expect(row?.finishedAt).toBeNull();
    expect(row?.result).toBeNull();
    // The stale claim must go, or the daemon could never pick the run up
    // again and the repair would be cosmetic.
    expect(row?.claimedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    // The position is untouched — this is a repair, not a restart.
    expect(row?.cursor).not.toBeNull();
    expect(row?.suspendedReason).toBe("approval");
  });

  test("re-running the repair is a no-op, so it is safe on every boot", async () => {
    await brickedRow("bricked-2");

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(1);
    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect((await getWorkflowRunRow("bricked-2"))?.status).toBe("suspended");
  });

  test("the repaired run's human can finally answer, end to end", async () => {
    // The whole reason the repair exists. Park a REAL run, brick it the way
    // the daemon did, repair it, then click approve and watch the workflow
    // finish past the gate it was stuck on.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    await db.execute(sql`
      UPDATE workflow_runs
         SET status = 'error', finished_at = ${T0}, claimed_by = 'inst-A',
             result = ${JSON.stringify({
               success: false,
               output: null,
               error: {
                 code: "not-resumable",
                 message: `Workflow run ${parked.id} is running, not suspended`,
               },
             })}::jsonb
       WHERE id = ${parked.id}
    `);
    // Before the repair the answer surface refuses it forever.
    const approvalId = (await getWorkflowApproval(parked.id, "gate"))!.id;
    const before = await answerApproval(
      approvalId,
      { choice: "approve" },
      // The run carries no `user_id`, and this file is about the REPAIR,
      // not about who may answer. `system-timeout` is the one actor kind
      // that answers an unowned run without a `users` row behind it —
      // which is exactly what `{ userId: null, isAdmin: true }` used to
      // mean here, now said in the type instead of implied by a null.
      { kind: "system-timeout" },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );
    expect(before.ok).toBe(false);
    expect(before.ok === false ? before.message : "").toContain("is error, not suspended");

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(1);

    const after = await answerApproval(
      approvalId,
      { choice: "approve" },
      // The run carries no `user_id`, and this file is about the REPAIR,
      // not about who may answer. `system-timeout` is the one actor kind
      // that answers an unowned run without a `users` row behind it —
      // which is exactly what `{ userId: null, isAdmin: true }` used to
      // mean here, now said in the type instead of implied by a null.
      { kind: "system-timeout" },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );
    expect(after.ok).toBe(true);
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("answered");
  });
});

describe("a legitimately-failed run is NOT repaired", () => {
  /** Read a status back, for the negative cases. */
  async function statusOf(id: string): Promise<string | undefined> {
    return (await getWorkflowRunRow(id))?.status;
  }

  test("an ordinary failed run — no not-resumable code — is left alone", async () => {
    // The single most important negative: a step threw, the run failed,
    // and an operator is entitled to see it stay failed.
    await brickedRow("real-failure", { code: "step-failed", message: "step \"a\" threw" });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("real-failure")).toBe("error");
  });

  test("a DIFFERENT terminal refusal code is left alone, message notwithstanding", async () => {
    // Differs from a bricked row in the CODE alone — every other field of
    // the signature matches, including the message. Without this the code
    // conjunct is untestable: the realistic negatives all differ in the
    // message too, so deleting `code = 'not-resumable'` changes nothing
    // any of them can see.
    //
    // `definition-changed` is a real sibling refusal from the same
    // `refuseTerminal`, and it is genuinely not resumable: the graph moved
    // under the run, so its recorded position no longer names the same
    // steps. Reviving one would resume against a definition nobody
    // authorized. The code is what keeps that true if the message is ever
    // reworded.
    await brickedRow("drifted", { code: "definition-changed" });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("drifted")).toBe("error");
  });

  test("a run refused because it was genuinely TERMINAL is left alone", async () => {
    // The same guard correctly refuses a resume aimed at a run that had
    // already succeeded or been cancelled. Those refusals carry the same
    // `not-resumable` code, and the MESSAGE is the only thing that tells
    // them apart — which is why the message is part of the selection.
    await brickedRow("already-cancelled", {
      message: "Workflow run already-cancelled is cancelled, not suspended",
    });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("already-cancelled")).toBe("error");
  });

  test("an IN-BATCH run is left alone — a restart cannot re-enter a half-run step", async () => {
    // The safety conjunct. `in-batch` means an LLM call or a side-effecting
    // tool dispatch may be half-applied; returning it to `suspended` would
    // invite a second process to re-execute it. Same judgement the recovery
    // sweep makes.
    await brickedRow("mid-batch", { runPhase: "in-batch" });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("mid-batch")).toBe("error");
  });

  test("a run with no cursor is left alone — there is no position to resume from", async () => {
    await brickedRow("no-cursor", { cursor: null });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("no-cursor")).toBe("error");
  });

  test("a run that never parked is left alone", async () => {
    await brickedRow("never-parked", { suspendedReason: null });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("never-parked")).toBe("error");
  });

  test("a healthy run in any other status is untouched", async () => {
    // Belt and braces: the repair only ever considers `error` rows, so a
    // successful or still-parked run cannot be dragged backwards even if
    // it somehow carried a matching result payload.
    await brickedRow("succeeded", { status: "success" });
    await brickedRow("still-parked", { status: "suspended" });

    expect(await repairDaemonBrickedWorkflowRuns(db)).toBe(0);
    expect(await statusOf("succeeded")).toBe("success");
    expect(await statusOf("still-parked")).toBe("suspended");
  });
});
