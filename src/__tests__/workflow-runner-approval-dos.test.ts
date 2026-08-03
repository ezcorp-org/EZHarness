/**
 * REPRODUCTION — the runner daemon terminalizes every run it claims.
 *
 * Winning `claimWorkflowRun`'s CAS **is** the `suspended → running`
 * transition (`src/db/queries/workflow-runs.ts:800-816`), and
 * `WorkflowRunner.resume()` deliberately re-reads the row *after* claiming
 * it (`src/runtime/workflow-runner.ts:342`). So every run the daemon
 * claims arrives at `resumeWorkflow` reading `running`, and that method's
 * FIRST guard — `row.status !== "suspended"`
 * (`src/runtime/workflow-executor.ts:725-730`) — routes it to
 * `refuseTerminal`, which writes `status="error"` to the row
 * (`:706-715`). The pending-approval guard twenty lines below
 * (`:745-751`), whose whole job is to refuse TRANSIENTLY so an
 * approval-parked run stays alive and answerable, is never reached on this
 * path.
 *
 * The daemon wakes every ~5s, so an approval-parked run is destroyed
 * within one wake interval and no human is ever fast enough to answer
 * first. That is precisely the denial of service `refuseTransient`'s own
 * docblock warns about (`workflow-executor.ts:695-705`).
 *
 * ## Why this file exists next to the suites that missed it
 *
 * Neither existing test crosses the claim:
 *
 *   - `workflow-runner.test.ts:129-134` gives the daemon a FAKE executor
 *     whose `resumeWorkflow` always returns `success`, so the daemon had
 *     never been run against the real one.
 *   - `workflow-run-persistence.test.ts:2091` calls `resumeWorkflow`
 *     directly on an already-`suspended` row, so the status guard is
 *     transparent and the defect is invisible.
 *
 * Everything below drives the REAL `WorkflowExecutor` through the REAL
 * `WorkflowRunner` against a real PGlite, which is the only arrangement in
 * which the claim and the guard meet.
 *
 * These tests assert the BROKEN behaviour on purpose. They are a
 * reproduction, not a specification: when the guard is fixed they must be
 * inverted, and each one says so at the assertion.
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
import type { WorkflowRuntime } from "../runtime/workflow/runtime-registry";

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

const {
  claimWorkflowRun,
  getWorkflowRunRow,
  insertWorkflowRun,
  listClaimableWorkflowRuns,
  suspendWorkflowRun,
} = await import("../db/queries/workflow-runs");
const { getWorkflowApproval, listPendingWorkflowApprovals } = await import(
  "../db/queries/workflow-approvals"
);
const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { WorkflowRunner } = await import("../runtime/workflow-runner");
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

/** Injected `now`. Nothing here depends on the wall clock. */
const T0 = new Date("2026-08-02T12:00:00.000Z");

/** `AgentResult["error"]` is `string | { code; message }`. Narrow once. */
function errorMessage(err: string | { code: string; message: string } | undefined): string {
  return typeof err === "object" && err !== null ? err.message : String(err);
}

/** A workflow that parks for a human on its first step. */
const approvalWorkflow: WorkflowDefinition = {
  name: "needs-a-human",
  description: "",
  steps: [
    {
      name: "gate",
      kind: "approval",
      prompt: "Ship it?",
      choices: ["approve", "reject"],
    } as WorkflowStep,
  ],
};

/** The real executor, persisting — the same construction the server uses. */
function realExecutor(): InstanceType<typeof WorkflowExecutor> {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
    persist: true,
  });
}

/** The real daemon, pointed at a real executor. */
function daemon(
  executor: InstanceType<typeof WorkflowExecutor>,
  workflows: WorkflowDefinition[],
  instanceId = "inst-A",
): InstanceType<typeof WorkflowRunner> {
  const runtime: WorkflowRuntime = {
    getWorkflows: () => workflows,
    workflowExecutor: executor,
  };
  return new WorkflowRunner({
    skipLockfile: true,
    runtime: () => runtime,
    now: () => T0,
    instanceId,
  });
}

describe("the claim IS the suspended → running transition", () => {
  test("claiming a parked run moves the row to running before any resume reads it", async () => {
    // Executed rather than argued, because this single fact is what makes
    // the status guard fire on the daemon path:
    // `db/queries/workflow-runs.ts:806` sets `status: "running"` inside
    // the same UPDATE that takes the claim.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(parked.status).toBe("suspended");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("suspended");

    // An approval-parked run is CLAIMABLE. `listClaimableWorkflowRuns`
    // (`workflow-runs.ts:761-779`) filters on `status='suspended'` and an
    // unheld lease only — it does not exclude a run with a pending
    // approval, so the daemon reaches for it on the very next tick.
    const claimable = await listClaimableWorkflowRuns(T0, 10);
    expect(claimable.map((c) => c.id)).toContain(parked.id);

    expect(await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-A", now: T0 })).toBe(
      true,
    );

    const afterClaim = await getWorkflowRunRow(parked.id);
    expect(afterClaim?.status).toBe("running");
    expect(afterClaim?.claimedBy).toBe("inst-A");
  });
});

describe("REPRO: one daemon tick destroys an approval-parked run", () => {
  test("the row lands error/not-resumable and the approval can never be answered", async () => {
    const wf = realExecutor();

    // Park exactly the way a real interactive workflow does.
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(parked.status).toBe("suspended");

    const before = await getWorkflowRunRow(parked.id);
    expect(before?.status).toBe("suspended");
    expect(before?.suspendedReason).toBe("approval");
    // `resumable` is the recovery SWEEP's flag, not a health signal: a
    // normal park never sets it (`workflow-runs.ts:409-411`,
    // `schema.ts:565` defaults it false). Pinned here so nobody reads the
    // `resumable:false` on the bricked row below as the fingerprint of the
    // damage — it reads false before and after.
    expect(before?.resumable).toBe(false);
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
    // The prompt is live in the inbox at this instant.
    expect((await listPendingWorkflowApprovals()).map((a) => a.workflowRunId)).toContain(
      parked.id,
    );

    // ── One tick of the real daemon ──────────────────────────────────
    const runner = daemon(wf, [approvalWorkflow]);
    const swept = await runner.tick();
    expect(swept.claimed).toBe(1);
    await runner.drain();

    // ── THE DEFECT ───────────────────────────────────────────────────
    //
    // Read the ROW, not the returned object. A healthy, human-answerable
    // run has been terminalized by the component whose only job was to
    // continue it. When the guard is fixed these three expectations
    // invert to `suspended` / `true` / no error.
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("error");
    expect(after?.finishedAt).not.toBeNull();
    expect(after?.result?.error).toMatchObject({ code: "not-resumable" });
    // The exact string the user saw in the field.
    expect(errorMessage(after?.result?.error)).toContain("is running, not suspended");

    // The consent gate was never consulted: `hasPendingApproval` sits
    // BELOW the status guard (`workflow-executor.ts:745`), so the
    // approval is still pending on a run that can no longer use it.
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");

    // ── The user-visible dead end ────────────────────────────────────
    //
    // The prompt is still rendered by the inbox, and clicking approve is
    // now refused forever: `answerApproval` requires `suspended`
    // (`workflow-answer-approval.ts:236-241`), and nothing will ever move
    // this row back. The entry is stuck in the inbox permanently.
    expect((await listPendingWorkflowApprovals()).map((a) => a.workflowRunId)).toContain(
      parked.id,
    );
    const approval = await getWorkflowApproval(parked.id, "gate");
    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      { userId: null, isAdmin: true },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );
    expect(answered.ok).toBe(false);
    expect(answered).toMatchObject({ code: "run-unavailable" });
    expect(answered.ok === false ? answered.message : "").toContain(
      "is error, not suspended, so it cannot be resumed",
    );

    // And the answer was NOT spent — the refusal comes before the CAS —
    // so the decision is still un-taken on a run that cannot take it.
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
  });

  test("a second tick cannot recover it: the row is terminal and no longer claimable", async () => {
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    const runner = daemon(wf, [approvalWorkflow]);

    await runner.tick();
    await runner.drain();
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("error");

    // `listClaimableWorkflowRuns` only sees `suspended`, so the daemon
    // that broke the run is also structurally unable to notice or repair
    // it. This is what makes the damage permanent rather than transient.
    expect((await listClaimableWorkflowRuns(T0, 10)).map((c) => c.id)).not.toContain(parked.id);
    const second = await runner.tick();
    expect(second.claimed).toBe(0);
  });
});

describe("REPRO: the destruction is not specific to approvals", () => {
  test("a run parked for any other reason is terminalized by the same guard", async () => {
    // A run with NO approval row has nothing the transient refusal could
    // protect it with, so this isolates the status guard as the cause —
    // `nested-suspended` is the reason a parked CHILD run carries.
    await insertWorkflowRun({
      id: "no-approval-run",
      workflowName: approvalWorkflow.name,
      input: {},
      startedAt: T0,
      definitionHash: null,
    });
    expect(
      await suspendWorkflowRun("no-approval-run", {
        reason: "nested-suspended",
        cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
      }),
    ).toBe(1);
    expect(await listPendingWorkflowApprovals()).toHaveLength(0);

    const wf = realExecutor();
    const runner = daemon(wf, [approvalWorkflow]);
    await runner.tick();
    await runner.drain();

    const after = await getWorkflowRunRow("no-approval-run");
    expect(after?.status).toBe("error");
    expect(after?.result?.error).toMatchObject({ code: "not-resumable" });
    // Meaning: the daemon can resume NOTHING. Every parked run it claims
    // dies, whatever parked it.
    expect(errorMessage(after?.result?.error)).toContain("is running, not suspended");
  });
});

describe("CONTROL: the same run survives when the claim is not in the path", () => {
  test("resumeWorkflow on a still-suspended row refuses TRANSIENTLY and touches nothing", async () => {
    // The control that proves the boundary this file crosses is the
    // CLAIM, not the executor. Identical run, identical executor, one
    // difference: the row still reads `suspended`, so the status guard is
    // transparent and the pending-approval guard below it decides
    // instead — writing nothing, exactly as designed.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    const row = await getWorkflowRunRow(parked.id);
    expect(row?.status).toBe("suspended");

    const refused = await wf.resumeWorkflow(approvalWorkflow, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    expect(refused.result?.error).toMatchObject({ code: "approval-pending" });
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finishedAt).toBeNull();
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
  });
});
