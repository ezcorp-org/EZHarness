/**
 * `resumeParkedRun` / `cancelParkedRun` — the operator's two levers over a
 * durable run.
 *
 * Real PGlite + a real `WorkflowExecutor`, because the property that
 * matters most here is not one this module implements: that resume CANNOT
 * clear a pending consent gate. That guarantee lives in the executor, and
 * this module's whole design is to rely on it rather than re-derive it.
 * Stubbing the executor would test the stub's opinion of consent instead
 * of the real one — which is precisely the second-opinion drift ported
 * invariant 7 exists to prevent.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
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

const { resumeParkedRun, cancelParkedRun } = await import("../runtime/workflow-run-control");
const { getWorkflowRunRow, insertWorkflowRun, suspendWorkflowRun, finalizeWorkflowRunRow } =
  await import("../db/queries/workflow-runs");
const {
  getWorkflowApproval,
  parkWorkflowApproval,
  recordWorkflowApprovalAnswer,
  listPendingWorkflowApprovals,
  listPendingWorkflowApprovalsForUser,
} = await import("../db/queries/workflow-approvals");
const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { EventBus } = await import("../runtime/events");
const { AgentExecutor } = await import("../runtime/executor");
const { loadAgentsStatic } = await import("../runtime/loader");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('owner', 'o@example.test', 'x', 'Owner'), ('stranger', 's@example.test', 'x', 'Stranger')
  `);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM workflow_approvals`);
  await db.execute(sql`DELETE FROM workflow_step_runs`);
  await db.execute(sql`DELETE FROM workflow_runs`);
});

const T0 = new Date("2026-07-30T09:00:00.000Z");
const OWNER = { userId: "owner" };
const STRANGER = { userId: "stranger" };
const ADMIN = { userId: "stranger", isAdmin: true };

const trivial: WorkflowDefinition = {
  name: "trivial",
  description: "",
  steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
};

/** A graph that parks on an approval, which is what makes the consent
 *  boundary reachable through the REAL executor. */
const gated: WorkflowDefinition = {
  name: "gated",
  description: "",
  steps: [
    { name: "gate", kind: "approval", prompt: "Ship it?", choices: ["approve"] } as WorkflowStep,
  ],
};

function realExecutor() {
  const bus = new EventBus<AgentEvents>();
  return new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
    persist: true,
  });
}

function runtimeFor(workflows: WorkflowDefinition[], exec = realExecutor()): WorkflowRuntime {
  return {
    getWorkflows: () => workflows,
    workflowExecutor: exec as unknown as WorkflowRuntime["workflowExecutor"],
  };
}

/** A run parked at `suspended`, owned by `userId`. */
async function parked(id: string, userId: string | null = "owner"): Promise<void> {
  await insertWorkflowRun({
    id,
    workflowName: trivial.name,
    input: {},
    startedAt: T0,
    userId,
    definitionHash: null,
  });
  expect(
    await suspendWorkflowRun(id, {
      reason: "manual",
      cursor: { batchIndex: 1, completedSteps: ["a"], prevStepName: "a" },
    }),
  ).toBe(1);
}

describe("resume — preconditions", () => {
  test("a run that does not exist is not-found", async () => {
    const r = await resumeParkedRun("ghost", OWNER, { runtime: runtimeFor([trivial]) });
    expect(r).toMatchObject({ ok: false, code: "not-found" });
  });

  test("a stranger is refused, and the refusal leaks nothing about the run", async () => {
    await parked("r1");
    const r = await resumeParkedRun("r1", STRANGER, { runtime: runtimeFor([trivial]) });

    expect(r).toMatchObject({ ok: false, code: "forbidden" });
    // The message must not name the workflow or its state — a 403 that
    // describes the run is an existence oracle.
    expect((r as { message: string }).message).not.toContain("trivial");
    expect((r as { message: string }).message).not.toContain("suspended");
    // And it is untouched.
    expect((await getWorkflowRunRow("r1"))?.status).toBe("suspended");
  });

  test("an admin may control a run they do not own", async () => {
    await parked("r1");
    const r = await resumeParkedRun("r1", ADMIN, { runtime: runtimeFor([trivial]) });
    expect(r.ok).toBe(true);
  });

  test("an UNOWNED run (CLI, extension trigger) is admin-only", async () => {
    // Treating "no owner" as "anyone's" would make every CLI-started run
    // controllable by every logged-in member.
    await parked("r1", null);
    expect(await resumeParkedRun("r1", OWNER, { runtime: runtimeFor([trivial]) })).toMatchObject({
      ok: false,
      code: "forbidden",
    });
    expect((await resumeParkedRun("r1", ADMIN, { runtime: runtimeFor([trivial]) })).ok).toBe(true);
  });

  test("a run that is not suspended cannot be resumed", async () => {
    // A `running` run is already being driven — by the synchronous path or
    // by a daemon holding its lease — and resuming it would execute the
    // same batch twice.
    await insertWorkflowRun({
      id: "live",
      workflowName: trivial.name,
      input: {},
      startedAt: T0,
      userId: "owner",
      definitionHash: null,
    });
    const r = await resumeParkedRun("live", OWNER, { runtime: runtimeFor([trivial]) });
    expect(r).toMatchObject({ ok: false, code: "not-resumable" });
    expect((r as { message: string }).message).toContain("running");
  });

  test("no registered runtime is a refusal, not a crash", async () => {
    await parked("r1");
    expect(await resumeParkedRun("r1", OWNER, { runtime: null })).toMatchObject({
      ok: false,
      code: "run-unavailable",
    });
  });

  test("a workflow that no longer exists is a refusal naming it", async () => {
    await parked("r1");
    const r = await resumeParkedRun("r1", OWNER, { runtime: runtimeFor([]) });
    expect(r).toMatchObject({ ok: false, code: "run-unavailable" });
    expect((r as { message: string }).message).toContain("trivial");
  });
});

describe("resume — the consent boundary", () => {
  test("a run parked on an UNANSWERED approval is refused and stays answerable", async () => {
    // The property this whole module is built around. Driven through the
    // real executor so the guarantee under test is the real one: resume
    // takes no choice and must not be able to step over a consent gate.
    const exec = realExecutor();
    const parkedRun = await exec.runWorkflow(gated, {}, undefined, "owner");
    expect(parkedRun.status).toBe("suspended");

    const r = await resumeParkedRun(parkedRun.id, OWNER, {
      runtime: runtimeFor([gated], exec),
    });

    expect(r).toMatchObject({ ok: false, code: "resume-failed" });
    expect((r as { message: string }).message).toContain("approval");

    // Asserted on the ROWS, not on the returned object. The refusal must be
    // TRANSIENT: a guard that blocked the bypass by killing the run would
    // be a denial of service dressed as a security control — the exact
    // shape of the critical defect this program already hit once.
    const row = await getWorkflowRunRow(parkedRun.id);
    expect(row?.status).toBe("suspended");
    expect(row?.finishedAt).toBeNull();
    expect((await getWorkflowApproval(parkedRun.id, "gate"))?.status).toBe("pending");
  });
});

describe("resume — success", () => {
  test("a resumable run continues and comes back with its run object", async () => {
    await parked("r1");
    const r = await resumeParkedRun("r1", OWNER, { runtime: runtimeFor([trivial]) });

    expect(r.ok).toBe(true);
    expect((r as { run: { id: string } }).run.id).toBe("r1");
    // The row moved off `suspended` — the returned object alone would not
    // prove the run actually went anywhere.
    expect((await getWorkflowRunRow("r1"))?.status).not.toBe("suspended");
  });
});

describe("cancel", () => {
  test("a parked run is cancelled, and the ROW records it", async () => {
    await parked("r1");
    const r = await cancelParkedRun("r1", OWNER);

    expect(r).toMatchObject({ ok: true, cancelled: true });
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("cancelled");
    expect(row?.finishedAt).not.toBeNull();
    expect(String((row?.result as { error?: unknown })?.error)).toContain("owner");
  });

  test("a RUNNING run can also be cancelled", async () => {
    await insertWorkflowRun({
      id: "live",
      workflowName: trivial.name,
      input: {},
      startedAt: T0,
      userId: "owner",
      definitionHash: null,
    });
    expect((await cancelParkedRun("live", OWNER)).ok).toBe(true);
    expect((await getWorkflowRunRow("live"))?.status).toBe("cancelled");
  });

  test("cancelling an already-terminal run is a clean refusal, not an overwrite", async () => {
    await parked("r1");
    await finalizeWorkflowRunRow("r1", "success", { success: true, output: { done: true } });

    const r = await cancelParkedRun("r1", OWNER);

    expect(r).toMatchObject({ ok: false, code: "already-terminal" });
    // The CAS is what makes this safe: the richer terminal state survives.
    const row = await getWorkflowRunRow("r1");
    expect(row?.status).toBe("success");
    expect(row?.result).toMatchObject({ success: true });
  });

  test("a stranger cannot cancel, and the run survives", async () => {
    await parked("r1");
    expect(await cancelParkedRun("r1", STRANGER)).toMatchObject({ ok: false, code: "forbidden" });
    expect((await getWorkflowRunRow("r1"))?.status).toBe("suspended");
  });

  test("an admin may cancel a run they do not own", async () => {
    await parked("r1");
    expect((await cancelParkedRun("r1", ADMIN)).ok).toBe(true);
  });

  test("cancelling a run that does not exist is not-found", async () => {
    expect(await cancelParkedRun("ghost", OWNER)).toMatchObject({ ok: false, code: "not-found" });
  });
});

describe("the approvals inbox is scoped by the RUN's owner", () => {
  /** A pending approval on a run owned by `userId`. */
  async function pendingOn(runId: string, userId: string | null, step: string) {
    await insertWorkflowRun({
      id: runId,
      workflowName: trivial.name,
      input: {},
      startedAt: T0,
      userId,
      definitionHash: null,
    });
    await parkWorkflowApproval({
      workflowRunId: runId,
      stepName: step,
      prompt: `secret plan for ${runId}`,
      choices: ["approve"],
      requireItemConsent: false,
      itemIds: [],
    });
  }

  test("a user sees only their own, never another user's", async () => {
    await pendingOn("mine", "owner", "s1");
    await pendingOn("theirs", "stranger", "s2");

    const mine = await listPendingWorkflowApprovalsForUser("owner");

    expect(mine.map((p) => p.workflowRunId)).toEqual(["mine"]);
    // The leak this scoping exists to prevent is the PROMPT, which names
    // what is about to be done and to what.
    expect(JSON.stringify(mine)).not.toContain("secret plan for theirs");
  });

  test("an UNOWNED run's approval is invisible to a member and visible to an admin", async () => {
    await pendingOn("cli", null, "s1");

    expect(await listPendingWorkflowApprovalsForUser("owner")).toEqual([]);
    expect(
      (await listPendingWorkflowApprovalsForUser("owner", true)).map((p) => p.workflowRunId),
    ).toEqual(["cli"]);
  });

  test("an admin sees every pending approval — the same set the sweep sees", async () => {
    await pendingOn("mine", "owner", "s1");
    await pendingOn("theirs", "stranger", "s2");

    const admin = await listPendingWorkflowApprovalsForUser("owner", true);
    const sweep = await listPendingWorkflowApprovals();

    expect(admin.map((p) => p.approval.id).sort()).toEqual(sweep.map((a) => a.id).sort());
  });

  test("an ANSWERED approval leaves the inbox", async () => {
    await pendingOn("mine", "owner", "s1");
    const [only] = await listPendingWorkflowApprovalsForUser("owner");
    expect(await recordWorkflowApprovalAnswer(only!.approval.id, { choice: "approve" })).toBe(1);
    expect(await listPendingWorkflowApprovalsForUser("owner")).toEqual([]);
  });

  test("it carries the workflow NAME, which is the only thing making a row recognisable", async () => {
    await pendingOn("mine", "owner", "s1");
    const [row] = await listPendingWorkflowApprovalsForUser("owner");
    expect(row?.workflowName).toBe("trivial");
    expect(row?.approval.stepName).toBe("s1");
  });
});
