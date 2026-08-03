/**
 * The approval timeout sweep — the clock's half of an `approval` step.
 *
 * Runs against real PGlite with the real `migrate()`, because the property
 * under test is **a row actually changed**. Every assertion here reads the
 * `workflow_approvals` / `workflow_runs` rows back, never merely "the sweep
 * returned". That distinction is the whole point of this file: the sweep
 * answers through `answerApproval`, which refuses an actor who is not the
 * run's owner — so a sweep with the wrong actor is REFUSED ON EVERY ROW,
 * silently, and a test asserting only that it ran would stay green forever.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import type {
  ApprovalTimeoutPolicy,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStep,
} from "../types";
import { sweepExpiredWorkflowApprovals } from "../runtime/workflow-approval-timeout-sweep";
import {
  getWorkflowApprovalById,
  parkWorkflowApproval,
} from "../db/queries/workflow-approvals";
import {
  finalizeWorkflowRunRow,
  getWorkflowRunRow,
  insertWorkflowRun,
} from "../db/queries/workflow-runs";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../runtime/workflow/runtime-registry";
import { HostMaintenanceDaemon } from "../extensions/host-maintenance-daemon";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const PAST = new Date("2026-07-31T11:00:00.000Z");
const FUTURE = new Date("2026-07-31T13:00:00.000Z");

beforeAll(async () => {
  await setupTestDb();
  await getTestDb().execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('owner', 'o@example.test', 'x', 'Owner')
  `);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Each test asserts on `scanned`, so the expired population must be
  // exactly what this test seeded.
  const db = getTestDb();
  await db.execute(sql`DELETE FROM workflow_approvals`);
  await db.execute(sql`DELETE FROM workflow_runs`);
  _resetWorkflowRuntimeForTests();
});

/** A runtime whose executor records resumes rather than performing one. */
function runtimeFor(
  step: Partial<WorkflowStep> = {},
  opts: { resumeStatus?: WorkflowRun["status"]; resumeError?: string } = {},
) {
  const resumed: string[] = [];
  const definition: WorkflowDefinition = {
    name: "gated",
    description: "",
    steps: [
      {
        name: "gate",
        kind: "approval",
        prompt: "Ship it?",
        choices: ["approve", "skip", "reject"],
        ...step,
      } as WorkflowStep,
    ],
  };
  return {
    resumed,
    definition,
    runtime: {
      workflowExecutor: {
        async runWorkflow(): Promise<WorkflowRun> {
          throw new Error("not exercised");
        },
        async resumeWorkflow(
          _w: WorkflowDefinition,
          row: { id: string },
        ): Promise<WorkflowRun> {
          resumed.push(row.id);
          const status = opts.resumeStatus ?? "success";
          const result = opts.resumeError
            ? { success: false, output: null, error: opts.resumeError }
            : undefined;
          // Write the terminal row, exactly as the real executor does on
          // its way out (`workflow-executor.ts`'s `!suspended` finalize).
          //
          // A double that returned `success` and wrote NOTHING left the row
          // wherever the caller had put it, which quietly made every
          // assertion below a statement about the double rather than about
          // the sweep. It also hid the fact that a resume now runs under a
          // CLAIM: the row is `running` from the claim until the finalize,
          // and only a faithful double closes that.
          if (status !== "suspended") {
            await finalizeWorkflowRunRow(row.id, status as "success" | "error" | "cancelled", result);
          }
          return {
            id: row.id,
            workflowName: definition.name,
            status,
            startedAt: NOW.getTime(),
            steps: [],
            ...(result ? { result } : {}),
          } as WorkflowRun;
        },
      },
      getWorkflows: () => [definition],
    },
  };
}

async function seed(
  opts: {
    expiresAt?: Date | null;
    ownerUserId?: string | null;
    rbacScope?: string | null;
    requireItemConsent?: boolean;
    itemIds?: string[];
    choices?: string[];
    runStatus?: string;
    workflowName?: string;
    stepName?: string;
  } = {},
): Promise<{ runId: string; approvalId: string }> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: opts.workflowName ?? "gated",
    input: {},
    startedAt: NOW,
    userId: opts.ownerUserId === undefined ? "owner" : opts.ownerUserId,
  });
  await db().execute(
    sql`UPDATE workflow_runs SET status = ${opts.runStatus ?? "suspended"},
        suspended_reason = 'approval' WHERE id = ${runId}`,
  );
  const approvalId = await parkWorkflowApproval({
    workflowRunId: runId,
    stepName: opts.stepName ?? "gate",
    prompt: "Ship it?",
    choices: opts.choices ?? ["approve", "skip", "reject"],
    rbacScope: opts.rbacScope ?? null,
    requireItemConsent: opts.requireItemConsent ?? false,
    itemIds: opts.itemIds ?? [],
    expiresAt: opts.expiresAt === undefined ? PAST : opts.expiresAt,
  });
  return { runId, approvalId };
}

function db() {
  return getTestDb();
}

describe("the three policies each change a ROW and a RUN", () => {
  test("abort (the default) expires the approval and cancels the run", async () => {
    const { runId, approvalId } = await seed();
    const { runtime, resumed } = runtimeFor();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res).toEqual({ scanned: 1, answered: 0, aborted: 1, deferred: 0, raced: 0 });
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("expired");
    const row = await getWorkflowRunRow(runId);
    expect(row?.status).toBe("cancelled");
    // C4 §4.4 — the trace has to say the CLOCK ended this run, not that an
    // operator cancelled it while it waited.
    expect(row?.suspendedReason).toBe("approval-timeout");
    // Abort does not resume. A cancelled run that also ran its next batch
    // would be the worst of both.
    expect(resumed).toEqual([]);
  });

  test("approve answers as approved and resumes the run", async () => {
    const { runId, approvalId } = await seed();
    const { runtime, resumed } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.answered).toBe(1);
    expect(res.aborted).toBe(0);
    const approval = await getWorkflowApprovalById(approvalId);
    expect(approval?.status).toBe("answered");
    expect(approval?.answerChoice).toBe("approve");
    // Nobody answered, so nobody is credited. An `answered_by` naming a
    // real user would put a human's name on a decision they never made.
    expect(approval?.answeredBy).toBeNull();
    expect(approval?.consentAllUsed).toBe(false);
    expect(resumed).toEqual([runId]);
    // The run was RESUMED and ran to completion — not cancelled behind its
    // back, which is what `abort` would have done. `success` (rather than
    // the `suspended` this once asserted) is the faithful double finalizing
    // the row the way the real executor does; a run left `suspended` after a
    // successful resume would mean the resume never persisted anything.
    expect((await getWorkflowRunRow(runId))?.status).toBe("success");
  });

  test("skip answers with the skip choice and resumes the run", async () => {
    const { runId, approvalId } = await seed();
    const { runtime, resumed } = runtimeFor({ onTimeout: "skip" });

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.answered).toBe(1);
    const approval = await getWorkflowApprovalById(approvalId);
    expect(approval?.status).toBe("answered");
    // The choice a downstream `$steps.gate.output.choice` will read.
    expect(approval?.answerChoice).toBe("skip");
    expect(resumed).toEqual([runId]);
  });
});

describe("the ownership check does not refuse the sweep", () => {
  // This is the interaction-class defect the whole module exists around:
  // `answerApproval` requires the run's OWNER when no `rbacScope` is
  // declared, and a run with a NULL `user_id` is admin-only. Both rules
  // are right; a sweep answering as nobody is refused by both.
  test("a run owned by a user the sweep is not still gets its policy applied", async () => {
    const { approvalId } = await seed({ ownerUserId: "owner" });
    const { runtime } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    const approval = await getWorkflowApprovalById(approvalId);
    expect(approval?.status).toBe("answered");
    expect(approval?.answerChoice).toBe("approve");
  });

  test("an UNOWNED run (CLI, extension trigger) is admin-only and still swept", async () => {
    const { approvalId } = await seed({ ownerUserId: null });
    const { runtime } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
  });
});

describe("what the clock refuses to decide", () => {
  test("a scope-gated approval is never auto-answered — it fails closed", async () => {
    // The sweep holds no permissions and is handed no `checkScope`. An
    // `rbacScope` says a HUMAN with a grant must answer.
    const { runId, approvalId } = await seed({ rbacScope: "workflows:approve" });
    const { runtime, resumed } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.aborted).toBe(1);
    expect(res.answered).toBe(0);
    const approval = await getWorkflowApprovalById(approvalId);
    expect(approval?.status).toBe("expired");
    expect(approval?.answerChoice).toBeNull();
    expect((await getWorkflowRunRow(runId))?.status).toBe("cancelled");
    expect(resumed).toEqual([]);
  });

  test("an outstanding item-consent gate is never cleared by the clock", async () => {
    const { runId, approvalId } = await seed({
      requireItemConsent: true,
      itemIds: ["a.ts", "b.ts"],
    });
    const { runtime } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.aborted).toBe(1);
    const approval = await getWorkflowApprovalById(approvalId);
    expect(approval?.status).toBe("expired");
    // Neither shape of consent laundering happened: no blanket clear, and
    // the offered list was not echoed back as though it were a decision.
    expect(approval?.consentAllUsed).toBe(false);
    expect(approval?.answeredItemIds).toBeNull();
    expect((await getWorkflowRunRow(runId))?.status).toBe("cancelled");
  });

  test("a policy name the definition never declared as a choice fails closed", async () => {
    // Rejected at definition time now, but a definition stored before that
    // rule still reaches the sweep.
    const { runId, approvalId } = await seed({ choices: ["ship", "hold"] });
    const { runtime } = runtimeFor({
      onTimeout: "approve",
      timeoutMs: 1000,
      choices: ["ship", "hold"],
    });

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.aborted).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("expired");
    expect((await getWorkflowRunRow(runId))?.status).toBe("cancelled");
  });
});

describe("what the sweep leaves alone", () => {
  test("a deadline that has not passed is not touched", async () => {
    const { runId, approvalId } = await seed({ expiresAt: FUTURE });
    const { runtime } = runtimeFor();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.scanned).toBe(0);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
    expect((await getWorkflowRunRow(runId))?.status).toBe("suspended");
  });

  test("an approval with no deadline at all is not swept", async () => {
    const { approvalId } = await seed({ expiresAt: null });
    const { runtime } = runtimeFor();

    expect((await sweepExpiredWorkflowApprovals({ now: NOW, runtime })).scanned).toBe(0);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("with NO registered runtime nothing is cancelled — the policy is unreadable", async () => {
    // A backend-only boot (CLI, pre-web-init) registers no runtime. Reading
    // that as "abort" would cancel every parked run on the host.
    const { runId, approvalId } = await seed();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime: null });

    expect(res).toEqual({ scanned: 1, answered: 0, aborted: 0, deferred: 1, raced: 0 });
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
    expect((await getWorkflowRunRow(runId))?.status).toBe("suspended");
  });

  test("a step the definition no longer declares defers rather than aborting", async () => {
    const { approvalId } = await seed({ stepName: "gate-renamed" });
    const { runtime } = runtimeFor();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.deferred).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("a run whose workflow is no longer defined defers", async () => {
    const { approvalId } = await seed({ workflowName: "deleted-workflow" });
    const { runtime } = runtimeFor();

    expect((await sweepExpiredWorkflowApprovals({ now: NOW, runtime })).deferred).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });
});

describe("races and retries", () => {
  test("a run momentarily claimed by the runner is deferred, then swept next tick", async () => {
    // `WorkflowRunner` claims a suspended run by flipping it to `running`.
    // `answerApproval` refuses a run that is not `suspended`.
    const { runId, approvalId } = await seed({ runStatus: "running" });
    const { runtime } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    const first = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });
    expect(first.deferred).toBe(1);
    // Left PENDING, which is what makes the retry possible at all.
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");

    await db().execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);
    const second = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });
    expect(second.answered).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
  });

  test("a human who answered first wins — the sweep reports a race, not an error", async () => {
    const { runId, approvalId } = await seed();
    await db().execute(
      sql`UPDATE workflow_approvals SET status = 'answered', answer_choice = 'reject',
          answered_by = 'owner' WHERE id = ${approvalId}`,
    );
    const { runtime } = runtimeFor();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    // The row is no longer pending, so it is not even scanned — and the
    // human's decision is untouched.
    expect(res.scanned).toBe(0);
    expect((await getWorkflowApprovalById(approvalId))?.answerChoice).toBe("reject");
    expect((await getWorkflowRunRow(runId))?.status).toBe("suspended");
  });

  // Two hosts sweeping the same row is the real shape of the race the CAS
  // exists for: both SELECT the pending row before either writes. Both
  // tests assert on the COMBINED tallies, because which sweep wins is
  // genuinely arbitrary — that exactly one does is the property.
  test("two sweeps racing one abort: one wins, the other reports a race", async () => {
    const { runId, approvalId } = await seed();
    const { runtime } = runtimeFor();

    const [a, b] = await Promise.all([
      sweepExpiredWorkflowApprovals({ now: NOW, runtime }),
      sweepExpiredWorkflowApprovals({ now: NOW, runtime }),
    ]);

    expect(a.scanned + b.scanned).toBe(2);
    expect(a.aborted + b.aborted).toBe(1);
    expect(a.raced + b.raced).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("expired");
    expect((await getWorkflowRunRow(runId))?.status).toBe("cancelled");
  });

  test("two sweeps racing one answer: the row is answered exactly once", async () => {
    const { runId, approvalId } = await seed();
    const { runtime, resumed } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });

    const [a, b] = await Promise.all([
      sweepExpiredWorkflowApprovals({ now: NOW, runtime }),
      sweepExpiredWorkflowApprovals({ now: NOW, runtime }),
    ]);

    expect(a.answered + b.answered).toBe(1);
    expect(a.raced + b.raced).toBe(1);
    // The loser must not have aborted the run the winner just resumed.
    expect(a.aborted + b.aborted).toBe(0);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
    expect((await getWorkflowRunRow(runId))?.status).not.toBe("cancelled");
    expect(resumed).toEqual([runId]);
  });

  test("an approval deleted mid-sweep is a race, not a crash", async () => {
    // A run deleted while the sweep is mid-pass cascades its approval
    // away. `getWorkflows()` is called in exactly that window — after the
    // pending SELECT, before the answer — so the thunk is the seam. The
    // `.then()` is what DISPATCHES the delete (drizzle's builders are
    // lazy), which puts it ahead of the sweep's next query in PGlite's
    // FIFO queue rather than leaving the order to chance.
    const { runId, approvalId } = await seed();
    const base = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });
    let deleting: Promise<unknown> = Promise.resolve();
    const runtime = {
      ...base.runtime,
      getWorkflows: () => {
        deleting = db()
          .execute(sql`DELETE FROM workflow_runs WHERE id = ${runId}`)
          .then(() => undefined);
        return [base.definition];
      },
    };

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });
    await deleting;

    expect(res.raced).toBe(1);
    expect(res.aborted).toBe(0);
    expect(await getWorkflowApprovalById(approvalId)).toBeUndefined();
    expect(base.resumed).toEqual([]);
  });

  test("an abort on an already-terminal run expires the row without a second cancel", async () => {
    const { runId, approvalId } = await seed();
    await db().execute(sql`UPDATE workflow_runs SET status = 'error' WHERE id = ${runId}`);
    const { runtime } = runtimeFor();

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.aborted).toBe(1);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("expired");
    // Never clobbers a richer terminal state.
    expect((await getWorkflowRunRow(runId))?.status).toBe("error");
  });

  test("an answer that lands but cannot resume is NOT then cancelled", async () => {
    // `resume-failed` means the decision was recorded and only the resume
    // failed. Cancelling would contradict a decision already on the row.
    const { runId, approvalId } = await seed();
    const { runtime } = runtimeFor(
      { onTimeout: "approve", timeoutMs: 1000 },
      { resumeStatus: "error", resumeError: "definition drift" },
    );

    const res = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });

    expect(res.answered).toBe(1);
    expect(res.aborted).toBe(0);
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
    expect((await getWorkflowRunRow(runId))?.status).not.toBe("cancelled");
  });
});

describe("the sweep cannot ping-pong a run between expired and re-parked", () => {
  // An `expired` row deliberately RE-PARKS when the step is re-entered
  // (`workflow-executor.ts:1494`), with a fresh `expires_at`. So a sweep
  // that expired a row WITHOUT applying a policy would hand the run back
  // to the executor to park again, forever.
  test("a second pass finds nothing to do under every policy", async () => {
    for (const policy of ["abort", "approve", "skip"] as ApprovalTimeoutPolicy[]) {
      await db().execute(sql`DELETE FROM workflow_approvals`);
      await db().execute(sql`DELETE FROM workflow_runs`);
      const { runId } = await seed();
      const { runtime } = runtimeFor({ onTimeout: policy, timeoutMs: 1000 });

      const first = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });
      expect(first.scanned).toBe(1);
      expect(first.deferred).toBe(0);

      const second = await sweepExpiredWorkflowApprovals({ now: NOW, runtime });
      expect(second.scanned).toBe(0);

      // Under `abort` the run is terminal, so the executor can never
      // re-enter the step; under the other two the row is `answered`, so
      // re-entry returns the answer instead of parking again.
      const status = (await getWorkflowRunRow(runId))?.status;
      expect(policy === "abort" ? status === "cancelled" : status !== "cancelled").toBe(true);
    }
  });
});

describe("the daemon sub-tick is actually wired", () => {
  // Three layers were built and none of them connected: the executor
  // wrote `expires_at`, the queries could read and expire it, and no
  // clock ever called them. This is the test that would have failed.
  test("one tickOnce applies the policy to a real row", async () => {
    const { runId, approvalId } = await seed();
    const { runtime } = runtimeFor({ onTimeout: "approve", timeoutMs: 1000 });
    registerWorkflowRuntime(runtime);

    const daemon = new HostMaintenanceDaemon({
      skipLockfile: true,
      // The daemon's injected clock is what the sweep selects on, so a
      // deadline is driven by `now` rather than by waiting for one.
      now: () => NOW.getTime(),
    });
    const outcome = await daemon.tickOnce();

    expect(outcome.approvalTimeouts).toEqual({
      scanned: 1,
      answered: 1,
      aborted: 0,
      deferred: 0,
      raced: 0,
    });
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
    // Resumed to completion by the policy — see the sibling assertion in
    // "approve answers as approved and resumes the run" for why this is
    // `success` rather than `suspended`.
    expect((await getWorkflowRunRow(runId))?.status).toBe("success");
  });

  test("a tick with nothing expired reports a zeroed sweep, not an error", async () => {
    await seed({ expiresAt: FUTURE });
    registerWorkflowRuntime(runtimeFor().runtime);

    const outcome = await new HostMaintenanceDaemon({
      skipLockfile: true,
      now: () => NOW.getTime(),
    }).tickOnce();

    expect(outcome.approvalTimeouts.scanned).toBe(0);
  });

  test("a sweep that throws is swallowed — the daemon survives its own tick", async () => {
    // Locked daemon invariant: "tick errors are swallowed; the next tick
    // still fires". A parked run nobody can resume must never take the
    // host's maintenance daemon down with it.
    const { approvalId } = await seed();
    registerWorkflowRuntime({
      workflowExecutor: runtimeFor().runtime.workflowExecutor,
      getWorkflows: () => {
        throw new Error("workflow cache exploded");
      },
    });

    const outcome = await new HostMaintenanceDaemon({
      skipLockfile: true,
      now: () => NOW.getTime(),
    }).tickOnce();

    expect(outcome.approvalTimeouts.scanned).toBe(0);
    // And the row is untouched, so the next tick can try again.
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });
});

test("with nothing registered the sweep falls back to the live runtime registry", async () => {
  // The daemon calls the sweep with no `runtime` at all, so the default
  // read has to work — passing one is a test seam, not the production path.
  const { runId, approvalId } = await seed();
  const { runtime, resumed } = runtimeFor({ onTimeout: "skip" });
  registerWorkflowRuntime(runtime);

  const res = await sweepExpiredWorkflowApprovals({ now: NOW });

  expect(res.answered).toBe(1);
  expect((await getWorkflowApprovalById(approvalId))?.answerChoice).toBe("skip");
  expect(resumed).toEqual([runId]);
});
