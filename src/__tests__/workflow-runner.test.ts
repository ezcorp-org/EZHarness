/**
 * `WorkflowRunner` — the daemon that resumes parked runs — and the
 * claim/lease SQL it drives.
 *
 * Runs against a real PGlite driven by the real `migrate()`, because every
 * property here is a property of a CAS: "exactly one of two racers wins",
 * "an expired lease is stealable, a live one is not", "a released claim is
 * immediately re-claimable". A stubbed query layer would let all of those
 * pass while the WHERE clause said something else entirely.
 *
 * The daemon is driven by `tick()` directly rather than by waiting out a
 * wake interval — the same test seam `ScheduleDaemon` exposes — and `now`
 * is injected, so lease expiry is tested without sleeping.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { AgentEvents, WorkflowDefinition, WorkflowRun } from "../types";
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
  releaseWorkflowRunClaim,
  releaseWorkflowRunClaims,
  renewWorkflowRunLeases,
  suspendWorkflowRun,
  WORKFLOW_LEASE_MS,
} = await import("../db/queries/workflow-runs");
const { getWorkflowApproval, getWorkflowApprovalById, parkWorkflowApproval } = await import(
  "../db/queries/workflow-approvals"
);
const { WorkflowRunner } = await import("../runtime/workflow-runner");
const { nestedRunKey, resumeArgsFromRow, WorkflowExecutor } = await import(
  "../runtime/workflow-executor"
);
const { answerApproval } = await import("../runtime/workflow-answer-approval");
const { EventBus } = await import("../runtime/events");
const { AgentExecutor } = await import("../runtime/executor");
const { loadAgentsStatic } = await import("../runtime/loader");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  // `workflow_runs.project_id` is a real FK — a project-scoped run needs a
  // real project row, which is the point of the FK.
  await db.execute(sql`
    INSERT INTO projects (id, name, path)
    VALUES ('proj-1', 'One', '/tmp/p1'), ('proj-2', 'Two', '/tmp/p2'), ('proj-9', 'Nine', '/tmp/p9')
  `);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM workflow_step_runs`);
  await db.execute(sql`DELETE FROM workflow_runs`);
});

const T0 = new Date("2026-07-29T12:00:00.000Z");
/** Past T0's lease. */
const T_LATER = new Date(T0.getTime() + WORKFLOW_LEASE_MS + 1_000);

const definition: WorkflowDefinition = {
  name: "parked",
  description: "",
  steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
};

/** A run parked at `suspended` with a cursor, the shape the daemon claims. */
async function parkedRun(id: string, projectId: string | null = null): Promise<void> {
  await insertWorkflowRun({
    id,
    workflowName: definition.name,
    input: {},
    startedAt: T0,
    projectId,
    definitionHash: null,
  });
  const moved = await suspendWorkflowRun(id, {
    reason: "approval",
    cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
  });
  expect(moved).toBe(1);
}

/**
 * A definition whose first step is a real consent gate.
 *
 * A run parked here is the population the daemon exists to serve AND the
 * one it must never destroy, so the approval tests below need a graph the
 * REAL executor can look up by name — `definition` above has no gate.
 */
const gatedDefinition: WorkflowDefinition = {
  name: "gated",
  description: "",
  steps: [
    { name: "gate", kind: "approval", prompt: "Ship it?", choices: ["approve", "reject"] },
    { name: "after", kind: "transform", output: { v: "2" } },
  ],
};

/** A run parked at `gate` with a real PENDING `workflow_approvals` row. */
async function approvalParkedRun(id: string): Promise<string> {
  await insertWorkflowRun({
    id,
    workflowName: gatedDefinition.name,
    input: {},
    startedAt: T0,
    projectId: null,
    definitionHash: null,
  });
  const moved = await suspendWorkflowRun(id, {
    reason: "approval",
    cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
  });
  expect(moved).toBe(1);
  return parkWorkflowApproval({
    workflowRunId: id,
    stepName: "gate",
    prompt: "Ship it?",
    choices: ["approve", "reject"],
    requireItemConsent: false,
    itemIds: [],
  });
}

/**
 * A runtime wired to the REAL `WorkflowExecutor`, persisting.
 *
 * The stub in {@link fakeRuntime} answers `success` to every resume, so it
 * proves the daemon CALLED the executor and nothing about what the executor
 * does when it is called. Every property in "the daemon must not destroy a
 * parked run" lives in `resumeWorkflow`, so these tests use the real one.
 */
function liveRuntime(): WorkflowRuntime {
  const bus = new EventBus<AgentEvents>();
  const defs = [definition, gatedDefinition, gateChild, loopParent];
  return {
    getWorkflows: () => defs,
    workflowExecutor: new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
      persist: true,
      // Nesting is WIRED, never assumed — the executor holds no registry of
      // its own, so without this a `kind: "workflow"` step fails loudly.
      workflowResolver: (name) => defs.find((d) => d.name === name),
    }),
  };
}

// ── The `docs-factory` shape: a loop over a nested run that parks ──────
//
// The child owns the consent gate; the parent parks alongside it as
// `nested-suspended` with NO approval row of its own. Each loop iteration
// is its own child run keyed by `nestedRunKey`, which is what lets a
// replayed loop serve its earlier iterations from their recorded rows
// instead of re-dispatching them.

/** The child: one consent gate, then a step that reads its answer. */
const gateChild: WorkflowDefinition = {
  name: "kid-gate",
  description: "",
  steps: [
    { name: "ok", kind: "approval", prompt: "Ship it?", choices: ["go"] },
    {
      name: "done",
      kind: "transform",
      output: { choice: "$steps.ok.output.choice" },
      dependsOn: ["ok"],
    },
  ],
};

/** The parent: TWO iterations of that child, each its own run. */
const LOOP_ITERATIONS = 2;
const loopParent: WorkflowDefinition = {
  name: "mum-loop",
  description: "",
  steps: [
    {
      name: "attempt",
      kind: "workflow",
      workflow: "kid-gate",
      loop: { maxIterations: LOOP_ITERATIONS },
    },
  ],
};

/** Child runs of a parent, ordered by iteration key. */
async function childrenOf(parentRunId: string): Promise<Array<{ id: string; key: string }>> {
  const rows = (await db.execute(sql`
    SELECT id, idempotency_key FROM workflow_runs
     WHERE parent_run_id = ${parentRunId}
     ORDER BY idempotency_key
  `)) as { rows: Array<{ id: string; idempotency_key: string }> };
  return rows.rows.map((r) => ({ id: r.id, key: r.idempotency_key }));
}

/** A promise a test can hold open, so resumes really do overlap. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A runtime whose executor records the resumes it was asked for.
 *
 * `gate` holds every resume open until the test releases it. That is what
 * makes the concurrency-cap tests real: with resumes that settle
 * immediately, in-flight never exceeds one and a cap assertion would pass
 * against a daemon that has no cap at all.
 */
function fakeRuntime(overrides?: {
  workflows?: WorkflowDefinition[];
  onResume?: (runId: string) => void;
  gate?: Promise<void>;
}): { runtime: WorkflowRuntime; resumed: string[] } {
  const resumed: string[] = [];
  const runtime: WorkflowRuntime = {
    getWorkflows: () => overrides?.workflows ?? [definition],
    workflowExecutor: {
      runWorkflow: (async () => {
        throw new Error("the daemon must never START a run");
      }) as WorkflowRuntime["workflowExecutor"]["runWorkflow"],
      resumeWorkflow: (async (_wf: WorkflowDefinition, row: { id: string }) => {
        resumed.push(row.id);
        overrides?.onResume?.(row.id);
        if (overrides?.gate) await overrides.gate;
        return { id: row.id, workflowName: definition.name, status: "success", startedAt: T0.getTime(), steps: [] } as unknown as WorkflowRun;
      }) as WorkflowRuntime["workflowExecutor"]["resumeWorkflow"],
    },
  };
  return { runtime, resumed };
}

function runner(
  runtime: WorkflowRuntime | null,
  opts?: Partial<{ instanceId: string; maxConcurrentHost: number; maxConcurrentPerProject: number; now: () => Date }>,
) {
  return new WorkflowRunner({
    skipLockfile: true,
    runtime: () => runtime,
    now: opts?.now ?? (() => T0),
    instanceId: opts?.instanceId ?? "inst-A",
    ...(opts?.maxConcurrentHost !== undefined ? { maxConcurrentHost: opts.maxConcurrentHost } : {}),
    ...(opts?.maxConcurrentPerProject !== undefined
      ? { maxConcurrentPerProject: opts.maxConcurrentPerProject }
      : {}),
  });
}

describe("claim is a CAS, so exactly one racer wins", () => {
  test("the winner takes the run to running under lease; the loser gets false", async () => {
    await parkedRun("r1");

    const first = await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });
    const second = await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "B", now: T0 });

    expect(first).toBe(true);
    // THE property: the second attempt on the same row cannot also succeed.
    expect(second).toBe(false);

    // Asserted on the ROW, not on the return value: winning the CAS *is*
    // the suspended → running transition, and `claimed_by` must be the
    // winner, never the racer that arrived second.
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("running");
    expect(row?.claimedBy).toBe("A");
    expect(row?.leaseExpiresAt?.getTime()).toBe(T0.getTime() + WORKFLOW_LEASE_MS);
  });

  test("a run that is not suspended cannot be claimed at all", async () => {
    // The structural guard against double-executing a synchronous run: it
    // sits at `running` from insert to terminal.
    await insertWorkflowRun({
      id: "sync",
      workflowName: definition.name,
      input: {},
      startedAt: T0,
      definitionHash: null,
    });

    expect(await claimWorkflowRun({ workflowRunId: "sync", claimedBy: "A", now: T0 })).toBe(false);
    expect((await getWorkflowRunRow("sync"))?.claimedBy).toBeNull();
  });

  test("an EXPIRED lease is stealable; a live one is not", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });
    // A's claim moved the row to `running`, so a steal must first look like
    // a claimable row again — park it as the crash path would leave it.
    await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = 'r1'`);

    // Still inside A's lease → B must not take it.
    expect(await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "B", now: T0 })).toBe(false);
    expect((await getWorkflowRunRow("r1"))?.claimedBy).toBe("A");

    // Past it → B takes over, which is how a dead instance's work resumes.
    expect(await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "B", now: T_LATER })).toBe(true);
    expect((await getWorkflowRunRow("r1"))?.claimedBy).toBe("B");
  });
});

describe("listClaimableWorkflowRuns", () => {
  test("offers suspended runs, and never a claim held on a live lease", async () => {
    await parkedRun("free");
    await parkedRun("held");
    await claimWorkflowRun({ workflowRunId: "held", claimedBy: "A", now: T0 });
    await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = 'held'`);

    expect((await listClaimableWorkflowRuns(T0, 10)).map((r) => r.id)).toEqual(["free"]);
    // Once the lease lapses the held row rejoins the population.
    expect((await listClaimableWorkflowRuns(T_LATER, 10)).map((r) => r.id).sort()).toEqual([
      "free",
      "held",
    ]);
  });

  test("a deliberately parked run is offered even though `resumable` is false", async () => {
    // `suspendWorkflowRun` documents that it does NOT set `resumable` —
    // that flag is the recovery sweep's verdict on a CRASHED run. Filtering
    // the candidate query on it would make the daemon ignore every
    // approval-parked run, i.e. its entire reason to exist.
    await parkedRun("r1");
    expect((await getWorkflowRunRow("r1"))?.resumable).toBe(false);
    expect((await listClaimableWorkflowRuns(T0, 10)).map((r) => r.id)).toEqual(["r1"]);
  });

  test("respects the limit, which is how the host cap bounds the query", async () => {
    await parkedRun("a");
    await parkedRun("b");
    await parkedRun("c");
    expect(await listClaimableWorkflowRuns(T0, 2)).toHaveLength(2);
  });
});

describe("lease renewal and release", () => {
  test("renewal pushes only THIS instance's live claims forward", async () => {
    await parkedRun("mine");
    await parkedRun("theirs");
    await claimWorkflowRun({ workflowRunId: "mine", claimedBy: "A", now: T0 });
    await claimWorkflowRun({ workflowRunId: "theirs", claimedBy: "B", now: T0 });

    const renewed = await renewWorkflowRunLeases("A", T_LATER);

    expect(renewed).toBe(1);
    expect((await getWorkflowRunRow("mine"))?.leaseExpiresAt?.getTime()).toBe(
      T_LATER.getTime() + WORKFLOW_LEASE_MS,
    );
    // B's lease is untouched — renewing another instance's claim would let
    // a dead process's runs look alive forever.
    expect((await getWorkflowRunRow("theirs"))?.leaseExpiresAt?.getTime()).toBe(
      T0.getTime() + WORKFLOW_LEASE_MS,
    );
  });

  test("a run this instance already parked is NOT dragged back under lease", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });
    // The executor parked it again at the next approval; `claimed_by` is
    // cleared by `suspendWorkflowRun`, and status is no longer `running`.
    await suspendWorkflowRun("r1", {
      reason: "approval",
      cursor: { batchIndex: 1, completedSteps: ["a"], prevStepName: "a" },
    });

    expect(await renewWorkflowRunLeases("A", T_LATER)).toBe(0);
    expect((await getWorkflowRunRow("r1"))?.status).toBe("suspended");
  });

  test("release returns claims to suspended so a sibling can take them at once", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });

    expect(await releaseWorkflowRunClaims("A")).toBe(1);

    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("suspended");
    expect(row?.claimedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    // The point of releasing rather than waiting out the lease: claimable
    // again NOW, at the same instant, not one lease period later.
    expect(await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "B", now: T0 })).toBe(true);
  });

  test("release leaves an IN-BATCH run alone — the sweep owns that call", async () => {
    // `in-batch` means a batch was dispatched and may have applied side
    // effects. Handing it to a sibling would invite a re-execution; the
    // recovery sweep is the component that reads `run_phase` and decides.
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });
    await db.execute(sql`UPDATE workflow_runs SET run_phase = 'in-batch' WHERE id = 'r1'`);

    expect(await releaseWorkflowRunClaims("A")).toBe(0);
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("running");
    expect(row?.claimedBy).toBe("A");
  });
});


describe("WorkflowRunner.tick", () => {
  test("claims a parked run and resumes it through the registered executor", async () => {
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime();
    const d = runner(runtime);

    const result = await d.tick();
    await d.drain();

    expect(result).toEqual({ claimed: 1, started: 1 });
    // Asserted by CALL RECORD on the executor, not by inspecting the row:
    // the property is "the daemon actually drove a resume", and a row at
    // `running` would look identical if it had claimed and then done
    // nothing at all.
    expect(resumed).toEqual(["r1"]);
  });

  test("ticks to a no-op when no runtime is registered, claiming NOTHING", async () => {
    // Claiming without being able to resume would park the row under a
    // lease this process cannot honor — unavailable to every other
    // instance for a full lease period, for nothing.
    await parkedRun("r1");

    expect(await runner(null).tick()).toEqual({ claimed: 0, started: 0 });
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("suspended");
    expect(row?.claimedBy).toBeNull();
  });

  test("two daemons over one run: one resumes it, the other does no work", async () => {
    await parkedRun("r1");
    const a = fakeRuntime();
    const b = fakeRuntime();
    const da = runner(a.runtime, { instanceId: "A" });
    const dbr = runner(b.runtime, { instanceId: "B" });

    const first = await da.tick();
    const second = await dbr.tick();
    await da.drain();
    await dbr.drain();

    expect(first).toEqual({ claimed: 1, started: 1 });
    // B's candidate query no longer sees it (A's CAS took it to
    // `running`), so B never even attempts the claim.
    expect(second).toEqual({ claimed: 0, started: 0 });
    expect(a.resumed).toEqual(["r1"]);
    expect(b.resumed).toEqual([]);
  });

  test("the host cap bounds one tick", async () => {
    await parkedRun("a");
    await parkedRun("b");
    await parkedRun("c");
    const { runtime, resumed } = fakeRuntime();
    const d = runner(runtime, { maxConcurrentHost: 2 });

    expect(await d.tick()).toEqual({ claimed: 2, started: 2 });
    await d.drain();
    expect(resumed).toHaveLength(2);
  });

  test("the per-project cap bounds one project without starving another", async () => {
    await parkedRun("p1-a", "proj-1");
    await parkedRun("p1-b", "proj-1");
    await parkedRun("p2-a", "proj-2");
    // Resumes are held open, so the cap is actually load-bearing: with
    // sequential resumes in-flight would never exceed one and this would
    // pass against a daemon that has no cap at all.
    const release = deferred();
    const { runtime, resumed } = fakeRuntime({ gate: release.promise });
    const d = runner(runtime, { maxConcurrentPerProject: 1 });

    const result = await d.tick();
    release.resolve();
    await d.drain();

    expect(result.claimed).toBe(2);
    // One from each project — the cap is per project, so proj-2 is not
    // punished for proj-1 being busy.
    expect(resumed.filter((id) => id.startsWith("p1"))).toHaveLength(1);
    expect(resumed.filter((id) => id.startsWith("p2"))).toHaveLength(1);
  });

  test("projectless runs share one cap bucket rather than escaping the cap", async () => {
    await parkedRun("n1");
    await parkedRun("n2");
    const release = deferred();
    const { runtime } = fakeRuntime({ gate: release.promise });
    const d = runner(runtime, { maxConcurrentPerProject: 1 });

    const result = await d.tick();
    release.resolve();
    await d.drain();

    expect(result.claimed).toBe(1);
    // The second run is still parked and claimable on a later tick.
    expect((await getWorkflowRunRow("n2"))?.status).toBe("suspended");
  });

  test("in-flight counters are released, so a second tick still has capacity", async () => {
    // A leaked counter does not fail a run — it silently lowers the cap
    // until restart, which is the kind of degradation nobody notices.
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime();
    const d = runner(runtime, { maxConcurrentHost: 1 });

    await d.tick();
    await d.drain();
    await parkedRun("r2");
    expect((await d.tick()).claimed).toBe(1);
    await d.drain();
    expect(resumed).toEqual(["r1", "r2"]);
  });

  test("a resume that THROWS is contained and still frees capacity", async () => {
    // Contained: one bad resume must not become an unhandled rejection,
    // must not fail the tick, and must not leave the daemon permanently at
    // capacity.
    await parkedRun("r1");
    const bad = fakeRuntime({
      onResume: () => {
        throw new Error("executor blew up");
      },
    });
    const d = runner(bad.runtime, { maxConcurrentHost: 1 });

    expect(await d.tick()).toEqual({ claimed: 1, started: 1 });
    await d.drain();

    // Capacity is back on the very next tick.
    await parkedRun("r2");
    expect((await d.tick()).claimed).toBe(1);
    await d.drain();
    // Left `running` under lease for the recovery sweep to judge.
    expect((await getWorkflowRunRow("r1"))?.status).toBe("running");
  });

  test("a run whose definition was deleted is claimed but never resumed", async () => {
    // Left `running` under lease on purpose: terminalizing it here would
    // put a second component in the business of deciding a run's fate,
    // which is the recovery sweep's job.
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime({ workflows: [] });
    const d = runner(runtime);

    expect(await d.tick()).toEqual({ claimed: 1, started: 1 });
    await d.drain();
    expect(resumed).toEqual([]);
    expect((await getWorkflowRunRow("r1"))?.status).toBe("running");
  });

  test("a run deleted between claim and read is reported, not crashed on", async () => {
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime();
    const d = runner(runtime, { instanceId: "vanish" });
    // Occupy the row with someone else's claim, then delete it — the
    // window a concurrent purge sits in.
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "other", now: T0 });
    await db.execute(sql`DELETE FROM workflow_runs WHERE id = 'r1'`);

    expect(await d.tick()).toEqual({ claimed: 0, started: 0 });
    await d.drain();
    expect(resumed).toEqual([]);
  });

  test("does not claim when host capacity is already exhausted", async () => {
    await parkedRun("r1");
    const { runtime } = fakeRuntime();
    expect(await runner(runtime, { maxConcurrentHost: 0 }).tick()).toEqual({
      claimed: 0,
      started: 0,
    });
    expect((await getWorkflowRunRow("r1"))?.claimedBy).toBeNull();
  });

  test("never calls runWorkflow — a daemon resumes, it never starts", async () => {
    // `fakeRuntime`'s `runWorkflow` throws. If the daemon ever took the
    // start path this would surface as that throw rather than as a resume.
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime();
    const d = runner(runtime);
    await d.tick();
    await d.drain();
    expect(resumed).toEqual(["r1"]);
  });
});

describe("WorkflowRunner lifecycle", () => {
  test("start installs the loop, is idempotent, and stop releases claims", async () => {
    await parkedRun("r1");
    const { runtime } = fakeRuntime();
    const d = runner(runtime, { instanceId: "life" });

    expect(await d.start()).toBe(true);
    // Second call is a no-op rather than a second interval.
    expect(await d.start()).toBe(true);

    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "life", now: T0 });
    await d.stop();

    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("suspended");
    expect(row?.claimedBy).toBeNull();
  });

  test("stop before start is a no-op, not an error and not a release", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "someone-else", now: T0 });
    const { runtime } = fakeRuntime();

    await runner(runtime, { instanceId: "idle" }).stop();

    // The assertion that matters: a daemon that never started must not
    // release claims it does not hold. `releaseWorkflowRunClaims` is scoped
    // to `claimed_by = me`, and this pins that scoping from the caller's
    // side too.
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("running");
    expect(row?.claimedBy).toBe("someone-else");
  });

  test("the default instanceId carries a PID and an identity token", async () => {
    // The token is what distinguishes this process from a later one that
    // reused its PID — the difference between "my claim" and "a dead
    // process's claim" when renewing a lease.
    const d = new WorkflowRunner({ skipLockfile: true, runtime: () => null });
    expect(d.instanceId.startsWith(`${process.pid}:`)).toBe(true);
    expect(d.instanceId.length).toBeGreaterThan(`${process.pid}:`.length);
  });

  test("refuses to start when a LIVE FOREIGN pid holds the lockfile", async () => {
    // Has to be a foreign pid: the shared primitive treats our own pid as
    // "same process / reused self" and reclaims, so writing our own pid
    // would test the reclaim path and silently prove nothing about
    // sibling refusal. PID 1 is always alive, and stamping its CURRENT
    // starttime token is what makes it look like a genuine live sibling
    // rather than a PID-reuse leftover.
    const { readProcStartTime, _processLockfileInternals } = await import(
      "../startup/process-lockfile"
    );
    const token = readProcStartTime(1);
    // procfs-less host: `isLiveSibling` cannot confirm a match and
    // deliberately reclaims rather than wedging, so there is no refusal to
    // assert. Skipping beats asserting the opposite of the invariant.
    if (token === _processLockfileInternals.STARTTIME_UNAVAILABLE) return;
    const path = `/tmp/ez-wf-runner-sibling-${process.pid}.pid`;
    await Bun.write(path, `1 ${token}`);
    try {
      const d = new WorkflowRunner({ lockfilePath: path, runtime: () => null });
      expect(await d.start()).toBe(false);
      // And it must NOT have taken ownership — otherwise `stop()` would
      // delete the live sibling's lockfile.
      await d.stop();
      expect(await Bun.file(path).exists()).toBe(true);
    } finally {
      await (await import("node:fs/promises")).unlink(path).catch(() => {});
    }
  });

  test("start acquires and stop releases the real lockfile", async () => {
    const path = `/tmp/ez-wf-runner-own-${process.pid}.pid`;
    const d = new WorkflowRunner({ lockfilePath: path, runtime: () => null });
    expect(await d.start()).toBe(true);
    await d.stop();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a throw AFTER acquiring the lockfile gives the lockfile back", async () => {
    // Otherwise a half-started daemon leaves a lockfile stamped with a LIVE
    // pid — this process — so no sibling can ever start while this one is
    // not running either. The caller drops its handle on a throw, so
    // nothing else would come along to release it.
    const path = `/tmp/ez-wf-runner-throw-${process.pid}.pid`;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (() => {
      throw new Error("timer subsystem unavailable");
    }) as typeof setInterval;
    try {
      const d = new WorkflowRunner({ lockfilePath: path, runtime: () => null });
      await expect(d.start()).rejects.toThrow("timer subsystem unavailable");
      expect(await Bun.file(path).exists()).toBe(false);
    } finally {
      globalThis.setInterval = realSetInterval;
      await (await import("node:fs/promises")).unlink(path).catch(() => {});
    }
  });

  test("the wake loop actually fires a tick", async () => {
    await parkedRun("r1");
    const { runtime, resumed } = fakeRuntime();
    const d = new WorkflowRunner({
      skipLockfile: true,
      runtime: () => runtime,
      now: () => T0,
      instanceId: "loop",
      wakeIntervalMs: 5,
    });
    await d.start();
    try {
      const deadline = Date.now() + 3_000;
      while (resumed.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(resumed).toEqual(["r1"]);
    } finally {
      await d.stop();
    }
  });

  test("a tick that throws is caught by the wake loop, which keeps ticking", async () => {
    // `void this.tick().catch(...)` — without the catch an unhandled
    // rejection would take the process down and every parked run with it.
    //
    // The throw has to come from `tick` ITSELF, which means the runtime
    // LOOKUP: `getWorkflows` is called inside the resume task, whose own
    // containment is a different test. Getting that wrong the first time
    // produced a test that passed for the wrong reason — the run was
    // claimed once and then no longer claimable, so nothing ticked again.
    await parkedRun("r1");
    let lookups = 0;
    let explode = true;
    const { runtime: good } = fakeRuntime();
    const d = new WorkflowRunner({
      skipLockfile: true,
      runtime: () => {
        lookups++;
        if (explode) throw new Error("runtime registry exploded");
        return good;
      },
      now: () => T0,
      wakeIntervalMs: 5,
      instanceId: "boom",
    });
    await d.start();
    try {
      const deadline = Date.now() + 2_000;
      while (lookups < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Repeated ticks are the property. "No exception escaped" would also
      // be true of a loop that died on its first throw — and a dead loop
      // means every parked run stays parked forever.
      expect(lookups).toBeGreaterThanOrEqual(3);
      expect((await getWorkflowRunRow("r1"))?.status).toBe("suspended");

      // And it still does real work once the fault clears.
      explode = false;
      const claimed = Date.now() + 2_000;
      while ((await getWorkflowRunRow("r1"))?.status === "suspended" && Date.now() < claimed) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect((await getWorkflowRunRow("r1"))?.status).toBe("running");
    } finally {
      await d.stop();
    }
  });

  test("the heartbeat timer actually renews this instance's claims", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "hb", now: T0 });
    const before = (await getWorkflowRunRow("r1"))!.leaseExpiresAt!.getTime();

    // Driven through the real timer, at an injected interval. Asserting
    // `renewWorkflowRunLeases` directly would prove the SQL and leave the
    // WIRING unproven — a daemon that never installed the heartbeat would
    // pass that and then silently lose every claim after 60s.
    const d = new WorkflowRunner({
      skipLockfile: true,
      runtime: () => null,
      now: () => T_LATER,
      instanceId: "hb",
      leaseRenewMs: 5,
    });
    await d.start();
    try {
      const deadline = Date.now() + 3_000;
      let after = before;
      while (after <= before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
        after = (await getWorkflowRunRow("r1"))!.leaseExpiresAt!.getTime();
      }
      expect(after).toBeGreaterThan(before);
    } finally {
      await d.stop();
    }
  });

  test("a heartbeat whose renewal REJECTS is caught, and the timer keeps firing", async () => {
    // The renewal runs on a timer with no caller to await it, so an
    // unhandled rejection here would take the process down and every parked
    // run with it.
    let ticks = 0;
    const failing = new WorkflowRunner({
      skipLockfile: true,
      runtime: () => null,
      instanceId: "hb-bad",
      leaseRenewMs: 5,
      // A `now` that throws makes `renewLeases()` reject before it reaches
      // the DB, which is the cheapest honest way to fail that call.
      now: () => {
        ticks++;
        throw new Error("clock unavailable");
      },
    });
    await failing.start();
    try {
      const deadline = Date.now() + 2_000;
      while (ticks < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // Repeated firing is the property. "It did not throw" would also be
      // true of a heartbeat that died on its first rejection — which is the
      // bug: claims would silently lapse 60s later.
      expect(ticks).toBeGreaterThanOrEqual(3);
    } finally {
      await failing.stop();
    }
  });
});

describe("the daemon must not destroy a run parked on an unanswered approval", () => {
  test("one tick leaves the run suspended and its approval pending", async () => {
    // Driven through the REAL executor: the claim takes the row to
    // `running`, and everything that then decides the run's fate is inside
    // `resumeWorkflow`. A stub that answers `success` proves none of it.
    const approvalId = await approvalParkedRun("gated-1");
    const d = runner(liveRuntime());

    await d.tick();
    await d.drain();

    const row = await getWorkflowRunRow("gated-1");
    // THE property. A parked decision that the daemon terminalizes is a
    // consent gate nobody can ever answer — the wake interval is 5s, so
    // no human is fast enough.
    expect(row?.status).toBe("suspended");
    expect(row?.result).toBeNull();
    // And the question is still on the table.
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("the claim is handed back, so the answer surface is not locked out", async () => {
    // Leaving the row at `running` under a 60s lease would be a quieter
    // version of the same bug: `answerApproval` refuses a run that is not
    // `suspended` (`workflow-answer-approval.ts:192-198`), so a human
    // answering inside that window is told the run is unavailable.
    const approvalId = await approvalParkedRun("gated-2");
    const d = runner(liveRuntime());

    await d.tick();
    await d.drain();

    const row = await getWorkflowRunRow("gated-2");
    expect(row?.claimedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("it survives repeated ticks, not just the first", async () => {
    // The daemon wakes every 5s forever. A fix that merely survives one
    // pass — by leaving the row somewhere the next pass then eats — is not
    // a fix, and a single-tick test would not tell them apart.
    const approvalId = await approvalParkedRun("gated-3");
    const d = runner(liveRuntime());

    for (let i = 0; i < 3; i++) {
      await d.tick();
      await d.drain();
    }

    expect((await getWorkflowRunRow("gated-3"))?.status).toBe("suspended");
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });
});

describe("the daemon can actually resume the runs it claims", () => {
  test("a run parked for a NON-approval reason runs to completion", async () => {
    // The other half of the same defect, and the half no consent check
    // would ever have caught: a parent parked at `nested-suspended`
    // (`workflow-executor.ts:1931`) has no approval of its own, so it was
    // terminalized on the daemon's first tick with nothing to protect it.
    // Driven through the REAL executor, because "the daemon resumes work"
    // is a claim about the executor accepting the resume.
    await parkedRun("plain-1");
    const d = runner(liveRuntime());

    await d.tick();
    await d.drain();

    const row = await getWorkflowRunRow("plain-1");
    // Not merely "not error" — the step's own output is on the row, so
    // the graph really ran rather than being waved through.
    expect(row?.status).toBe("success");
    expect(row?.result?.output).toEqual({ v: "1" });
  });
});

describe("the status guard still refuses everyone it was aimed at", () => {
  /** The row as the daemon leaves it mid-resume: `running`, under claim. */
  async function claimedRow(id: string) {
    await parkedRun(id);
    expect(await claimWorkflowRun({ workflowRunId: id, claimedBy: "inst-A", now: T0 })).toBe(true);
    return (await getWorkflowRunRow(id))!;
  }

  test("a caller naming NO instance is refused, and the run is terminalized", async () => {
    // The double-execution guard (`workflow-runner.ts:17-21`): a `running`
    // run is being driven by someone, and a caller that cannot say it holds
    // the claim has no standing to resume it.
    const row = await claimedRow("guard-1");
    const rt = liveRuntime();

    const run = await rt.workflowExecutor.resumeWorkflow(definition, resumeArgsFromRow(row));

    expect(run.status).toBe("error");
    expect(run.result?.error).toMatchObject({ code: "not-resumable" });
  });

  test("a caller naming the WRONG instance is refused too", async () => {
    // The check is against `claimed_by` on the ROW, so an identity that
    // does not hold the lease buys nothing. Without this the parameter
    // would be a self-certification and the guard would be decorative.
    const row = await claimedRow("guard-2");
    const rt = liveRuntime();

    const run = await rt.workflowExecutor.resumeWorkflow(
      definition,
      resumeArgsFromRow(row),
      undefined,
      { resumedBy: "inst-B" },
    );

    expect(run.status).toBe("error");
    expect(run.result?.error).toMatchObject({ code: "not-resumable" });
  });

  test("a TERMINAL run is refused however the caller identifies itself", async () => {
    // The guard's original job, untouched: naming an instance must not be
    // a way to resume a run that is already over.
    await parkedRun("guard-3");
    await claimWorkflowRun({ workflowRunId: "guard-3", claimedBy: "inst-A", now: T0 });
    await db.execute(sql`UPDATE workflow_runs SET status = 'success' WHERE id = 'guard-3'`);
    const row = (await getWorkflowRunRow("guard-3"))!;
    const rt = liveRuntime();

    const run = await rt.workflowExecutor.resumeWorkflow(
      definition,
      resumeArgsFromRow(row),
      undefined,
      { resumedBy: "inst-A" },
    );

    expect(run.status).toBe("error");
    expect(run.result?.error).toMatchObject({ code: "not-resumable" });
  });

  test("the matching instance IS let through, and the run continues", async () => {
    const row = await claimedRow("guard-4");
    const rt = liveRuntime();

    const run = await rt.workflowExecutor.resumeWorkflow(
      definition,
      resumeArgsFromRow(row),
      undefined,
      { resumedBy: "inst-A" },
    );

    expect(run.status).toBe("success");
  });
});

describe("releaseWorkflowRunClaim releases exactly one run", () => {
  test("hands back the named claim and leaves this instance's others alone", async () => {
    // Why the singular form exists: the plural one matches every claim
    // this instance holds at a boundary, which is where a healthy resume
    // sits BETWEEN batches. Reusing it to give one run back would yank
    // the claims out from under every concurrent resume.
    await parkedRun("one");
    await parkedRun("two");
    await claimWorkflowRun({ workflowRunId: "one", claimedBy: "A", now: T0 });
    await claimWorkflowRun({ workflowRunId: "two", claimedBy: "A", now: T0 });

    expect(await releaseWorkflowRunClaim("one", "A")).toBe(1);

    const one = await getWorkflowRunRow("one");
    expect(one?.status).toBe("suspended");
    expect(one?.claimedBy).toBeNull();
    expect(one?.leaseExpiresAt).toBeNull();
    const two = await getWorkflowRunRow("two");
    expect(two?.status).toBe("running");
    expect(two?.claimedBy).toBe("A");
  });

  test("will not release another instance's claim", async () => {
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });

    expect(await releaseWorkflowRunClaim("r1", "B")).toBe(0);
    expect((await getWorkflowRunRow("r1"))?.claimedBy).toBe("A");
  });

  test("will not release an IN-BATCH run — the sweep owns that call", async () => {
    // Same reasoning as the plural form: `in-batch` means side effects may
    // be mid-flight, so handing the run to a sibling invites re-execution.
    await parkedRun("r1");
    await claimWorkflowRun({ workflowRunId: "r1", claimedBy: "A", now: T0 });
    await db.execute(sql`UPDATE workflow_runs SET run_phase = 'in-batch' WHERE id = 'r1'`);

    expect(await releaseWorkflowRunClaim("r1", "A")).toBe(0);
    expect((await getWorkflowRunRow("r1"))?.status).toBe("running");
  });
});

describe("a loop over a nested run that parks on an approval", () => {
  /**
   * Answer the pending gate on a child, through the ONE sanctioned path.
   *
   * `answerApproval`, not a raw `recordWorkflowApprovalAnswer`: the
   * question is whether a HUMAN can still unblock this run after the
   * daemon has been at it, and the human's path includes the run-status
   * check that a held claim used to fail.
   */
  async function answerChildGate(runtime: WorkflowRuntime, childId: string): Promise<void> {
    const approval = await getWorkflowApproval(childId, "ok");
    expect(approval?.status).toBe("pending");
    const res = await answerApproval(
      approval!.id,
      { choice: "go" },
      // The run carries no `user_id`. "Unowned" must never read as
      // "anyone's" — a `user` actor is admin-only here, by the same rule
      // `workflow-run-control.ts` uses. This file is not about that rule,
      // so it answers as the system actor, the one kind that legitimately
      // has no `users` row behind it.
      { kind: "system-timeout" },
      { runtime },
    );
    expect(res.ok).toBe(true);
  }

  test("parent and child both survive the daemon, then the loop replays to completion", async () => {
    const runtime = liveRuntime();
    const d = runner(runtime);

    // ── Park: iteration 1's child stops on its gate, parent stops with it
    const parked = await runtime.workflowExecutor.runWorkflow(loopParent, {});
    expect(parked.status).toBe("suspended");
    const parentRow = await getWorkflowRunRow(parked.id);
    // The parent's OWN reason. It holds no `workflow_approvals` row, which
    // is why no amount of reordering the consent check could have saved it.
    expect(parentRow?.suspendedReason).toBe("nested-suspended");
    const afterPark = await childrenOf(parked.id);
    expect(afterPark.map((c) => c.key)).toEqual([nestedRunKey(parked.id, "attempt", 1)]);
    const child1 = afterPark[0]!.id;

    // ── Q1 + Q2: one tick with BOTH parked destroys neither ────────────
    await d.tick();
    await d.drain();

    expect((await getWorkflowRunRow(parked.id))?.status).toBe("suspended");
    expect((await getWorkflowRunRow(child1))?.status).toBe("suspended");
    expect((await getWorkflowApproval(child1, "ok"))?.status).toBe("pending");
    // The parent re-entered its loop step and found the SAME child rather
    // than dispatching a second one for iteration 1.
    expect(await childrenOf(parked.id)).toHaveLength(1);
    expect((await childrenOf(parked.id))[0]!.id).toBe(child1);

    // ── Q3: answer iteration 1, let the daemon carry the parent forward ─
    await answerChildGate(runtime, child1);
    expect((await getWorkflowRunRow(child1))?.status).toBe("success");

    await d.tick();
    await d.drain();

    // Iteration 1 was served from child1's recorded row — same id, not
    // re-executed — and iteration 2 dispatched a NEW child, which parked.
    const afterSecond = await childrenOf(parked.id);
    expect(afterSecond).toHaveLength(2);
    expect(afterSecond[0]!.id).toBe(child1);
    expect(afterSecond.map((c) => c.key)).toEqual([
      nestedRunKey(parked.id, "attempt", 1),
      nestedRunKey(parked.id, "attempt", 2),
    ]);
    const child2 = afterSecond[1]!.id;
    expect((await getWorkflowRunRow(child2))?.status).toBe("suspended");
    expect((await getWorkflowRunRow(parked.id))?.status).toBe("suspended");

    // ── Answer iteration 2; the loop budget is spent, so the parent ends
    await answerChildGate(runtime, child2);

    await d.tick();
    await d.drain();

    expect((await getWorkflowRunRow(parked.id))?.status).toBe("success");
    // THE replay property, stated as a count: exactly one child per
    // iteration across three parks and three resumes. A parent that
    // re-executed a finished iteration instead of reading its row would
    // have duplicated every side effect that child applied.
    const final = await childrenOf(parked.id);
    expect(final).toHaveLength(LOOP_ITERATIONS);
    expect(final.map((c) => c.id)).toEqual([child1, child2]);
  });

  test("the parent is never terminalized while its child waits, tick after tick", async () => {
    // The daemon wakes every 5s forever. The parent has no approval of its
    // own, so nothing about the consent gate protects it — only the status
    // guard reading `running` as "claimed by me" keeps it alive.
    const runtime = liveRuntime();
    const d = runner(runtime);
    const parked = await runtime.workflowExecutor.runWorkflow(loopParent, {});
    const child1 = (await childrenOf(parked.id))[0]!.id;

    for (let i = 0; i < 3; i++) {
      await d.tick();
      await d.drain();
    }

    const row = await getWorkflowRunRow(parked.id);
    expect(row?.status).toBe("suspended");
    expect(row?.suspendedReason).toBe("nested-suspended");
    expect(row?.claimedBy).toBeNull();
    // And the child is still answerable, which is the point of all of it.
    expect((await getWorkflowApproval(child1, "ok"))?.status).toBe("pending");
    // Still one child — three ticks did not dispatch three more.
    expect(await childrenOf(parked.id)).toHaveLength(1);
  });
});

describe("resumeArgsFromRow", () => {
  test("projects every field resumeWorkflow reads off a run row", async () => {
    await parkedRun("r1", "proj-9");
    const row = await getWorkflowRunRow("r1");

    const args = resumeArgsFromRow(row!);

    // Named individually on purpose: this projection is the one place a
    // column the resume path depends on can be forgotten, and a missing
    // field arrives as `undefined` rather than as a failure.
    expect(args).toEqual({
      id: "r1",
      workflowName: "parked",
      status: "suspended",
      input: {},
      cursor: { batchIndex: 0, completedSteps: [], prevStepName: null },
      definitionHash: null,
      projectId: "proj-9",
      userId: null,
      startedAt: row!.startedAt,
      // C7. A resumed run re-derives its nesting depth by walking this
      // pointer, so a projection that dropped it would resume a nested run
      // at depth 0 — making the nesting cap evadable by parking.
      parentRunId: null,
      // Read by the status guard against the caller's `resumedBy`. Null
      // here because nothing has claimed this run; a projection that
      // dropped it would refuse the daemon on every run it claims, which
      // is the defect this column was threaded through to fix.
      claimedBy: null,
      // C3. The delegation whose `max_tokens_per_run` bounds this run.
      // Null here because this run is not delegated — and a projection
      // that dropped it would silently un-bound every resumed delegated
      // run: it would come back with no ceiling, take no boundary
      // queries, and look perfectly healthy.
      delegationId: null,
    });
  });
});
