/**
 * `answerApproval` — the single chokepoint every answer path clears.
 *
 * Runs against real PGlite with the real `migrate()`, so the CAS
 * semantics and the read-only-before-mutate ordering are verified rather
 * than assumed. The executor is a stub: this file is about the
 * chokepoint's contract, not about resuming.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { WorkflowDefinition, WorkflowRun } from "../types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { answerApproval } = await import("../runtime/workflow-answer-approval");
const { parkWorkflowApproval, getWorkflowApprovalById } = await import(
  "../db/queries/workflow-approvals"
);
const { insertWorkflowRun, getWorkflowRunRow } = await import(
  "../db/queries/workflow-runs"
);

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('answerer', 'a@example.test', 'x', 'Answerer'),
           ('a-reviewer', 'r@example.test', 'x', 'Reviewer')
  `);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

const DEF: WorkflowDefinition = {
  name: "gated",
  description: "",
  steps: [
    { name: "gate", kind: "approval", prompt: "?", choices: ["approve", "reject"] },
  ],
};

/** A runtime whose executor records every resume rather than running one. */
function stubRuntime(workflows: WorkflowDefinition[] = [DEF]) {
  const resumed: string[] = [];
  return {
    resumed,
    runtime: {
      workflowExecutor: {
        async runWorkflow(): Promise<WorkflowRun> {
          throw new Error("not exercised");
        },
        async resumeWorkflow(_w: WorkflowDefinition, row: { id: string }): Promise<WorkflowRun> {
          resumed.push(row.id);
          return {
            id: row.id,
            workflowName: DEF.name,
            status: "success",
            startedAt: Date.now(),
            steps: [],
          };
        },
      },
      getWorkflows: () => workflows,
    },
  };
}

async function seed(
  opts: {
    requireItemConsent?: boolean;
    itemIds?: string[];
    rbacScope?: string;
    /** Who owns the run. Defaults to the user every test answers as —
     *  without a scope, the OWNER is who may answer, so a fixture that
     *  left this null was testing a path that is now (correctly) refused. */
    ownerUserId?: string | null;
  } = {},
): Promise<{ runId: string; approvalId: string }> {
  const runId = crypto.randomUUID();
  await insertWorkflowRun({
    id: runId,
    workflowName: DEF.name,
    input: {},
    startedAt: new Date(),
    userId: opts.ownerUserId === undefined ? "answerer" : opts.ownerUserId,
  });
  await db.execute(sql`UPDATE workflow_runs SET status = 'suspended' WHERE id = ${runId}`);
  const approvalId = await parkWorkflowApproval({
    workflowRunId: runId,
    stepName: "gate",
    prompt: "?",
    choices: ["approve", "reject"],
    requireItemConsent: opts.requireItemConsent ?? false,
    itemIds: opts.itemIds ?? [],
    rbacScope: opts.rbacScope ?? null,
  });
  return { runId, approvalId };
}

describe("answerApproval — the happy path", () => {
  test("records the answer and resumes the run", async () => {
    const { runId, approvalId } = await seed();
    const { runtime, resumed } = stubRuntime();

    const res = await answerApproval(
      approvalId,
      { choice: "approve", form: { note: "ok" } },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(resumed).toEqual([runId]);

    const row = await getWorkflowApprovalById(approvalId);
    expect(row?.status).toBe("answered");
    expect(row?.answerChoice).toBe("approve");
    expect(row?.answeredBy).toBe("answerer");
    expect(row?.answerForm).toEqual({ note: "ok" });
    // Not a blanket clear, so nothing to flag.
    expect(row?.consentAllUsed).toBe(false);
  });

  test("records the consent-all marker when standing consent was used", async () => {
    const { approvalId } = await seed({ requireItemConsent: true, itemIds: ["i1"] });
    const { runtime } = stubRuntime();

    const res = await answerApproval(
      approvalId,
      { choice: "approve", consentAll: true },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.message);
    expect(res.consentAllUsed).toBe(true);
    // A blanket clear is permitted but never silent.
    expect((await getWorkflowApprovalById(approvalId))?.consentAllUsed).toBe(true);
  });
});

describe("answerApproval — refusals never mutate", () => {
  /** Assert the approval and its run are byte-identical to before. */
  async function expectUntouched(approvalId: string, runId: string) {
    const row = await getWorkflowApprovalById(approvalId);
    expect(row?.status).toBe("pending");
    expect(row?.answerChoice).toBeNull();
    expect(row?.answeredBy).toBeNull();
    expect((await getWorkflowRunRow(runId))?.status).toBe("suspended");
  }

  test("an unknown approval is not-found", async () => {
    const { runtime, resumed } = stubRuntime();
    const res = await answerApproval(
      crypto.randomUUID(),
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("not-found");
    expect(resumed).toEqual([]);
  });

  test("an already-answered approval is not-pending, reported distinctly", async () => {
    const { approvalId } = await seed();
    const { runtime } = stubRuntime();
    await answerApproval(approvalId, { choice: "approve" }, { kind: "user", userId: "answerer", isAdmin: false }, { runtime });

    const second = await answerApproval(
      approvalId,
      { choice: "reject" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected refusal");
    // Distinct from not-found so a surface can say "someone got there
    // first" rather than implying it never existed.
    expect(second.code).toBe("not-pending");
    // The first answer stands.
    expect((await getWorkflowApprovalById(approvalId))?.answerChoice).toBe("approve");
  });

  test("a DENIED scope refuses and leaves the run untouched", async () => {
    const { runId, approvalId } = await seed({ rbacScope: "workflows:approve" });
    const { runtime, resumed } = stubRuntime();

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime, checkScope: async () => false },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("forbidden");
    expect(resumed).toEqual([]);
    await expectUntouched(approvalId, runId);
  });

  test("a scope check that THROWS is a deny, not a crash and not an allow", async () => {
    // Ported invariant 17: an identity the host cannot resolve can never
    // satisfy a grant, and the refusal is 403-shaped rather than a 500.
    const { runId, approvalId } = await seed({ rbacScope: "workflows:approve" });
    const { runtime, resumed } = stubRuntime();

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      // A `user` actor, deliberately, and NOT one of the non-human kinds:
      // those are refused on the scoped branch BY KIND, before
      // `checkScope` is reached. Handing this case a `system-timeout`
      // actor would still produce `ok: false` while never invoking the
      // resolver — the test would pass without exercising the
      // throw-is-a-deny path it exists for.
      { kind: "user", userId: "answerer", isAdmin: false },
      {
        runtime,
        checkScope: async () => {
          throw new Error("identity service unavailable");
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("forbidden");
    expect(resumed).toEqual([]);
    await expectUntouched(approvalId, runId);
  });

  test("a missing scope checker denies a scoped approval", async () => {
    // Fail closed: no checker wired means no grant can be demonstrated.
    const { runId, approvalId } = await seed({ rbacScope: "workflows:approve" });
    const { runtime } = stubRuntime();
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("forbidden");
    await expectUntouched(approvalId, runId);
  });

  test("a granted scope passes through", async () => {
    const { approvalId } = await seed({ rbacScope: "workflows:approve" });
    const { runtime } = stubRuntime();
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime, checkScope: async () => true },
    );
    expect(res.ok).toBe(true);
  });

  test("a guard failure refuses and leaves the run untouched", async () => {
    const { runId, approvalId } = await seed({ requireItemConsent: true, itemIds: ["i1"] });
    const { runtime, resumed } = stubRuntime();

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("invalid-answer");
    expect(res.message).toContain("must name the itemIds");
    expect(resumed).toEqual([]);
    await expectUntouched(approvalId, runId);
  });

  test("an undeclared choice refuses", async () => {
    const { runId, approvalId } = await seed();
    const { runtime } = stubRuntime();
    const res = await answerApproval(
      approvalId,
      { choice: "maybe" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("invalid-answer");
    await expectUntouched(approvalId, runId);
  });

  test("refuses BEFORE recording when the run cannot be resumed", async () => {
    // Order matters: an answer written against a run we cannot resume
    // would leave the approval `answered` and the run parked forever,
    // with no surface able to retry.
    const { runId, approvalId } = await seed();
    const { runtime } = stubRuntime([]); // definition no longer registered

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("run-unavailable");
    await expectUntouched(approvalId, runId);
  });

  test("refuses when no runtime is registered at all", async () => {
    const { runId, approvalId } = await seed();
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime: null },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("run-unavailable");
    await expectUntouched(approvalId, runId);
  });

  test("refuses when the run row is gone", async () => {
    const { runId, approvalId } = await seed();
    const { runtime } = stubRuntime();
    // CASCADE removes the approval too, so re-park one orphaned of its
    // run by deleting the run after reading the id.
    await db.execute(sql`DELETE FROM workflow_runs WHERE id = ${runId}`);
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    // The approval went with its run, so this reads as not-found —
    // which is correct: there is nothing left to answer.
    expect(res.code).toBe("not-found");
  });
});

describe("answerApproval — concurrency", () => {
  test("two simultaneous answers produce exactly one winner", async () => {
    const { approvalId } = await seed();
    const { runtime, resumed } = stubRuntime();

    const [a, b] = await Promise.all([
      answerApproval(approvalId, { choice: "approve" }, { kind: "user", userId: "answerer", isAdmin: false }, { runtime }),
      answerApproval(approvalId, { choice: "reject" }, { kind: "user", userId: "answerer", isAdmin: false }, { runtime }),
    ]);

    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser is a clean refusal, never an overwrite — and it names
    // the race rather than looking like a validation failure.
    const loser = losers[0] as { ok: false; code: string };
    expect(["lost-race", "not-pending"]).toContain(loser.code);
    // And the run is resumed exactly ONCE.
    expect(resumed).toHaveLength(1);
  });
});

describe("the chokepoint is structurally single", () => {
  test("the module exports exactly one callable — nothing to bypass it with", async () => {
    // The structural half of ported invariant 7. The behavioural half —
    // asserting each of the three surfaces routes through this function
    // by CALL-COUNT on a spy — lands with the surfaces themselves; there
    // are no answer paths to count yet.
    //
    // What this pins today is that a future surface cannot reassemble
    // the sequence out of exported parts: authorization, the consent
    // guard, the CAS and the resume are all non-exported. If someone
    // exports a helper to "reuse" it, this fails, which is the moment
    // to ask why they are not calling `answerApproval`.
    const mod = await import("../runtime/workflow-answer-approval");
    const callables = Object.entries(mod)
      .filter(([, v]) => typeof v === "function")
      .map(([k]) => k);
    expect(callables).toEqual(["answerApproval"]);
  });
});

describe("answerApproval — never reports success for a dead run", () => {
  test("refuses when the run is no longer suspended, before spending the answer", async () => {
    // The guarantee the pre-flight comment promised and did not
    // implement. A run terminalized while its approval was still
    // pending would otherwise have its answer recorded and CONSUMED,
    // then fail to resume, while the caller was told it worked.
    const { runId, approvalId } = await seed();
    await db.execute(sql`UPDATE workflow_runs SET status = 'error' WHERE id = ${runId}`);

    const { runtime, resumed } = stubRuntime();
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("run-unavailable");
    expect(resumed).toEqual([]);
    // The answer is NOT spent — the CAS is still available for a retry
    // once whatever killed the run is understood.
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("pending");
  });

  test("a resume that fails is reported as a refusal, not ok:true", async () => {
    // Previously this returned `{ ok: true }`, which the route mapped to
    // HTTP 200 — telling the user their approval succeeded while the
    // workflow was dead and their answer already spent.
    const { approvalId } = await seed();
    const failing = {
      workflowExecutor: {
        async runWorkflow(): Promise<WorkflowRun> {
          throw new Error("not exercised");
        },
        async resumeWorkflow(_w: WorkflowDefinition, row: { id: string }): Promise<WorkflowRun> {
          return {
            id: row.id,
            workflowName: DEF.name,
            status: "error",
            startedAt: Date.now(),
            finishedAt: Date.now(),
            steps: [],
            result: {
              success: false,
              output: null,
              error: { code: "definition-changed", message: "graph drifted" },
            },
          };
        },
      },
      getWorkflows: () => [DEF],
    };

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime: failing },
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected refusal");
    expect(res.code).toBe("resume-failed");
    // Honest on both counts: the human DID decide, and the run did not
    // continue. Saying only one of those would mislead.
    expect(res.message).toContain("Your answer was recorded");
    expect(res.message).toContain("graph drifted");
    expect((await getWorkflowApprovalById(approvalId))?.status).toBe("answered");
  });
});

describe("authorization — who may answer", () => {
  test("a STRANGER cannot answer an approval that declares no scope", async () => {
    // The hole this closes: `rbacScope` is null by default — every
    // `approval` step without an explicit one — and the scope check simply
    // did not run. Nothing else consulted the run, so any authenticated
    // caller could clear any other user's consent gate through either
    // answer surface.
    const { approvalId } = await seed({ ownerUserId: "answerer" });

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "someone-else", isAdmin: false },
      { runtime: stubRuntime().runtime },
    );

    expect(res).toMatchObject({ ok: false, code: "forbidden" });
    // Asserted on the ROW: a refusal that still recorded the answer would
    // be worse than no check at all.
    const row = await getWorkflowApprovalById(approvalId);
    expect(row?.status).toBe("pending");
    expect(row?.answeredBy).toBeNull();
  });

  test("the OWNER may answer their own", async () => {
    const { approvalId } = await seed({ ownerUserId: "answerer" });
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime: stubRuntime().runtime },
    );
    expect(res.ok).toBe(true);
  });

  test("an UNOWNED run (CLI, extension trigger) is admin-only", async () => {
    const a = await seed({ ownerUserId: null });
    expect(
      await answerApproval(a.approvalId, { choice: "approve" }, { kind: "user", userId: "answerer", isAdmin: false }, { runtime: stubRuntime().runtime }),
    ).toMatchObject({ ok: false, code: "forbidden" });

    const b = await seed({ ownerUserId: null });
    expect(
      await answerApproval(
        b.approvalId,
        { choice: "approve" },
        { kind: "user", userId: "answerer", isAdmin: true },
        { runtime: stubRuntime().runtime },
      ),
    ).toMatchObject({ ok: true });
  });

  test("a DECLARED scope still decides on its own — ownership is not also required", async () => {
    // Deliberate: an approval can be raised precisely so someone other
    // than the run's owner (a reviewer) answers it. Requiring both would
    // break that, so the scope branch is an alternative, not an addition.
    const { approvalId } = await seed({ ownerUserId: "answerer", rbacScope: "workflows:approve" });

    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      { kind: "user", userId: "a-reviewer", isAdmin: false },
      { runtime: stubRuntime().runtime, checkScope: async () => true },
    );

    expect(res.ok).toBe(true);
  });

  test("a declared scope the actor lacks is still refused", async () => {
    const { approvalId } = await seed({ ownerUserId: "answerer", rbacScope: "workflows:approve" });
    const res = await answerApproval(
      approvalId,
      { choice: "approve" },
      // Even the OWNER is refused when the scope is declared and unmet —
      // a declared scope raises the bar, it does not lower it.
      { kind: "user", userId: "answerer", isAdmin: false },
      { runtime: stubRuntime().runtime, checkScope: async () => false },
    );
    expect(res).toMatchObject({ ok: false, code: "forbidden" });
  });
});
