/**
 * R-3 — the resume path must read WHY a run parked, not a proxy for it.
 *
 * ## The defect
 *
 * `workflow_runs.suspended_reason` records why a run parked, and until
 * this suite nothing on any resume path read it:
 * `grep -c suspendedReason src/runtime/workflow-executor.ts` returned 0,
 * and the `row` object `resumeWorkflow` accepts
 * (`src/runtime/workflow-executor.ts:707-728`) does not even carry the
 * column.
 *
 * The single reason-ish gate that exists is
 * `hasPendingApproval(row.id)` (`workflow-executor.ts:836`), and it does
 * not ask the reason — it asks whether a `workflow_approvals` row is
 * still `pending`. Pending-ness is a PROXY for "this approval is
 * unsatisfied", and the proxy is wrong in one direction that matters:
 * an approval leaves `pending` by being **answered** (satisfied) OR by
 * being **expired** (never answered at all).
 * `expireWorkflowApproval` (`db/queries/workflow-approvals.ts:152-159`)
 * writes `expired`, and from that instant `hasPendingApproval` returns
 * false while `suspended_reason` still reads `approval`.
 *
 * So a run parked for reason `approval` becomes resumable by satisfying
 * something that is not an approval answer. That is the R-3 shape:
 * parked for X, admitted by Y.
 *
 * ## Why it is reachable, not theoretical
 *
 * The timeout sweep's `abortRun`
 * (`src/runtime/workflow-approval-timeout-sweep.ts:206-217`) does
 * exactly these two writes, IN THIS ORDER and in separate statements:
 * `expireWorkflowApproval(...)` and then `finalizeWorkflowRunRow(...,
 * "cancelled", ...)`. Between them — and permanently, if the process
 * dies there or the second write loses its CAS — the database holds a
 * run that is `suspended`, reads `suspended_reason = 'approval'`, and
 * has no pending approval.
 *
 * The daemon reaches such a run on its next tick by design:
 * `listClaimableWorkflowRuns` filters on `status='suspended'` and an
 * unheld lease ONLY, and its docstring
 * (`db/queries/workflow-runs.ts:796-799`) says filtering on `resumable`
 * "would make the daemon ignore every approval-parked run, which is the
 * entire population it exists to serve". `background-timers.ts` wakes it
 * every ~5s.
 *
 * The consequence asserted below: the step the approval guards executes,
 * with no human having answered and the approval row reading `expired`.
 *
 * ## What this suite does NOT claim
 *
 * The `quota` / `consent-stale` reasons in the C3 plan documents are NOT
 * implemented on this tree — the only `WorkflowSuspendedError` throw
 * sites are `"nested-suspended"` (`workflow-executor.ts:2151`) and
 * `"approval"` (`:2353`), the recovery sweep writes
 * `"orphaned-resumable"` (`db/queries/workflow-runs.ts:612`), and the
 * timeout sweep writes `"approval-timeout"` onto a row it is
 * terminalizing. So the spend-cap pairing is not reproducible here and
 * is not asserted.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
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

const { getWorkflowRunRow, listWorkflowStepRunRows } = await import("../db/queries/workflow-runs");
const { getWorkflowApproval, expireWorkflowApproval } = await import(
  "../db/queries/workflow-approvals"
);
const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { WorkflowRunner } = await import("../runtime/workflow-runner");

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

/** Parks for a human on its first step, then has real work to do after
 *  it. `after` is the step the consent gate protects — its presence in
 *  `workflow_step_runs` is the bypass, executed. */
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

/** Nests `approvalWorkflow`, so it parks with `nested-suspended` while
 *  its child sits on that child's own approval. */
const parentWorkflow: WorkflowDefinition = {
  name: "parent-of-a-human-gate",
  description: "",
  steps: [
    { name: "child", kind: "workflow", workflow: approvalWorkflow.name } as WorkflowStep,
    {
      name: "after-child",
      kind: "transform",
      output: { done: "yes" },
      dependsOn: ["child"],
    } as WorkflowStep,
  ],
};

/** Child run ids of a parent, in insertion order. */
async function childRunIds(parentRunId: string): Promise<string[]> {
  const rows = await db.execute(
    sql`SELECT id FROM workflow_runs WHERE parent_run_id = ${parentRunId} ORDER BY started_at`,
  );
  return (rows.rows as Array<{ id: string }>).map((r) => r.id);
}

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
): InstanceType<typeof WorkflowRunner> {
  const runtime: WorkflowRuntime = {
    getWorkflows: () => workflows,
    workflowExecutor: executor,
  };
  return new WorkflowRunner({
    skipLockfile: true,
    runtime: () => runtime,
    now: () => T0,
    instanceId: "inst-A",
  });
}

/**
 * Park a run on its approval, then EXPIRE that approval without ever
 * answering it — the exact intermediate state
 * `workflow-approval-timeout-sweep.ts:206-217` passes through, and the
 * durable state it leaves if it dies between its two writes.
 */
async function parkedWithExpiredApproval(wf: InstanceType<typeof WorkflowExecutor>) {
  const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
  expect(parked.status).toBe("suspended");

  const approval = await getWorkflowApproval(parked.id, "gate");
  expect(approval?.status).toBe("pending");
  expect(await expireWorkflowApproval(approval!.id)).toBe(1);

  // The precondition, stated: the row still says it parked for an
  // approval, and no approval is pending. Nobody answered anything.
  const row = await getWorkflowRunRow(parked.id);
  expect(row?.status).toBe("suspended");
  expect(row?.suspendedReason).toBe("approval");
  expect((await getWorkflowApproval(parked.id, "gate"))?.status).toBe("expired");

  return parked;
}

describe("R-3: a run parked for `approval` is not resumable by an approval that merely EXPIRED", () => {
  test("the daemon does not execute the step the approval guards", async () => {
    const wf = realExecutor();
    const parked = await parkedWithExpiredApproval(wf);

    const runner = daemon(wf, [approvalWorkflow]);
    await runner.tick();
    await runner.drain();

    // THE bypass, read off the step rows rather than the returned object.
    // `after` is what the human was being asked to authorize; on the
    // unfixed tree it runs, because `hasPendingApproval` answered "no
    // pending approval" and nothing asked what the run was waiting FOR.
    const steps = await listWorkflowStepRunRows(parked.id);
    expect(steps.map((s) => s.stepName)).not.toContain("after");
  });

  test("the run is left exactly as it was — suspended, unfinished, not terminalized", async () => {
    // The refusal must be TRANSIENT. `refuseTerminal` writes
    // `status="error"` (`workflow-executor.ts:761-770`), and routing a
    // healthy parked run there is the denial of service that destroyed
    // every approval-parked run for days. A run whose approval expired is
    // still the timeout sweep's to cancel, with `approval-timeout` and a
    // `cancelled` status — not this guard's to error out.
    const wf = realExecutor();
    const parked = await parkedWithExpiredApproval(wf);

    const runner = daemon(wf, [approvalWorkflow]);
    await runner.tick();
    await runner.drain();

    const after = await getWorkflowRunRow(parked.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finishedAt).toBeNull();
    // The reason survives, so the trace still says why it parked and the
    // sweep can still finish its job.
    expect(after?.suspendedReason).toBe("approval");
  });
});

describe("R-3: `nested-suspended` is re-verified the same way, by the step that parks on it", () => {
  test("a parent whose child is still parked does not advance past the nested step", async () => {
    // The other live reason, and the same shape of defence:
    // `runNestedWorkflow` re-finds the child by its idempotency key
    // (`workflow-executor.ts:1746-1749`) and `nestedOutcome`
    // (`:2143-2157`) re-throws `WorkflowSuspendedError` while that child
    // reads `suspended` or `running`. So resuming the parent cannot step
    // over a child that is itself still waiting on a human — and it does
    // NOT dispatch a second child run, which would duplicate every side
    // effect the first one already applied.
    const bus = new EventBus<AgentEvents>();
    const wf = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
      persist: true,
      workflowResolver: (name: string) =>
        name === approvalWorkflow.name ? approvalWorkflow : undefined,
    });

    const parent = await wf.runWorkflow(parentWorkflow, {}, undefined, undefined);
    expect(parent.status).toBe("suspended");
    const parentRow = await getWorkflowRunRow(parent.id);
    expect(parentRow?.suspendedReason).toBe("nested-suspended");

    // Exactly one child exists, and it is parked on its own approval.
    const childrenBefore = await childRunIds(parent.id);
    expect(childrenBefore).toHaveLength(1);

    const runner = daemon(wf, [parentWorkflow]);
    await runner.tick();
    await runner.drain();

    // The step AFTER the nested one never ran...
    const steps = await listWorkflowStepRunRows(parent.id);
    expect(steps.map((s) => s.stepName)).not.toContain("after-child");
    // ...the parent is still parked, healthy and unfinished...
    const after = await getWorkflowRunRow(parent.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finishedAt).toBeNull();
    // ...and no duplicate child was dispatched.
    expect(await childRunIds(parent.id)).toEqual(childrenBefore);
  });
});

describe("R-3: the sanctioned path is untouched — an ANSWERED approval still resumes", () => {
  test("answering the approval resumes the run and the guarded step executes", async () => {
    // The other half of the ruling. A gate that refused the answered case
    // too would be indistinguishable from deleting the resume path, and
    // every test above would still pass.
    const { answerApproval } = await import("../runtime/workflow-answer-approval");
    const wf = realExecutor();
    const parked = await wf.runWorkflow(approvalWorkflow, {}, undefined, undefined);
    const approval = await getWorkflowApproval(parked.id, "gate");

    const answered = await answerApproval(
      approval!.id,
      { choice: "approve" },
      // Unowned run, and this file is about the resume-reason gate. The
      // system actor answers it without needing a `users` row.
      { kind: "system-timeout" },
      { runtime: { getWorkflows: () => [approvalWorkflow], workflowExecutor: wf } },
    );
    expect(answered.ok).toBe(true);

    // Past the gate: the guarded step ran, because the approval was
    // genuinely satisfied.
    const steps = await listWorkflowStepRunRows(parked.id);
    expect(steps.map((s) => s.stepName)).toContain("after");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
  });
});
