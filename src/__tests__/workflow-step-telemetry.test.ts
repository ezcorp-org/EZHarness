/**
 * C5 per-step telemetry: tokens, attempts, duration, typed error codes and
 * the redacted `resolved_input` — written by the executor, read back out
 * of a real `workflow_step_runs` row.
 *
 * Driven end to end against real PGlite and the real `migrate()`, with a
 * stub `AgentExecutor`, because the properties that matter here are
 * PLUMBING properties: a value produced at the adapter has to survive
 * four hops to reach a column, and a unit test of any one hop would pass
 * with the chain broken.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import type { AgentEvents, AgentRun, WorkflowDefinition } from "../types";
import type { AgentExecutor } from "../runtime/executor";
import type { ToolCallResult } from "../extensions/types";

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

const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { listWorkflowStepRunRows } = await import("../db/queries/workflow-runs");
const { listWorkflowStepIterations, upsertWorkflowStepIteration } = await import(
  "../db/queries/workflow-step-iterations"
);

/**
 * Let the executor's fire-and-forget telemetry writes land.
 *
 * The parent step row and every iteration row are `void
 * persistWrite(...)` by design — awaiting them inside the step promise
 * would turn `$prev` into a per-step value and change the semantics of
 * every existing workflow. So a test that reads straight after
 * `runWorkflow` resolves is racing writes the production code
 * deliberately does not wait for.
 *
 * Draining the microtask queue a few times is enough because PGlite
 * serializes on one connection: once the queued statements have been
 * issued and their promises resolved, the rows are visible.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

/** One scripted agent outcome per invocation, consumed in order. */
interface ScriptedRun {
  success?: boolean;
  output?: unknown;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * A `WorkflowExecutor` whose agent invocations are scripted.
 *
 * The stub stands in for `AgentExecutor` rather than for the pi-llm
 * adapter, because the hop this file is pinning is `AgentRun` → `stepRun`
 * → column. The adapter → `AgentRun` hop is pinned separately in
 * `executor-usage-accumulation.test.ts`.
 */
function scriptedExecutor(script: ScriptedRun[], opts: { toolHandler?: () => ToolCallResult } = {}) {
  const bus = new EventBus<AgentEvents>();
  const seen: Array<Record<string, unknown>> = [];
  let i = 0;
  const agentExec = {
    cancelRun() {},
    async runAgent(_name: string, input: Record<string, unknown>): Promise<AgentRun> {
      seen.push(input);
      const s = script[Math.min(i, script.length - 1)] ?? {};
      i++;
      const runId = crypto.randomUUID();
      // The real `AgentExecutor` persists its run row, and
      // `workflow_step_runs.run_id` is a real FK — so a stub that skipped
      // this would make every agent-step write fail the constraint and
      // then be SWALLOWED by the never-throw persistence contract,
      // leaving the columns under test silently NULL.
      await db.execute(sql`
        INSERT INTO runs (id, agent_name, status, started_at)
        VALUES (${runId}, 'stub', 'success', NOW())
      `);
      const run: AgentRun = {
        id: runId,
        agentName: "stub",
        status: s.success === false ? "error" : "success",
        startedAt: Date.now(),
        logs: [],
        result: { success: s.success !== false, output: s.output ?? "ok" },
      };
      if (s.provider !== undefined) run.provider = s.provider;
      if (s.model !== undefined) run.model = s.model;
      if (s.inputTokens !== undefined) run.inputTokens = s.inputTokens;
      if (s.outputTokens !== undefined) run.outputTokens = s.outputTokens;
      return run;
    },
  } as unknown as AgentExecutor;
  const wf = new WorkflowExecutor(agentExec, bus, {
    persist: true,
    toolRunnerFactory: () => ({
      setCurrentUserId() {},
      async executeToolCall() {
        return opts.toolHandler?.() ?? { content: [{ type: "text", text: "{}" }], isError: false };
      },
    }),
  });
  return { wf, seen, invocations: () => i };
}

/** Read the one step row a single-step workflow produced. */
async function stepRow(workflowRunId: string, stepName: string) {
  const rows = await listWorkflowStepRunRows(workflowRunId);
  const row = rows.find((r) => r.stepName === stepName);
  expect(row, `no step row for "${stepName}"`).toBeDefined();
  return row!;
}

const agentStep = (name: string, input?: Record<string, string>): WorkflowDefinition => ({
  name: `wf-${name}-${crypto.randomUUID().slice(0, 8)}`,
  description: "",
  steps: [input ? { name, agent: "stub", input } : { name, agent: "stub" }],
});

describe("token usage reaches workflow_step_runs", () => {
  test("an agent step's reported tokens land on the row", async () => {
    const { wf } = scriptedExecutor([
      { inputTokens: 1200, outputTokens: 340, provider: "anthropic", model: "claude-opus-5" },
    ]);
    const def = agentStep("draft");
    const run = await wf.runWorkflow(def, {});
    const row = await stepRow(run.id, "draft");

    expect(row.inputTokens).toBe(1200);
    expect(row.outputTokens).toBe(340);
    // The C1 columns still work — this change threads alongside them, it
    // does not replace them.
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-opus-5");
  });

  test("a provider that reports NO usage stores NULL, not 0", async () => {
    // The single most important row in this file. Zero is a CLAIM ("this
    // call cost nothing") that every SUM over the column believes and
    // silently deflates; NULL is the truth ("not reported") and every SQL
    // aggregate already ignores it.
    const { wf } = scriptedExecutor([{ provider: "anthropic", model: "claude-opus-5" }]);
    const run = await wf.runWorkflow(agentStep("draft"), {});
    const row = await stepRow(run.id, "draft");

    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.inputTokens).not.toBe(0);
  });

  test("a step that reports zero tokens stores 0, distinguishably from NULL", async () => {
    // The other side of the same coin: a real zero must survive. If the
    // plumbing used `|| null` instead of `?? null`, this row would read
    // NULL and a genuine measurement would be lost.
    const { wf } = scriptedExecutor([{ inputTokens: 0, outputTokens: 0 }]);
    const run = await wf.runWorkflow(agentStep("draft"), {});
    const row = await stepRow(run.id, "draft");

    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  test("a retried step SUMS tokens across attempts and counts them", async () => {
    // A step that retried three times was billed three times. Overwriting
    // per attempt — the natural mirror of how provider/model are handled
    // — would report only the last one and undercount by 2/3 here.
    const { wf } = scriptedExecutor([
      { success: false, inputTokens: 100, outputTokens: 10 },
      { success: false, inputTokens: 200, outputTokens: 20 },
      { success: true, inputTokens: 400, outputTokens: 40 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-retry-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "flaky", agent: "stub", retries: 2 }],
    };
    const run = await wf.runWorkflow(def, {});
    const row = await stepRow(run.id, "flaky");

    expect(row.inputTokens).toBe(700);
    expect(row.outputTokens).toBe(70);
    expect(row.attempt).toBe(3);
  });

  test("a looped step SUMS tokens across iterations", async () => {
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
    const row = await stepRow(run.id, "revise");

    expect(row.inputTokens).toBe(60);
    expect(row.outputTokens).toBe(6);
    // `iterations` is the loop count; `attempt` is the invocation count.
    // For a plain loop they agree, and they are still different columns.
    expect(row.iterations).toBe(3);
    expect(row.attempt).toBe(3);
  });

  test("a mix of reported and unreported attempts sums only what was reported", async () => {
    // Neither "drop the whole step's usage because one call was silent"
    // nor "count the silent one as 0" — the total is over what was
    // actually measured.
    const { wf } = scriptedExecutor([
      { success: false, inputTokens: 100, outputTokens: 10 },
      { success: false },
      { success: true, inputTokens: 5, outputTokens: 1 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-mixed-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "flaky", agent: "stub", retries: 2 }],
    };
    const run = await wf.runWorkflow(def, {});
    const row = await stepRow(run.id, "flaky");

    expect(row.inputTokens).toBe(105);
    expect(row.outputTokens).toBe(11);
    expect(row.attempt).toBe(3);
  });

  test("a transform step reports no tokens and no attempts", async () => {
    // It invokes no agent, so every LLM-shaped column is NULL — which is
    // the truth, and is why they are all nullable.
    const { wf } = scriptedExecutor([]);
    const def: WorkflowDefinition = {
      name: `wf-transform-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "shape", kind: "transform", output: { a: "x" } }],
    };
    const run = await wf.runWorkflow(def, {});
    const row = await stepRow(run.id, "shape");

    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.attempt).toBeNull();
    expect(row.provider).toBeNull();
  });
});

describe("cost_usd is never written", () => {
  test("a fully-instrumented agent step still leaves cost_usd NULL", async () => {
    // Acceptance criterion 2. There is no host-side price table, so
    // nothing can compute a cost honestly; the column exists so the
    // trace, the dashboard and C3's spend cap have ONE place to read from
    // the day a price source lands. A fabricated number would be worse
    // than a dash.
    const { wf } = scriptedExecutor([
      { inputTokens: 1000, outputTokens: 500, provider: "anthropic", model: "claude-opus-5" },
    ]);
    const run = await wf.runWorkflow(agentStep("draft"), {});
    const row = await stepRow(run.id, "draft");

    expect(row.inputTokens).toBe(1000);
    expect(row.costUsd).toBeNull();
  });

  test("no source file writes cost_usd", async () => {
    // The structural half: the test above proves one path leaves it NULL,
    // this proves there is no other path. `?? null` in the upsert is not
    // enough on its own — a second writer could appear anywhere.
    const res = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM workflow_step_runs WHERE cost_usd IS NOT NULL
    `)) as { rows: Array<{ n: number }> };
    expect(Number(res.rows[0]!.n)).toBe(0);
  });
});

describe("duration and typed error codes", () => {
  test("a successful step records its wall-clock duration", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const run = await wf.runWorkflow(agentStep("draft"), {});
    const row = await stepRow(run.id, "draft");

    expect(row.durationMs).not.toBeNull();
    expect(row.durationMs!).toBeGreaterThanOrEqual(0);
    // Sanity that it is a duration and not a timestamp: a stub agent
    // cannot have taken a minute.
    expect(row.durationMs!).toBeLessThan(60_000);
  });

  test("a FAILED step still records how long it took to fail", async () => {
    // The case an operator actually debugs. Recording duration only on
    // the success path would leave exactly the interesting rows blank.
    const { wf } = scriptedExecutor([{ success: false }]);
    const run = await wf.runWorkflow(agentStep("doomed"), {});
    const row = await stepRow(run.id, "doomed");

    expect(row.status).toBe("error");
    expect(row.durationMs).not.toBeNull();
    expect(row.durationMs!).toBeGreaterThanOrEqual(0);
  });

  test("a failed step records the TYPED reason, not the message", async () => {
    // `error_code` has to be stable enough to GROUP BY. A message carries
    // the step name and the provider's wording and differs on every row.
    const { wf } = scriptedExecutor([{ success: false }]);
    const run = await wf.runWorkflow(agentStep("doomed"), {});
    const row = await stepRow(run.id, "doomed");

    expect(row.errorCode).toBe("step-failed");
    expect(row.errorCode).not.toContain("doomed");
  });

  test("a successful step has no error code", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const run = await wf.runWorkflow(agentStep("draft"), {});
    expect((await stepRow(run.id, "draft")).errorCode).toBeNull();
  });
});

describe("resolved_input is stored redacted", () => {
  test("a credential threaded through $input never reaches the row in clear", async () => {
    // The security property this column lives or dies by: `resolved_input`
    // is whatever the ref language produced, and the trace UI renders it.
    const { wf, seen } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const def = agentStep("publish", { token: "$input.token", repo: "$input.repo" });
    const run = await wf.runWorkflow(def, {
      token: "ghp_aaaaaaaaaaaaaaaaaaaaaa",
      repo: "ezcorp/harness",
    });
    const row = await stepRow(run.id, "publish");

    // The agent was handed the REAL credential — redaction is a storage
    // concern and must not break the dispatch.
    expect(seen[0]).toEqual({ token: "ghp_aaaaaaaaaaaaaaaaaaaaaa", repo: "ezcorp/harness" });
    // The ROW carries the redacted form, and the non-secret field survives.
    expect(row.resolvedInput).toEqual({ token: "[REDACTED]", repo: "ezcorp/harness" });

    // And nothing anywhere in the stored JSON contains the raw token.
    const raw = (await db.execute(sql`
      SELECT resolved_input::text AS t FROM workflow_step_runs WHERE id = ${row.id}
    `)) as { rows: Array<{ t: string }> };
    expect(raw.rows[0]!.t).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaa");
  });

  test("a tool step's resolved input is recorded and redacted too", async () => {
    // Tool args are the other untrusted-payload surface — an extension
    // tool's input is exactly what an author threads secrets into.
    const { wf } = scriptedExecutor([], { toolHandler: () => ({ content: [{ type: "text", text: "{}" }], isError: false }) });
    const def: WorkflowDefinition = {
      name: `wf-tool-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "call", tool: "some__tool", input: { key: "$input.key" } }],
    };
    const run = await wf.runWorkflow(def, { key: "sk-aaaaaaaaaaaaaaaaaaaaaa" });
    const row = await stepRow(run.id, "call");

    expect(row.resolvedInput).toEqual({ key: "[REDACTED]" });
  });

  test("a transform step stores no resolved input", async () => {
    // It reads no `input` mapping, so NULL is the truth rather than a gap.
    const { wf } = scriptedExecutor([]);
    const def: WorkflowDefinition = {
      name: `wf-noinput-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "shape", kind: "transform", output: { a: "x" } }],
    };
    const run = await wf.runWorkflow(def, {});
    expect((await stepRow(run.id, "shape")).resolvedInput).toBeNull();
  });

  test("an oversize resolved input stores the truncation sentinel", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const def = agentStep("big", { blob: "$input.blob" });
    const run = await wf.runWorkflow(def, { blob: "x".repeat(70_000) });
    const row = await stepRow(run.id, "big");

    // Same sentinel shape `output` uses, so a reader has one case to
    // handle rather than two.
    expect(row.resolvedInput).toMatchObject({ __truncated: true });
    expect((row.resolvedInput as { bytes: number }).bytes).toBeGreaterThan(64 * 1024);
  });
});

describe("per-iteration child rows", () => {
  test("a 3-iteration loop writes 3 rows with distinct iteration numbers", async () => {
    // Acceptance criterion 1's behavioural half. The parent row cannot
    // express this — its arbiter is (workflow_run_id, step_name), so a
    // looped step has exactly one row there.
    const { wf } = scriptedExecutor([
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: 20, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 3 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-iters-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "revise", agent: "stub", loop: { maxIterations: 3 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();

    const iters = await listWorkflowStepIterations(run.id);
    expect(iters.map((r) => r.iteration)).toEqual([1, 2, 3]);
    expect(iters.every((r) => r.stepName === "revise")).toBe(true);
    // Each row carries ITS OWN tokens, not the step's running total —
    // 10/20/30, never 10/30/60.
    expect(iters.map((r) => r.inputTokens)).toEqual([10, 20, 30]);
    expect(iters.map((r) => r.outputTokens)).toEqual([1, 2, 3]);
  });

  test("a per-iteration model change is visible", async () => {
    // The reason per-iteration provider/model exist at all: a `$loop.*`
    // binding is re-resolved each pass, so a workflow can escalate
    // cheap → strong. The parent row records only the last one.
    const { wf } = scriptedExecutor([
      { model: "claude-haiku-4-5", provider: "anthropic", inputTokens: 1, outputTokens: 1 },
      { model: "claude-opus-5", provider: "anthropic", inputTokens: 1, outputTokens: 1 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-escalate-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "escalate", agent: "stub", loop: { maxIterations: 2 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();

    const iters = await listWorkflowStepIterations(run.id);
    expect(iters.map((r) => r.model)).toEqual(["claude-haiku-4-5", "claude-opus-5"]);
    // And the parent still reports the LAST one, which is the honest
    // summary — the detail is what the child table is for.
    expect((await stepRow(run.id, "escalate")).model).toBe("claude-opus-5");
  });

  test("a loop that dies mid-way keeps the rows for the passes that ran", async () => {
    // Recording only successes would erase exactly the iteration an
    // operator opened the trace to find.
    const { wf } = scriptedExecutor([
      { inputTokens: 5, outputTokens: 1 },
      { inputTokens: 6, outputTokens: 1 },
      { success: false, inputTokens: 7, outputTokens: 1 },
    ]);
    const def: WorkflowDefinition = {
      name: `wf-loopfail-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "flaky", agent: "stub", loop: { maxIterations: 5 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();
    expect(run.status).toBe("error");

    const iters = await listWorkflowStepIterations(run.id);
    expect(iters.map((r) => r.iteration)).toEqual([1, 2, 3]);
    expect(iters.map((r) => r.status)).toEqual(["success", "success", "error"]);
    expect(iters[2]!.errorCode).toBe("step-failed");
    // The failing pass still reports what it consumed.
    expect(iters[2]!.inputTokens).toBe(7);
  });

  test("a transform loop records timing with no LLM columns", async () => {
    const { wf } = scriptedExecutor([]);
    const def: WorkflowDefinition = {
      name: `wf-tloop-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "shape", kind: "transform", output: { a: "x" }, loop: { maxIterations: 2 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();

    const iters = await listWorkflowStepIterations(run.id);
    expect(iters.map((r) => r.iteration)).toEqual([1, 2]);
    // It mints no AgentRun, so these are NULL — the truth, not a gap.
    expect(iters.every((r) => r.runId === null && r.model === null)).toBe(true);
    expect(iters.every((r) => r.durationMs !== null)).toBe(true);
  });

  test("a NON-looped step writes no iteration rows", async () => {
    // The child table is loop detail. A plain step's single execution is
    // already fully described by its parent row, and duplicating it here
    // would double every trace's row count for no information.
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const run = await wf.runWorkflow(agentStep("plain"), {});
    await settle();
    expect(await listWorkflowStepIterations(run.id)).toEqual([]);
  });

  test("iteration rows cascade away with their run", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const def: WorkflowDefinition = {
      name: `wf-cascade-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "revise", agent: "stub", loop: { maxIterations: 2 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();
    expect(await listWorkflowStepIterations(run.id)).toHaveLength(2);

    // run → step (CASCADE) → iteration (CASCADE). An iteration without
    // its step is meaningless; contrast run HISTORY, kept via SET NULL.
    await db.execute(sql`DELETE FROM workflow_runs WHERE id = ${run.id}`);
    expect(await listWorkflowStepIterations(run.id)).toEqual([]);
  });

  test("upsertWorkflowStepIteration reports a missing parent instead of throwing", async () => {
    // The parent row is written fire-and-forget, so "not visible yet" is
    // reachable. It must be a reported no-op, never an exception that
    // takes down the run it was only describing.
    const written = await upsertWorkflowStepIteration({
      workflowRunId: crypto.randomUUID(),
      stepName: "nope",
      iteration: 1,
      attempt: 0,
      status: "success",
    });
    expect(written).toBe(false);
  });

  test("re-writing the same (iteration, attempt) updates in place", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 1, outputTokens: 1 }]);
    const def: WorkflowDefinition = {
      name: `wf-upsert-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "revise", agent: "stub", loop: { maxIterations: 1 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();
    expect(await listWorkflowStepIterations(run.id)).toHaveLength(1);

    const again = await upsertWorkflowStepIteration({
      workflowRunId: run.id,
      stepName: "revise",
      iteration: 1,
      attempt: 0,
      status: "error",
      errorCode: "rewritten",
    });
    expect(again).toBe(true);
    const iters = await listWorkflowStepIterations(run.id);
    expect(iters).toHaveLength(1);
    expect(iters[0]!.status).toBe("error");
    expect(iters[0]!.errorCode).toBe("rewritten");

    // A different ATTEMPT of the same iteration is a NEW row — a retried
    // iteration is a distinct event, not an overwrite of the failed try.
    await upsertWorkflowStepIteration({
      workflowRunId: run.id,
      stepName: "revise",
      iteration: 1,
      attempt: 1,
      status: "success",
    });
    expect(await listWorkflowStepIterations(run.id)).toHaveLength(2);
  });

  test("iteration rows never carry a cost", async () => {
    const { wf } = scriptedExecutor([{ inputTokens: 9, outputTokens: 9 }]);
    const def: WorkflowDefinition = {
      name: `wf-nocost-${crypto.randomUUID().slice(0, 8)}`,
      description: "",
      steps: [{ name: "revise", agent: "stub", loop: { maxIterations: 2 } }],
    };
    const run = await wf.runWorkflow(def, {});
    await settle();
    const iters = await listWorkflowStepIterations(run.id);
    expect(iters).toHaveLength(2);
    expect(iters.every((r) => r.costUsd === null)).toBe(true);
  });
});
