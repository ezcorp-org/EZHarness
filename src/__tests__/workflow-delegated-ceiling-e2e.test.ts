/**
 * C3 phase 6 — **the whole chain, end to end: the token ceiling now
 * FIRES, because a caller finally reaches it.**
 *
 * Phase B built the step-boundary ceiling and proved it by inserting a
 * `workflow_runs` row with `delegation_id` set BY HAND. That proved the
 * machinery and could not prove the wiring, and the wiring was the part
 * nobody had: no production caller passed `delegationId` into
 * `runWorkflow`, so the ceiling had never fired on a run any real code
 * path could start.
 *
 * This test starts the run the way production does — a `ezcorp/workflows-delegated`
 * reverse-RPC frame carrying nothing but `{v, op, jobRef}` — walks the
 * D1–D9 ladder, and then asserts the run parks. Every hop is real: real
 * PGlite, real `migrate()`, the real `WorkflowExecutor`, the real
 * `workflow_delegations` reader, the real resume table. The only double
 * is the `AgentExecutor`, which is scripted so the token spend is a
 * number this test chose rather than a provider's.
 *
 * Three properties, and the middle one is the one a unit test of any hop
 * would miss:
 *
 *   1. a delegated run over its `max_tokens_per_run` parks `suspended`
 *      with `suspended_reason='budget-exceeded'` and a NULL `finished_at`;
 *   2. **the same graph, started with the same frame, under a delegation
 *      whose cap is generous, RUNS TO COMPLETION** — so property 1 is the
 *      ceiling and not the handler refusing everything;
 *   3. the resume table then refuses to continue the parked run, and
 *      allows it once the cap is raised. That is the between-processes
 *      half of the same bound, and it re-reads both numbers itself.
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
import type { CachedWorkflow } from "../runtime/workflow-scope";
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

const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { resumeReasonRefusal } = await import("../runtime/workflow-resume-reasons");
const { handleWorkflowsRpc, DELEGATED_OP, DELEGATED_WORKFLOWS_METHOD } = await import(
  "../extensions/workflows-handler"
);
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import(
  "../runtime/workflow/runtime-registry"
);
const { computeDelegationConsentRecord } = await import(
  "../runtime/workflow-delegation-record"
);
const { delegationPrincipal } = await import("../runtime/workflow-delegation-consent");
const { sumWorkflowRunTokens } = await import("../db/queries/workflow-runs");

const EXT_NAME = "ceiling-ext";
const EXT_ID = "e-ceiling";
const OWNER = "u-ceiling";

/** A three-step chain — one step per batch, so every gap between them is
 *  a real boundary the ceiling can fire at. */
const CHAIN: WorkflowDefinition = {
  name: "nightly-report",
  description: "",
  steps: [
    { name: "s1", agent: "stub" },
    { name: "s2", agent: "stub", dependsOn: ["s1"] },
    { name: "s3", agent: "stub", dependsOn: ["s2"] },
  ],
};

const ENTRY = {
  definition: CHAIN,
  source: "db",
  id: "def-nightly",
  projectId: null,
  userId: OWNER,
  visibility: "system",
  forkedFrom: null,
} as unknown as CachedWorkflow;

/** Agent invocations, so a resume that wrongly re-enters a completed
 *  batch is visible as an extra call rather than only as a cursor. */
let invocations = 0;

function scriptedExecutor(tokensPerStep: number) {
  const bus = new EventBus<AgentEvents>();
  const agentExec = {
    cancelRun() {},
    async runAgent(): Promise<AgentRun> {
      invocations++;
      const runId = crypto.randomUUID();
      // `workflow_step_runs.run_id` is a real FK and the persistence
      // contract never throws, so without a real `runs` row every step
      // write would be silently dropped and the token columns under test
      // would read NULL for the wrong reason.
      await db.execute(sql`
        INSERT INTO runs (id, agent_name, status, started_at)
        VALUES (${runId}, 'stub', 'success', NOW())
      `);
      return {
        id: runId,
        agentName: "stub",
        status: "success",
        startedAt: Date.now(),
        logs: [],
        result: { success: true, output: "ok" },
        inputTokens: tokensPerStep,
        outputTokens: 0,
      } as AgentRun;
    },
  } as unknown as AgentExecutor;
  return new WorkflowExecutor(agentExec, bus, { persist: true });
}

function registerRuntime(tokensPerStep: number): void {
  _resetWorkflowRuntimeForTests();
  const wf = scriptedExecutor(tokensPerStep);
  registerWorkflowRuntime({
    workflowExecutor: wf,
    getWorkflows: () => [CHAIN],
    getCachedWorkflows: () => [ENTRY],
    listAgents: () => [],
  });
}

/** The delegated frame, in full. It names NO workflow, NO owner and NO
 *  project — that is the point of §4, and it is why this test can only
 *  reach a workflow a human already consented to. */
function frame(jobRef: string) {
  return {
    jsonrpc: "2.0" as const,
    id: 1,
    method: DELEGATED_WORKFLOWS_METHOD,
    params: { v: 1, op: DELEGATED_OP, jobRef },
  };
}

function handlerCtx() {
  return {
    extensionName: EXT_NAME,
    extensionId: EXT_ID,
    // OWNERLESS — a cron tick. The delegation supplies the principal.
    userId: null,
    conversationId: null,
    grantedPermissions: {
      grantedAt: { workflows: Date.now() },
      workflows: { names: [], maxRunsPerHour: 500, allowDelegated: true },
    },
    manifest: {
      schemaVersion: 2,
      name: EXT_NAME,
      version: "0.0.1",
      description: "",
      author: { name: "t" },
      permissions: { workflows: { names: [], maxRunsPerHour: 500, allowDelegated: true } },
    },
  } as never;
}

/** Write a live delegation whose `consent_hash` is what THIS build
 *  recomputes, so the ladder's D6 rung passes on its own terms rather
 *  than on a fixture's guess. */
async function makeDelegation(jobRef: string, maxTokensPerRun: number): Promise<string> {
  const record = await computeDelegationConsentRecord({
    entry: ENTRY,
    extensionName: EXT_NAME,
    workflowName: CHAIN.name,
    projectId: null,
    runAs: { kind: "user", id: OWNER },
    trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
    principal: delegationPrincipal("user", OWNER),
    entries: [ENTRY],
    agents: [],
  });
  const id = `d-${crypto.randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    INSERT INTO workflow_delegations (
      id, extension_id, job_ref, owner_kind, owner_user_id, workflow_name,
      trigger_kind, trigger_spec, consent_hash, max_tokens_per_run,
      max_runs_per_day, consented_by_user_id
    ) VALUES (
      ${id}, ${EXT_ID}, ${jobRef}, 'user', ${OWNER}, ${CHAIN.name},
      'cron', ${JSON.stringify({ expr: "0 3 * * *" })}::jsonb,
      ${record.consentHash}, ${maxTokensPerRun}, 100, ${OWNER}
    )
  `);
  return id;
}

interface RunRow {
  id: string;
  status: string;
  suspended_reason: string | null;
  finished_at: string | null;
  run_phase: string | null;
  delegation_id: string | null;
  run_as_kind: string | null;
  run_as: string | null;
  job_ref: string | null;
  cursor: { batchIndex: number } | null;
}

async function runsFor(delegationId: string): Promise<RunRow[]> {
  const res = (await db.execute(sql`
    SELECT id, status, suspended_reason, finished_at, run_phase, delegation_id,
           run_as_kind, run_as, job_ref, cursor
      FROM workflow_runs WHERE delegation_id = ${delegationId}
  `)) as unknown as { rows: RunRow[] };
  return res.rows;
}

/** Let the executor's fire-and-forget step writes land, and let the
 *  handler's un-awaited dispatch finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (${OWNER}, 'ceiling@c3.test', 'h', 'Owner', 'member', 'active')
  `);
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES (${EXT_ID}, ${EXT_NAME}, '1.0.0', '{}'::jsonb, 'local')
  `);
});

afterAll(async () => {
  _resetWorkflowRuntimeForTests();
  await pglite?.close().catch(() => {});
});

describe("the token ceiling, reached through the runFor handler", () => {
  test("a delegated run over max_tokens_per_run PARKS at a boundary", async () => {
    // 100 tokens per agent step, three steps, a 150-token cap: the first
    // boundary is under (100 < 150), the second is over (200 >= 150).
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-tight", 150);

    const resp = await handleWorkflowsRpc(frame("job-tight"), handlerCtx());
    expect(resp.error).toBeUndefined();
    await settle();

    const rows = await runsFor(delegationId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // ── the park itself ──
    expect(row.status).toBe("suspended");
    expect(row.suspended_reason).toBe("budget-exceeded");
    // NOT terminalized: a run that hit its budget has not failed.
    expect(row.finished_at).toBeNull();
    expect(row.run_phase).toBe("boundary");
    // ── the three C3 columns the handler wrote ──
    expect(row.delegation_id).toBe(delegationId);
    expect(row.run_as_kind).toBe("user");
    expect(row.run_as).toBe(OWNER);
    expect(row.job_ref).toBe("job-tight");
    // ── it stopped where it should have ──
    // Two agent steps ran; the third never dispatched. The cursor points
    // at the NEXT batch, so a resume does not re-execute the completed
    // one — the hazard the boundary park had to pre-empt.
    expect(invocations).toBe(2);
    expect(row.cursor?.batchIndex).toBe(2);
    expect(await sumWorkflowRunTokens(row.id)).toBe(200);
  });

  test("the SAME frame under a generous cap runs to completion", async () => {
    // The pair. Without it, "it parked" is satisfied by a handler that
    // refuses everything, and every assertion above would still pass.
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-roomy", 100_000);

    const resp = await handleWorkflowsRpc(frame("job-roomy"), handlerCtx());
    expect(resp.error).toBeUndefined();
    await settle();

    const rows = await runsFor(delegationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.suspended_reason).toBeNull();
    expect(invocations).toBe(3);
  });

  test("the resume table refuses the parked run, and allows it once the cap is raised", async () => {
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-resume", 150);
    await handleWorkflowsRpc(frame("job-resume"), handlerCtx());
    await settle();
    const parked = (await runsFor(delegationId))[0]!;
    expect(parked.status).toBe("suspended");

    // The between-processes half of the bound. It re-reads BOTH numbers
    // itself — the caller cannot assert its own budget is fine.
    const refused = await resumeReasonRefusal("budget-exceeded", {
      workflowRunId: parked.id,
    });
    expect(refused).toContain("max_tokens_per_run");

    await db.execute(sql`
      UPDATE workflow_delegations SET max_tokens_per_run = 100000 WHERE id = ${delegationId}
    `);
    const allowed = await resumeReasonRefusal("budget-exceeded", {
      workflowRunId: parked.id,
    });
    expect(allowed).toBeNull();
  });

  test("a REVOKED delegation keeps the parked run parked — the cap fails closed", async () => {
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-revoked", 150);
    await handleWorkflowsRpc(frame("job-revoked"), handlerCtx());
    await settle();
    const parked = (await runsFor(delegationId))[0]!;

    await db.execute(sql`
      UPDATE workflow_delegations
         SET revoked_at = NOW(), max_tokens_per_run = 100000
       WHERE id = ${delegationId}
    `);

    // Raising the cap on a REVOKED row must not be a way out: a run
    // parked here is over budget by construction, so a missing authority
    // is not evidence that it is under one.
    const refused = await resumeReasonRefusal("budget-exceeded", {
      workflowRunId: parked.id,
    });
    expect(refused).toContain("max_tokens_per_run");
  });
});
