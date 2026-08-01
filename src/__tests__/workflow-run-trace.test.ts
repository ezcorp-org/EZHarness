/**
 * Reading a workflow run's trace: the authorization matrix, the payload
 * shape, and keyset pagination.
 *
 * The authorization block is the reason this file exists. A trace carries
 * `resolved_input` and `output` — redacted, but redaction is a loose regex
 * pass over credential SHAPES, not a guarantee — so the ownership rule is
 * the real control and every cell of the matrix is asserted per-status
 * rather than "does not 200".
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

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
  getWorkflowRunTrace,
  listWorkflowRunsForCaller,
  RUN_PAGE_DEFAULT,
  RUN_PAGE_MAX,
} = await import("../runtime/workflow-run-trace");
const { upsertWorkflowStepRun } = await import("../db/queries/workflow-runs");
const { upsertWorkflowStepIteration } = await import("../db/queries/workflow-step-iterations");

const OWNER = { userId: "user-owner", isAdmin: false };
const STRANGER = { userId: "user-stranger", isAdmin: false };
const ADMIN = { userId: "user-admin", isAdmin: true };
/** An API key minted with no owner still presents SOME principal id; the
 *  point is that it is not the run's initiator and is not an admin. */
const KEYLESS = { userId: "api-key-no-user", isAdmin: false };

/** A run owned by `userId` (or unowned when null), with one step. */
async function seedRun(opts: {
  id: string;
  userId: string | null;
  workflowName?: string;
  startedAt?: string;
  status?: string;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO workflow_runs (id, workflow_name, status, started_at, user_id)
    VALUES (
      ${opts.id}, ${opts.workflowName ?? "nightly"}, ${opts.status ?? "success"},
      ${opts.startedAt ?? "2026-07-01T00:00:00Z"}, ${opts.userId}
    )
  `);
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  for (const id of ["user-owner", "user-stranger", "user-admin"]) {
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (${id}, ${`${id}@example.test`}, 'x', ${id})
    `);
  }
  await seedRun({ id: "run-owned", userId: "user-owner" });
  await seedRun({ id: "run-unowned", userId: null });
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

describe("authorization matrix — unauthorized is indistinguishable from absent", () => {
  // Eight cases: {admin, owner, stranger, api-key-with-no-user} ×
  // {run with user_id, run with NULL user_id}. Asserted as a table so a
  // cell cannot be quietly dropped.
  const CASES: Array<[string, { userId: string; isAdmin: boolean }, string, boolean]> = [
    ["admin reads an owned run", ADMIN, "run-owned", true],
    ["admin reads an UNOWNED run", ADMIN, "run-unowned", true],
    ["the initiator reads their own run", OWNER, "run-owned", true],
    ["the initiator cannot read an unowned run", OWNER, "run-unowned", false],
    ["a stranger cannot read an owned run", STRANGER, "run-owned", false],
    ["a stranger cannot read an unowned run", STRANGER, "run-unowned", false],
    ["an ownerless API key cannot read an owned run", KEYLESS, "run-owned", false],
    ["an ownerless API key cannot read an unowned run", KEYLESS, "run-unowned", false],
  ];

  for (const [label, actor, runId, allowed] of CASES) {
    test(label, async () => {
      const trace = await getWorkflowRunTrace(runId, actor);
      if (allowed) {
        expect(trace).toBeDefined();
        expect(trace!.run.id).toBe(runId);
      } else {
        // `undefined`, which the route renders as 404 — the SAME answer a
        // nonexistent id gets. A distinguishable refusal would make the
        // endpoint an existence oracle.
        expect(trace).toBeUndefined();
      }
    });
  }

  test("a run with user_id IS NULL is admin-only — the fail-closed case", async () => {
    // Named separately because it is the rule most likely to be "fixed"
    // into looseness later: CLI and extension-triggered runs have no
    // initiator, and reading "unowned" as "anyone's" would expose every
    // scheduled run's payload to every logged-in member.
    expect(await getWorkflowRunTrace("run-unowned", ADMIN)).toBeDefined();
    for (const actor of [OWNER, STRANGER, KEYLESS]) {
      expect(await getWorkflowRunTrace("run-unowned", actor)).toBeUndefined();
    }
  });

  test("a nonexistent run and a forbidden run are the same answer", async () => {
    const missing = await getWorkflowRunTrace(crypto.randomUUID(), ADMIN);
    const forbidden = await getWorkflowRunTrace("run-owned", STRANGER);
    expect(missing).toBeUndefined();
    expect(forbidden).toBeUndefined();
    expect(missing).toEqual(forbidden);
  });
});

describe("trace payload shape", () => {
  beforeAll(async () => {
    await seedRun({ id: "run-shape", userId: "user-owner", workflowName: "publish" });
    await upsertWorkflowStepRun({
      workflowRunId: "run-shape",
      stepName: "draft",
      runId: "",
      status: "success",
      provider: "anthropic",
      model: "claude-opus-5",
      attempt: 2,
      inputTokens: 1000,
      outputTokens: 250,
      durationMs: 4200,
      resolvedInput: { topic: "release notes" },
      output: { success: true, output: "done" },
    });
    await upsertWorkflowStepRun({
      workflowRunId: "run-shape",
      stepName: "revise",
      runId: "",
      status: "success",
      iterations: 2,
      inputTokens: 40,
      outputTokens: 8,
      durationMs: 900,
    });
    await upsertWorkflowStepIteration({
      workflowRunId: "run-shape", stepName: "revise",
      iteration: 1, attempt: 0, status: "success",
      model: "claude-haiku-4-5", inputTokens: 10, outputTokens: 2, durationMs: 400,
    });
    await upsertWorkflowStepIteration({
      workflowRunId: "run-shape", stepName: "revise",
      iteration: 2, attempt: 0, status: "success",
      model: "claude-opus-5", inputTokens: 30, outputTokens: 6, durationMs: 500,
    });
  });

  test("carries per-step telemetry, resolved input and output", async () => {
    const trace = (await getWorkflowRunTrace("run-shape", OWNER))!;
    const draft = trace.steps.find((s) => s.stepName === "draft")!;
    expect(draft.provider).toBe("anthropic");
    expect(draft.model).toBe("claude-opus-5");
    expect(draft.attempt).toBe(2);
    expect(draft.inputTokens).toBe(1000);
    expect(draft.outputTokens).toBe(250);
    expect(draft.durationMs).toBe(4200);
    expect(draft.resolvedInput).toEqual({ topic: "release notes" });
    expect(draft.output).toEqual({ success: true, output: "done" });
    // No price table exists, so this is "not computed", rendered as "—".
    expect(draft.costUsd).toBeNull();
  });

  test("attaches each step's iterations to that step", async () => {
    const trace = (await getWorkflowRunTrace("run-shape", OWNER))!;
    const revise = trace.steps.find((s) => s.stepName === "revise")!;
    expect(revise.iterationRows.map((i) => i.iteration)).toEqual([1, 2]);
    // The escalation the parent row cannot show.
    expect(revise.iterationRows.map((i) => i.model)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-5",
    ]);
    // And they are attached to the RIGHT step, not pooled onto the run.
    expect(trace.steps.find((s) => s.stepName === "draft")!.iterationRows).toEqual([]);
  });

  test("rolls up totals at read time, never from a stored column", async () => {
    // A stored rollup drifts the moment a step row is corrected.
    const trace = (await getWorkflowRunTrace("run-shape", OWNER))!;
    expect(trace.totals.inputTokens).toBe(1040);
    expect(trace.totals.outputTokens).toBe(258);
    expect(trace.totals.durationMs).toBe(5100);
    expect(trace.totals.steps).toBe(2);
  });

  test("totals are NULL, not 0, when no step reported anything", async () => {
    // "Not reported" and "free" are different claims. A 0 here would make
    // an unmeasured run look like a measured cheap one.
    await seedRun({ id: "run-silent", userId: "user-owner" });
    await upsertWorkflowStepRun({
      workflowRunId: "run-silent", stepName: "shape", runId: "", status: "success",
    });
    const trace = (await getWorkflowRunTrace("run-silent", OWNER))!;
    expect(trace.totals.inputTokens).toBeNull();
    expect(trace.totals.outputTokens).toBeNull();
    expect(trace.totals.steps).toBe(1);
  });

  test("renders suspended state as first-class, not as an ending", async () => {
    // The trace must not assume a run is terminal: `suspended` /
    // `resumable` / `suspended_reason` exist today and a parked run sits
    // in them indefinitely.
    await db.execute(sql`
      INSERT INTO workflow_runs (id, workflow_name, status, started_at, user_id, suspended_reason, resumable)
      VALUES ('run-parked', 'nightly', 'suspended', '2026-07-02T00:00:00Z', 'user-owner', 'approval', TRUE)
    `);
    const trace = (await getWorkflowRunTrace("run-parked", OWNER))!;
    expect(trace.run.status).toBe("suspended");
    expect(trace.run.suspendedReason).toBe("approval");
    expect(trace.run.resumable).toBe(true);
    expect(trace.run.finishedAt).toBeNull();
  });
});

describe("run list — scoping and keyset pagination", () => {
  beforeAll(async () => {
    // Ten runs at distinct instants, owned by OWNER; two by a stranger.
    for (let i = 0; i < 10; i++) {
      await seedRun({
        id: `page-${String(i).padStart(2, "0")}`,
        userId: "user-owner",
        workflowName: "paged",
        startedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      });
    }
    for (let i = 0; i < 2; i++) {
      await seedRun({
        id: `other-${i}`,
        userId: "user-stranger",
        workflowName: "paged",
        startedAt: `2026-06-2${i}T00:00:00Z`,
      });
    }
  });

  test("a non-admin sees only runs they initiated", async () => {
    const { runs } = await listWorkflowRunsForCaller({ workflowName: "paged" }, OWNER);
    expect(runs).toHaveLength(10);
    expect(runs.every((r) => r.userId === "user-owner")).toBe(true);
  });

  test("an admin sees every caller's runs", async () => {
    const { runs } = await listWorkflowRunsForCaller({ workflowName: "paged" }, ADMIN);
    expect(runs).toHaveLength(12);
    expect(new Set(runs.map((r) => r.userId))).toEqual(
      new Set(["user-owner", "user-stranger"]),
    );
  });

  test("the list omits `input` — it is the same untrusted payload the trace redacts", async () => {
    const { runs } = await listWorkflowRunsForCaller({ workflowName: "paged" }, OWNER);
    expect(runs[0]).toBeDefined();
    expect(Object.keys(runs[0]!)).not.toContain("input");
    expect(Object.keys(runs[0]!)).not.toContain("result");
  });

  test("orders newest first", async () => {
    const { runs } = await listWorkflowRunsForCaller({ workflowName: "paged" }, OWNER);
    const times = runs.map((r) => r.startedAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("a cursor page is STABLE across an insert at the head", async () => {
    // The whole reason this is keyset and not OFFSET. With OFFSET, a run
    // starting between page 1 and page 2 shifts every later row down by
    // one, so page 2 re-serves page 1's last row and the reader silently
    // loses one per insert.
    const first = await listWorkflowRunsForCaller({ workflowName: "paged", limit: 4 }, OWNER);
    expect(first.runs).toHaveLength(4);
    expect(first.nextCursor).toBeDefined();

    // A newer run arrives — at the HEAD, which is what breaks OFFSET.
    await seedRun({
      id: "page-intruder",
      userId: "user-owner",
      workflowName: "paged",
      startedAt: "2026-06-30T00:00:00Z",
    });

    const second = await listWorkflowRunsForCaller(
      {
        workflowName: "paged",
        limit: 4,
        cursor: {
          startedAt: new Date(first.nextCursor!.startedAt),
          id: first.nextCursor!.id,
        },
      },
      OWNER,
    );
    const firstIds = first.runs.map((r) => r.id);
    const secondIds = second.runs.map((r) => r.id);
    // No overlap and no gap: page 2 continues exactly where page 1 ended.
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    expect(secondIds).not.toContain("page-intruder");
    expect(secondIds[0]).toBe("page-05");
  });

  test("two runs at the SAME instant are paged without loss or repeat", async () => {
    // What the `id` half of the keyset is FOR. `started_at` is not unique
    // — two runs fired in the same millisecond are ordinary — and a
    // cursor comparing only the timestamp makes the boundary ambiguous:
    // it either re-serves the row it just gave out or skips its twin.
    for (const suffix of ["a", "b", "c"]) {
      await seedRun({
        id: `tie-${suffix}`,
        userId: "user-owner",
        workflowName: "tied",
        startedAt: "2026-04-01T00:00:00Z",
      });
    }
    const first = await listWorkflowRunsForCaller({ workflowName: "tied", limit: 2 }, OWNER);
    expect(first.runs).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const second = await listWorkflowRunsForCaller(
      {
        workflowName: "tied",
        limit: 2,
        cursor: {
          startedAt: new Date(first.nextCursor!.startedAt),
          id: first.nextCursor!.id,
        },
      },
      OWNER,
    );

    const seen = [...first.runs, ...second.runs].map((r) => r.id);
    // All three, each exactly once — the property both failure modes break.
    expect(new Set(seen)).toEqual(new Set(["tie-a", "tie-b", "tie-c"]));
    expect(seen).toHaveLength(3);
  });

  test("the last page carries no cursor", async () => {
    const all = await listWorkflowRunsForCaller({ workflowName: "paged", limit: 200 }, OWNER);
    expect(all.nextCursor).toBeUndefined();
  });

  test("limit is clamped to the cap, and to at least one", async () => {
    const capped = await listWorkflowRunsForCaller(
      { workflowName: "paged", limit: 10_000 },
      ADMIN,
    );
    expect(capped.runs.length).toBeLessThanOrEqual(RUN_PAGE_MAX);
    const floored = await listWorkflowRunsForCaller({ workflowName: "paged", limit: 0 }, OWNER);
    expect(floored.runs).toHaveLength(1);
    expect(RUN_PAGE_DEFAULT).toBe(50);
  });

  test("filters by status and by time window", async () => {
    await seedRun({
      id: "run-failed",
      userId: "user-owner",
      workflowName: "filtered",
      status: "error",
      startedAt: "2026-05-01T00:00:00Z",
    });
    const byStatus = await listWorkflowRunsForCaller(
      { workflowName: "filtered", status: "error" },
      OWNER,
    );
    expect(byStatus.runs.map((r) => r.id)).toEqual(["run-failed"]);

    const outsideWindow = await listWorkflowRunsForCaller(
      { workflowName: "filtered", since: new Date("2026-06-01T00:00:00Z") },
      OWNER,
    );
    expect(outsideWindow.runs).toEqual([]);

    const insideWindow = await listWorkflowRunsForCaller(
      {
        workflowName: "filtered",
        since: new Date("2026-04-01T00:00:00Z"),
        until: new Date("2026-05-02T00:00:00Z"),
      },
      OWNER,
    );
    expect(insideWindow.runs.map((r) => r.id)).toEqual(["run-failed"]);
  });
});
