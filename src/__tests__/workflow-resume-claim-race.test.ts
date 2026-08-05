/**
 * There is exactly ONE way to begin driving a workflow run: winning the
 * claim CAS.
 *
 * ## The defect these tests were written against
 *
 * `answerApproval` and `resumeParkedRun` each pre-checked the run's status
 * with a read, then handed `resumeWorkflow` the row they had read
 * (`resumeArgsFromRow(runRow)`). The executor's status guard reads
 * `row.status` **off its argument**, never from the database — so the
 * check answered a question about a snapshot, not about the run.
 *
 * Between that read and the resume there is real work: a workflow lookup
 * and, for `answerApproval`, the answer CAS. The daemon wakes every ~5s
 * and claims any `suspended` run. A claim landing inside that window took
 * the row to `running` under the daemon's lease while the caller still
 * held a snapshot saying `suspended` — so the caller sailed through the
 * guard and drove a run a second process already owned. Two drivers, one
 * run, one batch executed twice: precisely the double-execution the guard
 * exists to prevent, defeated by reading the wrong copy of the state.
 *
 * ## The fix, and why it is shaped this way
 *
 * Authority is proved by re-reading state, never asserted by a caller
 * carrying a snapshot. Every resume path now does what the daemon always
 * did: win the claim CAS, RE-READ the row, resume naming itself, and hand
 * the claim back if the run comes back parked. The CAS is atomic, so of
 * any number of would-be drivers exactly one proceeds and the rest are
 * refused cleanly — without a status read deciding anything.
 *
 * The tests below inject a competing claim into the exact window, using
 * the `deps.runtime` seam so the injection lands after the caller has
 * captured its arguments. That is the race made deterministic rather than
 * hunted for with timing.
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
import type { AgentEvents, WorkflowDefinition, WorkflowRun, WorkflowStep } from "../types";
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

const { claimWorkflowRun, getWorkflowRunRow, listWorkflowStepRunRows } = await import(
  "../db/queries/workflow-runs"
);
const { getWorkflowApproval } = await import("../db/queries/workflow-approvals");
const { WorkflowExecutor, resumeClaimedRun } = await import("../runtime/workflow-executor");
const { answerApproval } = await import("../runtime/workflow-answer-approval");
const { cancelParkedRun, resumeParkedRun } = await import("../runtime/workflow-run-control");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('user-1', 'u1@example.test', 'x', 'User One')
  `);
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

/** Parks for a human, then has a step the gate is protecting. */
const approvalWorkflow: WorkflowDefinition = {
  name: "needs-a-human",
  description: "",
  steps: [
    { name: "gate", kind: "approval", prompt: "Ship it?", choices: ["approve"] } as WorkflowStep,
    { name: "after", kind: "transform", output: { done: "yes" } } as WorkflowStep,
  ],
};

/** Parks for a non-approval reason, so `resumeParkedRun` has something to
 *  legitimately continue. */
const plainWorkflow: WorkflowDefinition = {
  name: "plain-work",
  description: "",
  steps: [{ name: "only", kind: "transform", output: { v: "1" } } as WorkflowStep],
};

function realExecutor(): InstanceType<typeof WorkflowExecutor> {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
    persist: true,
  });
}

/**
 * A runtime that lets a COMPETING DAEMON try to claim the run in the
 * instant before the caller's resume runs.
 *
 * The wrapper fires after the caller has already computed its
 * `resumeWorkflow` arguments, which is exactly where the real window
 * closes — so whether the competing claim succeeds is a direct readout of
 * whether the caller had taken authority over the run before building
 * those arguments.
 */
function racingRuntime(
  executor: InstanceType<typeof WorkflowExecutor>,
  workflows: WorkflowDefinition[],
): { runtime: WorkflowRuntime; rivalWon: () => boolean } {
  let won = false;
  const runtime: WorkflowRuntime = {
    getWorkflows: () => workflows,
    workflowExecutor: {
      runWorkflow: executor.runWorkflow.bind(executor),
      resumeWorkflow: (async (
        w: WorkflowDefinition,
        row: Parameters<InstanceType<typeof WorkflowExecutor>["resumeWorkflow"]>[1],
        signal?: AbortSignal,
        opts?: { resumedBy?: string },
      ): Promise<WorkflowRun> => {
        won = await claimWorkflowRun({
          workflowRunId: row.id,
          claimedBy: "inst-RIVAL",
          now: T0,
        });
        return executor.resumeWorkflow(w, row, signal, opts);
      }) as WorkflowRuntime["workflowExecutor"]["resumeWorkflow"],
    },
  };
  return { runtime, rivalWon: () => won };
}

describe("answerApproval takes authority before it resumes", () => {
  test("a rival claim inside the window cannot be won, so there is never a second driver", async () => {
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, "user-1");
    expect(parked.status).toBe("suspended");

    const { runtime, rivalWon } = racingRuntime(wf, [approvalWorkflow]);
    const approval = await getWorkflowApproval(parked.id, "gate");
    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      { kind: "user", userId: "user-1", isAdmin: false },
      { runtime },
    );

    // THE property. The rival is the daemon arriving mid-window. It must
    // find the run already taken, because `answerApproval` claimed it
    // before it built the arguments it is now resuming with. Previously
    // the run was still `suspended` at this instant and the rival won —
    // two processes then drove the same run off the same cursor.
    expect(rivalWon()).toBe(false);

    // And the answer still lands: taking authority is not a new way to
    // fail, it is the same work done in a defensible order.
    expect(answered.ok).toBe(true);
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
    const steps = await listWorkflowStepRunRows(parked.id);
    expect(steps.filter((s) => s.stepName === "after")).toHaveLength(1);
  });

  test("losing the claim outright is a clean refusal that spends no answer", async () => {
    // The other side of the CAS: the daemon got there first. The human's
    // decision must NOT be recorded against a run this call cannot drive,
    // or the answer is spent and the approval can never be re-offered.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, "user-1");
    expect(
      await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-DAEMON", now: T0 }),
    ).toBe(true);

    const approval = await getWorkflowApproval(parked.id, "gate");
    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      { kind: "user", userId: "user-1", isAdmin: false },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );

    expect(answered.ok).toBe(false);
    expect(answered).toMatchObject({ code: "run-unavailable" });
    // Nothing spent, so the inbox can offer the decision again.
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
    // And the rival's claim is intact — this call did not steal it.
    expect((await getWorkflowRunRow(parked.id))?.claimedBy).toBe("inst-DAEMON");
  });
});

describe("resumeParkedRun takes authority before it resumes", () => {
  test("a rival claim inside the window cannot be won", async () => {
    const wf = realExecutor();
    const parked = await wf.runWorkflow(plainWorkflow, {}, undefined, "user-1");
    // A plain workflow runs straight through, so park it by hand at the
    // boundary the operator lever is for.
    await db.execute(sql`
      UPDATE workflow_runs
         SET status = 'suspended', finished_at = NULL, result = NULL,
             run_phase = 'boundary', suspended_reason = 'nested-suspended',
             cursor = ${JSON.stringify({ batchIndex: 0, completedSteps: [], prevStepName: null })}::jsonb
       WHERE id = ${parked.id}
    `);

    const { runtime, rivalWon } = racingRuntime(wf, [plainWorkflow]);
    const res = await resumeParkedRun(parked.id, { userId: "user-1" }, { runtime });

    expect(rivalWon()).toBe(false);
    expect(res.ok).toBe(true);
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
  });

  test("losing the claim outright is a clean refusal that writes nothing", async () => {
    const wf = realExecutor();
    const parked = await wf.runWorkflow(plainWorkflow, {}, undefined, "user-1");
    await db.execute(sql`
      UPDATE workflow_runs
         SET status = 'suspended', finished_at = NULL, result = NULL,
             run_phase = 'boundary', suspended_reason = 'nested-suspended',
             cursor = ${JSON.stringify({ batchIndex: 0, completedSteps: [], prevStepName: null })}::jsonb
       WHERE id = ${parked.id}
    `);
    expect(
      await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-DAEMON", now: T0 }),
    ).toBe(true);

    const res = await resumeParkedRun(parked.id, { userId: "user-1" }, { runtime: null });

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "not-resumable" });
    expect((await getWorkflowRunRow(parked.id))?.claimedBy).toBe("inst-DAEMON");
  });
});

describe("losing the claim INSIDE the window is reported honestly", () => {
  /**
   * A runtime that lets a rival claim the run from inside `getWorkflows()`.
   *
   * That thunk is called AFTER the status read and BEFORE the claim, which
   * is the real window — so this drives the branch a caller reaches when
   * its status read said `suspended` and the CAS still loses. Nothing else
   * can reach it: the status pre-check turns every already-`running` row
   * away long before the claim.
   */
  function rivalClaimsDuringLookup(
    executor: InstanceType<typeof WorkflowExecutor>,
    workflows: WorkflowDefinition[],
  ): WorkflowRuntime {
    let claimedOnce = false;
    return {
      getWorkflows: () => {
        if (!claimedOnce) {
          claimedOnce = true;
          // Fire-and-forget is not an option — the CAS must land before the
          // caller's own claim. `getWorkflows` is synchronous by contract,
          // so the claim is issued through the same PGlite FIFO queue and
          // is ahead of the caller's next statement.
          void claimWorkflowRun({
            workflowRunId: pendingRunId,
            claimedBy: "inst-RIVAL",
            now: T0,
          });
        }
        return workflows;
      },
      workflowExecutor: executor,
    };
  }
  let pendingRunId = "";

  test("answerApproval records the answer and says the run continues elsewhere", async () => {
    // Losing the claim here is HARMLESS, and that is the whole reason the
    // claim sits after the answer CAS. The decision is already durable, so
    // `hasPendingApproval` is false for whoever does hold the claim: they
    // will carry this run forward with this answer applied.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, "user-1");
    pendingRunId = parked.id;

    const approval = await getWorkflowApproval(parked.id, "gate");
    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      { kind: "user", userId: "user-1", isAdmin: false },
      { runtime: rivalClaimsDuringLookup(wf, [approvalWorkflow]) },
    );

    expect(answered.ok).toBe(false);
    // NOT `run-unavailable`: that would invite a retry for a decision that
    // is already recorded. Every surface renders `resume-failed` as
    // "recorded, but could not continue here", and the timeout sweep maps
    // it to `answered` rather than re-offering the gate.
    expect(answered).toMatchObject({ code: "resume-failed" });
    // The answer really did land, and the rival really does hold the run.
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("answered");
    const row = await getWorkflowRunRow(parked.id);
    expect(row?.claimedBy).toBe("inst-RIVAL");
    // THE assertion that makes this test about the CLAIM rather than about
    // the refusal message. Backing off on a lost CAS writes nothing, so the
    // rival's run is left exactly as it was, still running, still theirs.
    //
    // Skip the claim check and the call sails on to `resumeWorkflow` with a
    // `resumedBy` that does not match the rival's `claimed_by` — the status
    // guard then refuses TERMINALLY and writes `error` over a run somebody
    // else is actively driving. Same refusal code to the caller, a wrecked
    // run in the database.
    expect(row?.status).toBe("running");
    expect(row?.finishedAt).toBeNull();
    expect(row?.result).toBeNull();
  });

  test("resumeParkedRun refuses without writing anything", async () => {
    // No answer to spend here, so losing is a plain retryable refusal.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(plainWorkflow, {}, undefined, "user-1");
    pendingRunId = parked.id;
    await db.execute(sql`
      UPDATE workflow_runs
         SET status = 'suspended', finished_at = NULL, result = NULL,
             run_phase = 'boundary', suspended_reason = 'nested-suspended',
             cursor = ${JSON.stringify({ batchIndex: 0, completedSteps: [], prevStepName: null })}::jsonb
       WHERE id = ${parked.id}
    `);

    const res = await resumeParkedRun(
      parked.id,
      { userId: "user-1" },
      { runtime: rivalClaimsDuringLookup(wf, [plainWorkflow]) },
    );

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "not-resumable" });
    const row = await getWorkflowRunRow(parked.id);
    expect(row?.claimedBy).toBe("inst-RIVAL");
    // Same property as the sibling test: a lost CAS backs off without
    // writing, leaving the rival's live run untouched.
    expect(row?.status).toBe("running");
    expect(row?.finishedAt).toBeNull();
  });
});

describe("the re-read under the claim is what the guard actually sees", () => {
  test("a run cancelled after the claim is refused, not resumed", async () => {
    // Holding a claim is not the same as the run still wanting to run. The
    // claim proves nobody ELSE is driving it; the re-read is what proves it
    // is still alive. An operator cancelling in that window must win.
    //
    // This is the assertion that fails if `resumeClaimedRun` ever resumes
    // off the row its caller already had instead of the row it re-reads —
    // the guard consults its argument, so a stale-but-plausible
    // `suspended` sails straight through and a cancelled run keeps
    // executing.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(plainWorkflow, {}, undefined, "user-1");
    await db.execute(sql`
      UPDATE workflow_runs
         SET status = 'suspended', finished_at = NULL, result = NULL,
             run_phase = 'boundary', suspended_reason = 'nested-suspended',
             cursor = ${JSON.stringify({ batchIndex: 0, completedSteps: [], prevStepName: null })}::jsonb
       WHERE id = ${parked.id}
    `);
    // Clear the step rows the setup run wrote, so anything present at the
    // end was written by the resume under test and nothing else.
    await db.execute(sql`DELETE FROM workflow_step_runs WHERE workflow_run_id = ${parked.id}`);
    expect(
      await claimWorkflowRun({ workflowRunId: parked.id, claimedBy: "inst-A", now: T0 }),
    ).toBe(true);

    // The operator cancels between the claim and the resume.
    const cancelled = await cancelParkedRun(parked.id, { userId: "user-1" });
    expect(cancelled.ok).toBe(true);
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("cancelled");

    const run = await resumeClaimedRun(wf, plainWorkflow, parked.id, "inst-A");

    // Refused — `holdsClaim` requires the row to actually read `running`,
    // and this one reads `cancelled`.
    expect(run?.result?.error).toMatchObject({ code: "not-resumable" });
    // And the cancellation stands: no step ran, the row is still cancelled.
    expect(await listWorkflowStepRunRows(parked.id)).toHaveLength(0);
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("cancelled");
  });

  test("a run deleted after the claim comes back as an ordinary refusal", async () => {
    // Shaped like every other refusal on purpose, so no caller needs a
    // second result shape for it — the branch that would have carried is
    // one nobody could reach in a test, and an unreachable branch is one
    // nobody has checked.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(plainWorkflow, {}, undefined, "user-1");
    await db.execute(sql`DELETE FROM workflow_runs WHERE id = ${parked.id}`);

    const run = await resumeClaimedRun(wf, plainWorkflow, parked.id, "inst-A");
    expect(run.status).toBe("error");
    expect(run.result?.error).toMatchObject({ code: "not-resumable" });
  });
});

describe("a parked run's claim is handed back, not held", () => {
  test("resumeParkedRun releases its claim when the consent gate refuses it", async () => {
    // `resumeParkedRun` is deliberately not an approval-answering path: it
    // relies on `resumeWorkflow`'s TRANSIENT pending-approval refusal. That
    // refusal writes nothing, so the claim this call took must be given
    // back — otherwise the operator's "continue" would pin the run
    // `running` and lock every answer surface out of it, which is the same
    // denial of service by a different door.
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, "user-1");

    const res = await resumeParkedRun(
      parked.id,
      { userId: "user-1" },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ code: "resume-failed" });
    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("suspended");
    expect(after?.claimedBy).toBeNull();
    expect(after?.leaseExpiresAt).toBeNull();
    // Still answerable, which is the whole point.
    expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("pending");
  });
});
