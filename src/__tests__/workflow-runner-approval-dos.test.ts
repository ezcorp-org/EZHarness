/**
 * The runner daemon must RESUME the runs it claims, never terminalize them.
 *
 * ## The defect these tests were written against
 *
 * Winning `claimWorkflowRun`'s CAS **is** the `suspended → running`
 * transition (`src/db/queries/workflow-runs.ts:805`), and
 * `WorkflowRunner.resume()` deliberately re-reads the row *after* claiming
 * it (`src/runtime/workflow-runner.ts:351`). So every run the daemon
 * claimed arrived at `resumeWorkflow` reading `running`, and that method's
 * first guard — then a bare `row.status !== "suspended"` — routed it to
 * `refuseTerminal`, which writes `status="error"` to the row. The
 * pending-approval guard twenty lines below, whose whole job is to refuse
 * TRANSIENTLY so an approval-parked run stays alive and answerable, was
 * never reached on this path.
 *
 * The daemon wakes every ~5s and is on by default
 * (`src/startup/background-timers.ts:265`), so an approval-parked run was
 * destroyed within one wake interval and no human was ever fast enough to
 * answer first — exactly the denial of service `refuseTransient`'s own
 * docblock warns about. The run then read `error`, and `answerApproval`
 * refused it forever with "is error, not suspended, so it cannot be
 * resumed".
 *
 * ## Why this file exists next to the suites that missed it
 *
 * Neither pre-existing test crossed the claim:
 *
 *   - `workflow-runner.test.ts` gave the daemon a FAKE executor whose
 *     `resumeWorkflow` always returned `success`, so the daemon had never
 *     been run against the real one.
 *   - `workflow-run-persistence.test.ts` called `resumeWorkflow` directly
 *     on an already-`suspended` row, so the status guard was transparent
 *     and the defect invisible.
 *
 * Everything below drives the REAL `WorkflowExecutor` through the REAL
 * `WorkflowRunner` against a real PGlite, which is the only arrangement in
 * which the claim and the guard meet. The security half — that the guard
 * still refuses every caller it was ever aimed at — is asserted here too,
 * because a fix that bought liveness by weakening the consent boundary
 * would pass the liveness tests alone.
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
  listWorkflowStepRunRows,
  suspendWorkflowRun,
} = await import("../db/queries/workflow-runs");
const { getWorkflowApproval, listPendingWorkflowApprovals } = await import(
  "../db/queries/workflow-approvals"
);
const { WorkflowExecutor, resumeArgsFromRow } = await import("../runtime/workflow-executor");
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

/** Parks for a human on its first step, then has real work to do after it. */
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
    { name: "after", kind: "transform", output: { done: "yes" } } as WorkflowStep,
  ],
};

/** No approval anywhere — for the parked-for-another-reason case. */
const plainWorkflow: WorkflowDefinition = {
  name: "plain-work",
  description: "",
  steps: [{ name: "only", kind: "transform", output: { v: "1" } } as WorkflowStep],
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
    // Executed rather than argued, because this single fact is what made
    // the status guard fire on the daemon path at all:
    // `db/queries/workflow-runs.ts:805` sets `status: "running"` inside
    // the same UPDATE that takes the claim. Any change that separates the
    // two invalidates the reasoning behind the guard's `holdsClaim` arm.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(parked.status).toBe("suspended");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("suspended");

    // An approval-parked run is CLAIMABLE. `listClaimableWorkflowRuns`
    // filters on `status='suspended'` and an unheld lease only — it does
    // not exclude a run with a pending approval, so the daemon reaches for
    // it on the very next tick. That is by design and stays true.
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

describe("a daemon tick leaves an approval-parked run alive and answerable", () => {
  test("the run stays suspended — the tick does not terminalize it", async () => {
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);

    const before = await getWorkflowRunRow(parked.id);
    expect(before?.status).toBe("suspended");
    expect(before?.suspendedReason).toBe("approval");
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");

    const runner = daemon(wf, [approvalWorkflow]);
    const swept = await runner.tick();
    expect(swept.claimed).toBe(1);
    await runner.drain();

    // THE property, read off the ROW rather than the returned object —
    // the absence of exactly this assertion is what let the defect ship.
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finishedAt).toBeNull();
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
  });

  test("the consent gate is REACHED on the daemon path and refuses transiently", async () => {
    // The chokepoint was previously unreachable here: the status guard
    // fired first and destroyed the run before `hasPendingApproval` could
    // speak. Now it is reached — and it still says no, so the daemon
    // cannot step over the gate it is waiting on.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);

    const runner = daemon(wf, [approvalWorkflow]);
    await runner.tick();
    await runner.drain();

    // Nothing past the gate ran. `after` is the step the approval guards,
    // and a daemon that had resumed straight through would have executed
    // it without any human ever answering.
    const steps = await listWorkflowStepRunRows(parked.id);
    expect(steps.map((s) => s.stepName)).not.toContain("after");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("suspended");
  });

  test("the claim is handed back, so the run is immediately claimable again", async () => {
    // The second half of the fix, and it is not cosmetic. A transient
    // refusal writes nothing, so without an explicit release the row would
    // sit at `running` under this instance's claim — and
    // `renewWorkflowRunLeases` (`workflow-runs.ts:836-838`) renews
    // `claimed_by = me AND status = 'running'` every 20s unconditionally,
    // so the lease would never expire while the daemon lived. That trades
    // a permanent `error` for a permanent `running`, which
    // `answerApproval` refuses just as hard.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);

    const runner = daemon(wf, [approvalWorkflow]);
    await runner.tick();
    await runner.drain();

    const after = await getWorkflowRunRow(parked.id);
    expect(after?.claimedBy).toBeNull();
    expect(after?.leaseExpiresAt).toBeNull();
    expect((await listClaimableWorkflowRuns(T0, 10)).map((c) => c.id)).toContain(parked.id);
  });

  test("the human can still answer after the daemon has ticked over it repeatedly", async () => {
    // The end-to-end user story from the field report: park, let the
    // daemon sweep it several times, then click approve. Previously the
    // first tick bricked the run and this returned
    // "is error, not suspended, so it cannot be resumed" forever.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);

    const runner = daemon(wf, [approvalWorkflow]);
    for (let i = 0; i < 3; i++) {
      await runner.tick();
      await runner.drain();
    }
    expect((await listPendingWorkflowApprovals()).map((a) => a.workflowRunId)).toContain(parked.id);

    const approval = await getWorkflowApproval(parked.id, "gate");
    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      // Unowned run; this file is about the DoS window, not authorization.
      { kind: "system-timeout" },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );

    expect(answered.ok).toBe(true);
    expect(answered.ok === true ? answered.run.status : "").toBe("success");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("answered");
  });
});

describe("a run parked for a reason other than an approval resumes too", () => {
  test("a nested-suspended run is carried to completion, not terminalized", async () => {
    // A run with NO approval row has nothing the transient refusal could
    // protect it with, so this isolates the status guard: before the fix
    // the daemon could resume NOTHING AT ALL, whatever parked it.
    // `nested-suspended` is the reason a parked child run carries
    // (`workflow-executor.ts:2055`).
    await insertWorkflowRun({
      id: "no-approval-run",
      workflowName: plainWorkflow.name,
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
    const runner = daemon(wf, [plainWorkflow]);
    await runner.tick();
    await runner.drain();

    const after = await getWorkflowRunRow("no-approval-run");
    expect(after?.status).toBe("success");
    expect(after?.result?.error).toBeUndefined();
  });
});

describe("the status guard keeps its full force against every other caller", () => {
  test("a caller naming NO instance is still refused terminally on a claimed run", async () => {
    // The security half. `resumeWorkflow` is exported; the guard exists so
    // no caller can drive a run another process owns. Naming nothing must
    // still be refused, or the fix would have bought liveness by deleting
    // the double-execution guard.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-A", now: T0 })).toBe(
      true,
    );
    const row = await getWorkflowRunRow(parked.id);
    expect(row?.status).toBe("running");

    const refused = await wf.resumeWorkflow(approvalWorkflow, resumeArgsFromRow(row!));

    expect(refused.result?.error).toMatchObject({ code: "not-resumable" });
    expect(errorMessage(refused.result?.error)).toContain("is running, not suspended");
  });

  test("a caller naming the WRONG instance is still refused", async () => {
    // `resumedBy` is CHECKED against the row's `claimed_by`, never
    // trusted. An identity that does not hold the lease proves nothing,
    // so asserting one must not be enough.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-A", now: T0 })).toBe(
      true,
    );
    const row = await getWorkflowRunRow(parked.id);

    const refused = await wf.resumeWorkflow(approvalWorkflow, resumeArgsFromRow(row!), undefined, {
      resumedBy: "inst-IMPOSTOR",
    });

    expect(refused.result?.error).toMatchObject({ code: "not-resumable" });
    expect(errorMessage(refused.result?.error)).toContain("is running, not suspended");
  });

  test("the claim holder gets through the status guard and lands on the consent gate", async () => {
    // The positive case, stated separately from the daemon tests so the
    // guard's own behaviour is pinned independently of the runner: the
    // right identity passes the STATUS question and is then refused by the
    // CONSENT question — transiently, writing nothing.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    expect(await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-A", now: T0 })).toBe(
      true,
    );
    const row = await getWorkflowRunRow(parked.id);

    const refused = await wf.resumeWorkflow(approvalWorkflow, resumeArgsFromRow(row!), undefined, {
      resumedBy: "inst-A",
    });

    // `approval-pending`, NOT `not-resumable` — the difference between the
    // two codes is the entire fix.
    expect(refused.result?.error).toMatchObject({ code: "approval-pending" });
    expect(refused.status).toBe("suspended");
    // Transient means the row is untouched: still `running` under the
    // claim, because refuseTransient writes nothing. Releasing it is the
    // daemon's job, asserted separately above.
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("running");
    expect(after?.finishedAt).toBeNull();
  });
});

describe("CONTROL: an unclaimed suspended row behaves exactly as it always did", () => {
  test("resumeWorkflow on a still-suspended row refuses TRANSIENTLY and touches nothing", async () => {
    // The path the fix must not have changed at all: no claim, no
    // `resumedBy`, status reads `suspended`, so the status guard is
    // transparent and the pending-approval guard decides — writing
    // nothing, exactly as designed.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    const row = await getWorkflowRunRow(parked.id);
    expect(row?.status).toBe("suspended");

    const refused = await wf.resumeWorkflow(approvalWorkflow, resumeArgsFromRow(row!));

    expect(refused.result?.error).toMatchObject({ code: "approval-pending" });
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finishedAt).toBeNull();
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
  });
});
