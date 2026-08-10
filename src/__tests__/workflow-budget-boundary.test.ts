/**
 * C3 phase B — the step-boundary token ceiling for a DELEGATED run.
 *
 * Three things are under test and only the first is obvious:
 *
 *   1. the ceiling refuses, and refuses by SUSPENDING — `status`,
 *      `suspended_reason`, a NULL `finished_at`, a released claim, and no
 *      `workflow:approval_request`;
 *   2. the CURSOR it parks against is the NEXT batch, so a resume does not
 *      re-execute the batch that just completed. Asserted on the persisted
 *      cursor AND on the agent-invocation count, because the two fail
 *      independently;
 *   3. a run with NO delegation takes ZERO extra queries — asserted with a
 *      SQL-level spy on the PGlite instance, paired against a delegated run
 *      that does take them, so the spy is proved to be capable of seeing
 *      what it claims is absent.
 *
 * Driven end to end against real PGlite and the real `migrate()` with a
 * scripted `AgentExecutor`, for the same reason `workflow-step-telemetry`
 * is: every property here is a PLUMBING property spanning the executor, two
 * tables and the resume table, and a unit test of any one hop passes with
 * the chain broken.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun, WorkflowDefinition } from "../types";
import type { AgentExecutor } from "../runtime/executor";

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
  getWorkflowRunRow,
  insertWorkflowRun,
  readWorkflowRunDelegationBudget,
  sumWorkflowRunTokens,
  upsertWorkflowStepRun,
} = await import("../db/queries/workflow-runs");
const { listWorkflowStepIterations } = await import("../db/queries/workflow-step-iterations");
const { WorkflowExecutor, resumeArgsFromRow } = await import("../runtime/workflow-executor");
const { resumeReasonRefusal } = await import("../runtime/workflow-resume-reasons");
const { getWorkflowRunTrace } = await import("../runtime/workflow-run-trace");
const { parkWorkflowApproval, recordWorkflowApprovalAnswer } = await import(
  "../db/queries/workflow-approvals"
);

/**
 * Let the executor's fire-and-forget step writes land.
 *
 * `persistStep()` is `void this.persistWrite(...)` by design — awaiting it
 * inside a step body would turn `$prev` into a per-step value. A delegated
 * run's BOUNDARY drains those handles itself (that is the point of
 * `pendingStepWrites`), but a test reading after a non-delegated run, or
 * after the final batch of any run, is still racing them.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

// ── The SQL spy ──────────────────────────────────────────────────────
//
// Installed once, on the PGlite instance itself, so it sees the statements
// drizzle actually issues rather than the calls a mocked query module would
// have received. `recording` is off by default: a spy that is always on
// would make every test in this file pay for the array.
const seenSql: string[] = [];
let recording = false;

/**
 * Delay every `workflow_step_runs` INSERT by a few macrotasks.
 *
 * PGlite runs one connection and serializes, so a fire-and-forget write
 * issued before an awaited read has always landed by the time the read
 * runs — which makes the boundary's drain of `pendingStepWrites`
 * unobservable here, and it stays unobservable however many assertions are
 * added. It is NOT unobservable in production: `DATABASE_URL` Postgres
 * goes through a `Bun.sql` POOL, where an unawaited INSERT can still be in
 * flight on one connection while the boundary's SELECT runs on another.
 *
 * This reproduces that ordering rather than arguing about it. Without the
 * drain the ceiling reads a total one batch stale and the run overshoots
 * its cap by a whole batch.
 */
let stallStepWrites = false;

type Rows<T> = { rows: T[] };
type CursorValue = { batchIndex: number; completedSteps: string[]; prevStepName: string | null };
type ParkedRow = {
  status: string;
  suspended_reason: string | null;
  finished_at: Date | null;
  run_phase: string;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  cursor: CursorValue | null;
  result: { error?: { code?: string } } | null;
};

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;

  const origQuery = pglite.query.bind(pglite);
  const origExec = pglite.exec.bind(pglite);
  // Cast through `unknown`: the overloads on `query`/`exec` are generic and
  // a faithful re-declaration would be a copy of PGlite's own types.
  (pglite as unknown as { query: unknown }).query = (...args: unknown[]) => {
    const text = String(args[0]);
    if (recording) seenSql.push(text);
    if (stallStepWrites && /insert\s+into\s+"workflow_step_runs"/i.test(text)) {
      return (async () => {
        for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
        return (origQuery as (...a: unknown[]) => unknown)(...args);
      })();
    }
    return (origQuery as (...a: unknown[]) => unknown)(...args);
  };
  (pglite as unknown as { exec: unknown }).exec = (...args: unknown[]) => {
    if (recording) seenSql.push(String(args[0]));
    return (origExec as (...a: unknown[]) => unknown)(...args);
  };

  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES ('u-consent', 'consent@budget.test', 'h', 'Consenter', 'admin', 'active')
  `);
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES ('e-budget', 'budget-ext', '1.0.0', '{}'::jsonb, 'local')
  `);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

/** Insert a live delegation and return its id. */
async function makeDelegation(opts: {
  maxTokensPerRun: number;
  revoked?: boolean;
  enabled?: boolean;
  consentedAt?: string;
}): Promise<string> {
  const id = `d-${crypto.randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO workflow_delegations (
      id, extension_id, job_ref, owner_kind, owner_user_id, workflow_name,
      trigger_kind, consent_hash, max_tokens_per_run, max_runs_per_day,
      consented_by_user_id, enabled, revoked_at, consented_at
    ) VALUES (
      ${id}, 'e-budget', ${`job-${id}`}, 'user', 'u-consent', 'nightly',
      'cron', 'hash-1', ${opts.maxTokensPerRun}, 10,
      'u-consent', ${opts.enabled ?? true},
      ${opts.revoked === true ? sql`NOW()` : null},
      ${opts.consentedAt !== undefined ? sql`${opts.consentedAt}::timestamptz` : sql`NOW()`}
    )
  `);
  return id;
}

/** One scripted agent outcome per invocation, consumed in order. */
interface ScriptedRun {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A `WorkflowExecutor` whose agent invocations are scripted, plus the
 * counters the tests assert on.
 *
 * `invocations()` is the re-execution detector: a resume that wrongly
 * re-enters a completed batch calls the agent again, and no cursor
 * assertion alone would notice.
 */
function scriptedExecutor(
  script: ScriptedRun[],
  /** Run something between agent invocations — the only deterministic
   *  interleave point a test has for "the world changed mid-run". */
  onInvocation?: (n: number) => Promise<void>,
) {
  const bus = new EventBus<AgentEvents>();
  const events: Array<{ name: string; payload: unknown }> = [];
  for (const name of [
    "workflow:error",
    "workflow:approval_request",
    "workflow:complete",
  ] as const) {
    bus.on(name, (payload) => {
      events.push({ name, payload });
    });
  }
  let i = 0;
  const agentExec = {
    cancelRun() {},
    async runAgent(): Promise<AgentRun> {
      const s = script[Math.min(i, script.length - 1)] ?? {};
      i++;
      if (onInvocation) await onInvocation(i);
      const runId = crypto.randomUUID();
      // `workflow_step_runs.run_id` is a real FK, and the persistence
      // contract never throws — so without a real `runs` row every step
      // write would be silently dropped and the columns under test would
      // read NULL for the wrong reason.
      await db.execute(sql`
        INSERT INTO runs (id, agent_name, status, started_at)
        VALUES (${runId}, 'stub', 'success', NOW())
      `);
      const run: AgentRun = {
        id: runId,
        agentName: "stub",
        status: "success",
        startedAt: Date.now(),
        logs: [],
        result: { success: true, output: "ok" },
      };
      if (s.inputTokens !== undefined) run.inputTokens = s.inputTokens;
      if (s.outputTokens !== undefined) run.outputTokens = s.outputTokens;
      return run;
    },
  } as unknown as AgentExecutor;
  const wf = new WorkflowExecutor(agentExec, bus, { persist: true });
  return { wf, bus, events, invocations: () => i };
}

/** An n-step chain — one step per batch, so every boundary is a real one. */
function chain(name: string, n = 3): WorkflowDefinition {
  return {
    name,
    description: "",
    steps: Array.from({ length: n }, (_unused, i) => ({
      name: `s${i + 1}`,
      agent: "stub",
      ...(i === 0 ? {} : { dependsOn: [`s${i}`] }),
    })),
  };
}

/** The parked row, read raw so the assertions are about COLUMNS. */
async function parkedRow(runId: string): Promise<ParkedRow | undefined> {
  const res = (await db.execute(sql`
    SELECT status, suspended_reason, finished_at, run_phase, claimed_by,
           lease_expires_at, cursor, result
      FROM workflow_runs WHERE id = ${runId}
  `)) as Rows<ParkedRow>;
  return res.rows[0];
}

// ───────────────────────────────────────────────────────────────────
// The aggregate
// ───────────────────────────────────────────────────────────────────
describe("sumWorkflowRunTokens", () => {
  test("sums input + output across step rows, counting a partially-reported step", async () => {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({ id: runId, workflowName: "sum-1", input: {}, startedAt: new Date() });
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "a",
      runId: "",
      status: "success",
      inputTokens: 10,
      outputTokens: 5,
    });
    // Only one column reported. The other must contribute 0 rather than
    // discarding the whole row — a ceiling that ignores half-reported
    // usage under-counts exactly where a provider is flaky.
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "b",
      runId: "",
      status: "success",
      inputTokens: 7,
    });
    // Reported nothing at all: a tool/transform/gate step.
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "c",
      runId: "",
      status: "success",
    });

    expect(await sumWorkflowRunTokens(runId)).toBe(22);
  });

  test("returns 0 — not null — for a run with no step rows", async () => {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({ id: runId, workflowName: "sum-2", input: {}, startedAt: new Date() });
    expect(await sumWorkflowRunTokens(runId)).toBe(0);
  });

  test("counts only the run it was asked about", async () => {
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    await insertWorkflowRun({ id: mine, workflowName: "sum-3", input: {}, startedAt: new Date() });
    await insertWorkflowRun({
      id: theirs,
      workflowName: "sum-3",
      input: {},
      startedAt: new Date(),
    });
    await upsertWorkflowStepRun({
      workflowRunId: mine,
      stepName: "a",
      runId: "",
      status: "success",
      inputTokens: 1,
      outputTokens: 1,
    });
    await upsertWorkflowStepRun({
      workflowRunId: theirs,
      stepName: "a",
      runId: "",
      status: "success",
      inputTokens: 900,
      outputTokens: 900,
    });
    expect(await sumWorkflowRunTokens(mine)).toBe(2);
  });

  test("a LOOPED agent step is counted once, not once per iteration", async () => {
    // The single most likely way to get this wrong. `runLoop` accumulates
    // each iteration onto the PARENT step row with `+=` and ALSO writes a
    // per-iteration child row, so the two tables are a rollup and its
    // detail. Summing both double-counts every looped step.
    const { wf } = scriptedExecutor([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-loop-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "revise", agent: "stub", loop: { maxIterations: 3 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();

    // The detail rows exist and carry the SAME 66 tokens, which is what
    // makes the double-count reachable rather than hypothetical.
    const iters = await listWorkflowStepIterations(run.id);
    const iterTotal = iters.reduce((a, r) => a + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0);
    expect(iters).toHaveLength(3);
    expect(iterTotal).toBe(66);
    expect(await sumWorkflowRunTokens(run.id)).toBe(66);
  });

  test("agrees with the trace's read-time totals for the same run", async () => {
    // The one thing §9.2 forbids outright: a second aggregation that
    // disagrees with the trace about the same run.
    const { wf } = scriptedExecutor([
      { inputTokens: 90, outputTokens: 10 },
      { inputTokens: 40, outputTokens: 4 },
      { inputTokens: 1, outputTokens: 1 },
    ]);
    const def = chain(`wf-agree-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {});
    await settle();

    const trace = await getWorkflowRunTrace(run.id, { userId: "u-consent", isAdmin: true });
    const traceTotal = (trace?.totals.inputTokens ?? 0) + (trace?.totals.outputTokens ?? 0);
    expect(traceTotal).toBe(146);
    expect(await sumWorkflowRunTokens(run.id)).toBe(traceTotal);
  });
});

// ───────────────────────────────────────────────────────────────────
// The budget read
// ───────────────────────────────────────────────────────────────────
describe("readWorkflowRunDelegationBudget", () => {
  test("null for a run with no delegation, and for a run that does not exist", async () => {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({ id: runId, workflowName: "bud-1", input: {}, startedAt: new Date() });
    expect(await readWorkflowRunDelegationBudget(runId)).toBeNull();
    expect(await readWorkflowRunDelegationBudget(crypto.randomUUID())).toBeNull();
  });

  test("carries the cap, the liveness and both timestamps for a delegated run", async () => {
    const delegationId = await makeDelegation({ maxTokensPerRun: 4242 });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "bud-2",
      input: {},
      startedAt: new Date(),
      delegationId,
    });
    const budget = await readWorkflowRunDelegationBudget(runId);
    expect(budget?.delegationId).toBe(delegationId);
    expect(budget?.maxTokensPerRun).toBe(4242);
    expect(budget?.live).toBe(true);
    expect(budget?.consentedAt).toBeInstanceOf(Date);
    expect(budget?.runStartedAt).toBeInstanceOf(Date);
  });

  test("a revoked or disabled delegation reads as NOT live, rather than vanishing", async () => {
    // Surfaced rather than filtered: the resume rules have to tell
    // "revoked" from "never had one", and both fail closed for different
    // reasons.
    const revoked = await makeDelegation({ maxTokensPerRun: 10, revoked: true });
    const disabled = await makeDelegation({ maxTokensPerRun: 10, enabled: false });
    const r1 = crypto.randomUUID();
    const r2 = crypto.randomUUID();
    await insertWorkflowRun({
      id: r1,
      workflowName: "bud-3",
      input: {},
      startedAt: new Date(),
      delegationId: revoked,
    });
    await insertWorkflowRun({
      id: r2,
      workflowName: "bud-3",
      input: {},
      startedAt: new Date(),
      delegationId: disabled,
    });
    expect((await readWorkflowRunDelegationBudget(r1))?.live).toBe(false);
    expect((await readWorkflowRunDelegationBudget(r2))?.live).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────
// The boundary hook
// ───────────────────────────────────────────────────────────────────
describe("the step-boundary token ceiling", () => {
  test("a delegated run UNDER its cap completes normally", async () => {
    // The paired half of every refusal below. A ceiling that refuses the
    // legitimate caller too is not a working ceiling.
    const delegationId = await makeDelegation({ maxTokensPerRun: 10_000 });
    const { wf, invocations } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-under-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    expect(run.status).toBe("success");
    expect(invocations()).toBe(3);
    expect((await parkedRow(run.id))?.suspended_reason).toBeNull();
  });

  test("a delegated run OVER its cap parks: suspended, budget-exceeded, finished_at NULL", async () => {
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf, events, invocations } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-over-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    // In memory.
    expect(run.status).toBe("suspended");
    expect(run.result?.error).toMatchObject({ code: "suspended" });
    expect(run.finishedAt).toBeUndefined();
    // Two batches ran (100 then 200 tokens); the third never dispatched.
    expect(invocations()).toBe(2);

    // On the row — this is the shape the spec pins.
    const row = await parkedRow(run.id);
    expect(row?.status).toBe("suspended");
    expect(row?.suspended_reason).toBe("budget-exceeded");
    // Deliberately NULL: the run has not finished.
    expect(row?.finished_at).toBeNull();
    expect(row?.run_phase).toBe("boundary");
    expect(row?.claimed_by).toBeNull();
    expect(row?.lease_expires_at).toBeNull();

    // `workflow:error` fires so the run visibly stops; NO approval request,
    // because no human decision is pending — the job is over budget.
    expect(events.filter((e) => e.name === "workflow:error")).toHaveLength(1);
    expect(events.filter((e) => e.name === "workflow:approval_request")).toHaveLength(0);
    expect(events.filter((e) => e.name === "workflow:complete")).toHaveLength(0);
  });

  test("a boundary park resumes at the NEXT batch and does not re-execute the completed one", async () => {
    // THE CURSOR HAZARD. `currentBatchIndex` is set at the top of each
    // iteration and the suspend catch writes it back as the cursor — which
    // is right for a mid-batch park and wrong here, where the batch is
    // complete and its advance already landed. Without the boundary's
    // `currentBatchIndex = batchIndex + 1` this parks at 1, and the resume
    // re-runs `s2`: a duplicated side effect and an LLM call billed twice.
    //
    // Asserted on the persisted cursor AND on the invocation count,
    // because a wrong cursor and a wrong replay are separate failures.
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf, invocations } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-cursor-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    const parked = await parkedRow(run.id);
    expect(parked?.suspended_reason).toBe("budget-exceeded");
    // s1 is batch 0, s2 is batch 1 — so the resume point is batch 2.
    expect(parked?.cursor?.batchIndex).toBe(2);
    expect(parked?.cursor?.completedSteps).toEqual(["s1", "s2"]);
    expect(parked?.cursor?.prevStepName).toBe("s2");
    expect(invocations()).toBe(2);

    // Raise the cap and resume: s3 runs, s1 and s2 do NOT run again.
    await db.execute(sql`
      UPDATE workflow_delegations SET max_tokens_per_run = 100000 WHERE id = ${delegationId}
    `);
    const row = await getWorkflowRunRow(run.id);
    const resumed = await wf.resumeWorkflow(def, resumeArgsFromRow(row!));
    await settle();

    expect(resumed.status).toBe("success");
    // 2 before the park + exactly 1 after it. A cursor of 1 would make
    // this 4.
    expect(invocations()).toBe(3);
    expect(resumed.steps.map((s) => s.stepName)).toEqual(["s3"]);
  });

  test("the ceiling sees the tokens of the batch that just ran, not the batch before", async () => {
    // The step writes are fire-and-forget, so without the boundary draining
    // them the sum trails the spend by a batch and the run overshoots. Cap
    // 150 with 100 per step: the park MUST happen after batch 1 (200
    // spent), not after batch 2 (300 spent).
    //
    // Run with the step-write stall ON, because PGlite would otherwise
    // have landed the write anyway and this would pass with the drain
    // deleted — see `stallStepWrites`.
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-lag-${crypto.randomUUID().slice(0, 8)}`);
    stallStepWrites = true;
    const run = await wf
      .runWorkflow(def, {}, undefined, undefined, undefined, { delegationId })
      .finally(() => {
        stallStepWrites = false;
      });
    await settle();

    // 200, not 300: the park happened at the boundary of batch 1, so
    // batch 2 never dispatched. Deliberately NOT an assertion on the
    // cursor — that is the hazard test's subject, and keeping the two
    // separate means a mutation kills one of them, not both.
    expect((await parkedRow(run.id))?.suspended_reason).toBe("budget-exceeded");
    expect(await sumWorkflowRunTokens(run.id)).toBe(200);
  });

  test("a run that exhausts its cap on the FINAL batch still completes", async () => {
    // The ceiling bounds FUTURE spend, and after the last batch there is
    // none. Parking here would leave a run with nothing left to do
    // waiting for a human to raise a cap so it can report a result it has
    // already produced — and the resume rule would refuse it meanwhile.
    // That is permanent denial of service arriving through the check
    // meant to protect the run.
    //
    // Cap 250 against 3 batches of 100: under at boundary 0 (100) and
    // boundary 1 (200), over at the final boundary (300).
    const delegationId = await makeDelegation({ maxTokensPerRun: 250 });
    const { wf, invocations } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-final-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    expect(run.status).toBe("success");
    expect(invocations()).toBe(3);
    const row = await parkedRow(run.id);
    expect(row?.status).toBe("success");
    expect(row?.suspended_reason).toBeNull();
    // The overspend is not hidden — it is on the step rows, which is where
    // the trace and the next fire's quota read it from.
    expect(await sumWorkflowRunTokens(run.id)).toBe(300);
  });

  test("a delegation DELETED mid-run does not park the run in flight", async () => {
    // `workflow_runs.delegation_id` is ON DELETE SET NULL, so after the
    // delete the row can no longer name a cap while the executor still
    // carries the id in memory — the one way the boundary reaches a
    // non-null delegation with no budget behind it. The run was
    // authorized when it started, and refusing the NEXT fire belongs to
    // the handler, not to a run already in flight.
    //
    // Deleted from inside the FIRST agent invocation, so the delete
    // lands before the first boundary rather than racing it.
    const delegationId = await makeDelegation({ maxTokensPerRun: 1 });
    const { wf } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }], async (n) => {
      if (n === 1) {
        await db.execute(sql`DELETE FROM workflow_delegations WHERE id = ${delegationId}`);
      }
    });
    const def = chain(`wf-gone-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    // A cap of 1 token would have parked this at every boundary if the
    // budget read had fallen back to anything other than "no opinion".
    expect(run.status).toBe("success");
    const row = await parkedRow(run.id);
    expect(row?.suspended_reason).toBeNull();
    // The FK did what the schema says: the pointer is gone, the run is not.
    const after = (await db.execute(sql`
      SELECT delegation_id FROM workflow_runs WHERE id = ${run.id}
    `)) as Rows<{ delegation_id: string | null }>;
    expect(after.rows[0]?.delegation_id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// Scope: what a NON-delegated run costs
// ───────────────────────────────────────────────────────────────────
describe("scope — a run with no delegation takes zero extra queries", () => {
  test("no delegation read and no token sum, while a delegated run takes both", async () => {
    // A per-boundary round trip on every workflow in the instance is a
    // performance regression nobody would attribute to C3. The spy is
    // PAIRED: the same patterns are asserted PRESENT for a delegated run,
    // so "zero" cannot be zero because the spy is blind.
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const plain = chain(`wf-spy-plain-${crypto.randomUUID().slice(0, 8)}`);
    await settle();

    seenSql.length = 0;
    recording = true;
    const plainRun = await wf.runWorkflow(plain, {});
    recording = false;
    await settle();
    const plainDelegationReads = seenSql.filter((s) => /workflow_delegations/i.test(s)).length;
    const plainSums = seenSql.filter((s) => /\bsum\s*\(/i.test(s)).length;

    const delegationId = await makeDelegation({ maxTokensPerRun: 100_000 });
    const delegated = chain(`wf-spy-deleg-${crypto.randomUUID().slice(0, 8)}`);
    await settle();

    seenSql.length = 0;
    recording = true;
    const delegatedRun = await wf.runWorkflow(delegated, {}, undefined, undefined, undefined, {
      delegationId,
    });
    recording = false;
    await settle();
    const delegatedDelegationReads = seenSql.filter((s) => /workflow_delegations/i.test(s)).length;
    const delegatedSums = seenSql.filter((s) => /\bsum\s*\(/i.test(s)).length;

    expect(plainRun.status).toBe("success");
    expect(delegatedRun.status).toBe("success");
    // The claim.
    expect(plainDelegationReads).toBe(0);
    expect(plainSums).toBe(0);
    // The spy can see these statements when they happen — one pair per
    // boundary that CAN park, which is every boundary but the last (a run
    // with nothing left to spend is not parked).
    expect(delegatedDelegationReads).toBe(2);
    expect(delegatedSums).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────
// The resume table's two C3 rows, against real rows
// ───────────────────────────────────────────────────────────────────
describe("budget-exceeded — the resume-time predicate", () => {
  test("refuses while the run is at or over its cap, naming the run and the reason", async () => {
    const delegationId = await makeDelegation({ maxTokensPerRun: 100 });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "pred-1",
      input: {},
      startedAt: new Date(),
      delegationId,
    });
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "a",
      runId: "",
      status: "success",
      inputTokens: 100,
      outputTokens: 0,
    });
    const refusal = await resumeReasonRefusal("budget-exceeded", { workflowRunId: runId });
    expect(refusal).toContain(runId);
    expect(refusal).toContain("budget-exceeded");
  });

  test("allows once the cap is raised above what the run has spent", async () => {
    const delegationId = await makeDelegation({ maxTokensPerRun: 100 });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "pred-2",
      input: {},
      startedAt: new Date(),
      delegationId,
    });
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "a",
      runId: "",
      status: "success",
      inputTokens: 100,
      outputTokens: 0,
    });
    expect(await resumeReasonRefusal("budget-exceeded", { workflowRunId: runId })).not.toBeNull();
    await db.execute(sql`
      UPDATE workflow_delegations SET max_tokens_per_run = 101 WHERE id = ${delegationId}
    `);
    expect(await resumeReasonRefusal("budget-exceeded", { workflowRunId: runId })).toBeNull();
  });

  test("fails CLOSED when the delegation is revoked, or gone entirely", async () => {
    // The asymmetry with `parseSuspendReason`'s "unknown allows" is
    // deliberate: an unknown reason is a rolling-deploy artefact on a
    // healthy run, while a run parked here is over budget by construction.
    const revokedId = await makeDelegation({ maxTokensPerRun: 100_000, revoked: true });
    const revokedRun = crypto.randomUUID();
    await insertWorkflowRun({
      id: revokedRun,
      workflowName: "pred-3",
      input: {},
      startedAt: new Date(),
      delegationId: revokedId,
    });
    const orphanRun = crypto.randomUUID();
    await insertWorkflowRun({
      id: orphanRun,
      workflowName: "pred-3",
      input: {},
      startedAt: new Date(),
    });

    expect(
      await resumeReasonRefusal("budget-exceeded", { workflowRunId: revokedRun }),
    ).not.toBeNull();
    expect(
      await resumeReasonRefusal("budget-exceeded", { workflowRunId: orphanRun }),
    ).not.toBeNull();
  });
});

describe("consent-stale — the resume-time predicate", () => {
  test("refuses while nobody has re-consented since the run started", async () => {
    const delegationId = await makeDelegation({
      maxTokensPerRun: 100,
      consentedAt: "2020-01-01T00:00:00Z",
    });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "cs-1",
      input: {},
      startedAt: new Date(),
      delegationId,
    });
    expect(await resumeReasonRefusal("consent-stale", { workflowRunId: runId })).toContain(runId);
  });

  test("allows once the delegation is re-consented after the run started", async () => {
    const delegationId = await makeDelegation({
      maxTokensPerRun: 100,
      consentedAt: "2020-01-01T00:00:00Z",
    });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "cs-2",
      input: {},
      startedAt: new Date("2021-01-01T00:00:00Z"),
      delegationId,
    });
    expect(await resumeReasonRefusal("consent-stale", { workflowRunId: runId })).not.toBeNull();
    await db.execute(sql`
      UPDATE workflow_delegations SET consented_at = '2022-01-01T00:00:00Z'::timestamptz
       WHERE id = ${delegationId}
    `);
    expect(await resumeReasonRefusal("consent-stale", { workflowRunId: runId })).toBeNull();
  });

  test("a re-consent on a REVOKED delegation still refuses", async () => {
    const delegationId = await makeDelegation({
      maxTokensPerRun: 100,
      revoked: true,
      consentedAt: "2030-01-01T00:00:00Z",
    });
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "cs-3",
      input: {},
      startedAt: new Date(),
      delegationId,
    });
    expect(await resumeReasonRefusal("consent-stale", { workflowRunId: runId })).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// End to end: park, then try to resume it
// ───────────────────────────────────────────────────────────────────
describe("a budget-parked run and the resume path", () => {
  test("resume is refused TRANSIENTLY — the row is left exactly as it was", async () => {
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-refuse-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    const row = await getWorkflowRunRow(run.id);
    const refused = await wf.resumeWorkflow(def, resumeArgsFromRow(row!));
    await settle();

    expect(refused.status).toBe("suspended");
    expect(refused.result?.error).toMatchObject({ code: "suspend-reason-unsatisfied" });
    // TRANSIENT: nothing written. `refuseTerminal` would have made this
    // `error` with a stamped `finished_at`, which is the defect class PR
    // #58 fixed.
    const after = await parkedRow(run.id);
    expect(after?.status).toBe("suspended");
    expect(after?.finished_at).toBeNull();
    expect(after?.suspended_reason).toBe("budget-exceeded");
  });

  test("ANSWERING AN APPROVAL does not admit a capped run", async () => {
    // The whole justification for the resume table. Step re-entry cannot
    // defend a spend cap: `runApprovalStep` re-reads the approval, finds
    // it `answered`, and is satisfied. Only the table's own predicate
    // stops the run here.
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-answer-${crypto.randomUUID().slice(0, 8)}`);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    const approvalId = await parkWorkflowApproval({
      workflowRunId: run.id,
      stepName: "s3",
      prompt: "proceed?",
      choices: ["yes", "no"],
      requireItemConsent: false,
      itemIds: [],
    });
    const answered = await recordWorkflowApprovalAnswer(approvalId, {
      choice: "yes",
      answeredBy: "u-consent",
    });
    expect(answered).toBe(1);

    // The pending-approval chokepoint is now satisfied, so the ONLY thing
    // left between this caller and the run is the budget row.
    const row = await getWorkflowRunRow(run.id);
    const refused = await wf.resumeWorkflow(def, resumeArgsFromRow(row!));
    expect(refused.result?.error).toMatchObject({ code: "suspend-reason-unsatisfied" });
    expect((await parkedRow(run.id))?.status).toBe("suspended");
  });

  test("resumeArgsFromRow carries delegation_id, so a resumed run keeps its ceiling", async () => {
    // Dropping it here would silently un-bound every resumed delegated
    // run — it would come back with no cap, take no boundary queries, and
    // look perfectly healthy.
    // FOUR steps, so the resumed half still has a boundary that is not the
    // last one — the ceiling deliberately does not fire at the final
    // boundary, and this test is about the ceiling, not about that.
    const delegationId = await makeDelegation({ maxTokensPerRun: 150 });
    const { wf, invocations } = scriptedExecutor([{ inputTokens: 90, outputTokens: 10 }]);
    const def = chain(`wf-rearm-${crypto.randomUUID().slice(0, 8)}`, 4);
    const run = await wf.runWorkflow(def, {}, undefined, undefined, undefined, { delegationId });
    await settle();

    const row = await getWorkflowRunRow(run.id);
    expect(resumeArgsFromRow(row!).delegationId).toBe(delegationId);

    // Raise the cap by just enough for ONE more batch, resume, and watch
    // the ceiling fire a second time on the resumed half.
    await db.execute(sql`
      UPDATE workflow_delegations SET max_tokens_per_run = 250 WHERE id = ${delegationId}
    `);
    const resumed = await wf.resumeWorkflow(def, resumeArgsFromRow(row!));
    await settle();

    expect(resumed.status).toBe("suspended");
    expect(invocations()).toBe(3);
    const after = await parkedRow(run.id);
    expect(after?.suspended_reason).toBe("budget-exceeded");
    expect(after?.cursor?.batchIndex).toBe(3);
  });
});
