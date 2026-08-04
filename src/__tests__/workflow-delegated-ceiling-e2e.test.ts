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
 * D1–D10 ladder, and then asserts the run parks. Every hop is real: real
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
 *
 * ## Phase 8a — and the parked run finally has a way OUT
 *
 * Property 3 above raised the cap with a hand-written `UPDATE`, because
 * in phase 6 there was no route that could. That was the whole defect:
 * `RESUME_RULES["budget-exceeded"]` names raising the cap as the only
 * remedy, and the sole writer of `max_tokens_per_run` was the consent
 * route, whose supersede TOMBSTONES the row the predicate re-reads. So
 * the remedy existed in prose and nowhere else, and every parked
 * delegated run was permanently stuck.
 *
 * Three more properties close it, and the last two are the controls that
 * make the first an assertion rather than a hole:
 *
 *   4. the REAL `PATCH /api/workflows/delegations/:id` handler, called
 *      with the consenting human's session against this same database,
 *      raises the cap IN PLACE (one row, still live, no successor) — and
 *      the real `resumeWorkflow` then finishes the graph, running only
 *      the step that never ran;
 *   5. a STRANGER's PATCH is a 404, the cap does not move, and the run
 *      stays parked;
 *   6. a PATCH against a delegation the PLATFORM disabled is a 409 that
 *      carries the reason, does not re-enable the row, and leaves the run
 *      parked — re-consent is the re-enable path, because it re-asks the
 *      question that disabled it.
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

// ── The `$server` / `$lib` aliases the PATCH route imports ────────────
//
// SvelteKit resolves these through `svelte.config.js`; a bun test cannot,
// so each is pointed at the very module the alias names. `require`
// resolves relative to THIS file, and every target sits under the same
// `src/db/connection` that is mocked above — which is the whole point:
// the route must reach the SAME PGlite the ladder just parked a run in,
// or the "PATCH unblocks it" claim would be about two different
// databases.
mock.module("$server/auth/middleware", () => require("../auth/middleware"));
mock.module("$server/runtime/workflow-delegation-consent", () =>
  require("../runtime/workflow-delegation-consent"),
);
mock.module("$server/db/queries/workflow-delegations", () =>
  require("../db/queries/workflow-delegations"),
);
mock.module("$lib/server/http-errors", () => require("../../web/src/lib/server/http-errors"));

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
const { sumWorkflowRunTokens, sumServiceAccountTokensSince } = await import(
  "../db/queries/workflow-runs"
);
const { getWorkflowRuntime } = await import("../runtime/workflow/runtime-registry");
// The REAL route handler, not a call to the query function it wraps: the
// thing under test is that a human with a session can unblock a parked
// run, and the auth gate plus the strict body schema are half of that.
const { PATCH } = await import(
  "../../web/src/routes/api/workflows/delegations/[id]/+server"
);

const EXT_NAME = "ceiling-ext";
const EXT_ID = "e-ceiling";
const OWNER = "u-ceiling";
/** A second real session that consented to NOTHING — the control for the
 *  PATCH authorization. */
const STRANGER = "u-stranger";

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

/**
 * ONE agent step that loops three times — the double-count fixture.
 *
 * `runLoop` folds each iteration's tokens onto the single parent
 * `workflow_step_runs` row AND writes a `workflow_step_iterations` child
 * carrying the same numbers, which is exactly the shape a daily
 * aggregate could charge twice.
 *
 * `system` visibility so a SERVICE account can run it: the whole point of
 * this fixture is the account-scoped daily sum, and a service principal
 * reaches `system` and nothing else.
 */
const LOOPED: WorkflowDefinition = {
  name: "looped-report",
  description: "",
  steps: [{ name: "s1", agent: "stub", loop: { maxIterations: 3, onExhausted: "pass" } }],
};

function entryFor(definition: WorkflowDefinition): CachedWorkflow {
  return {
    definition,
    source: "db",
    id: `def-${definition.name}`,
    projectId: null,
    userId: OWNER,
    visibility: "system",
    forkedFrom: null,
  } as unknown as CachedWorkflow;
}

const ENTRY = entryFor(CHAIN);
const LOOPED_ENTRY = entryFor(LOOPED);
const ENTRIES = [ENTRY, LOOPED_ENTRY];

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
    getWorkflows: () => ENTRIES.map((e) => e.definition),
    getCachedWorkflows: () => ENTRIES,
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
async function makeDelegation(
  jobRef: string,
  maxTokensPerRun: number,
  opts: {
    definition?: WorkflowDefinition;
    ownerKind?: "user" | "service";
    /** The service-account id, for the `service` arm. */
    ownerId?: string;
  } = {},
): Promise<string> {
  const definition = opts.definition ?? CHAIN;
  const ownerKind = opts.ownerKind ?? "user";
  const ownerId = opts.ownerId ?? OWNER;
  const record = await computeDelegationConsentRecord({
    entry: entryFor(definition),
    extensionName: EXT_NAME,
    workflowName: definition.name,
    projectId: null,
    runAs: { kind: ownerKind, id: ownerId },
    trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
    principal: delegationPrincipal(ownerKind, ownerId),
    entries: ENTRIES,
    agents: [],
  });
  const id = `d-${crypto.randomUUID().slice(0, 8)}`;
  // The keyed owner columns, written explicitly on the arm the kind
  // names and NULL on the other — the same rule `ownerColumnValues`
  // enforces in the query layer.
  await db.execute(sql`
    INSERT INTO workflow_delegations (
      id, extension_id, job_ref, owner_kind, owner_user_id,
      owner_service_account_id, workflow_name,
      trigger_kind, trigger_spec, consent_hash, max_tokens_per_run,
      max_runs_per_day, consented_by_user_id
    ) VALUES (
      ${id}, ${EXT_ID}, ${jobRef}, ${ownerKind},
      ${ownerKind === "user" ? ownerId : null},
      ${ownerKind === "service" ? ownerId : null},
      ${definition.name},
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

/**
 * A SvelteKit `RequestEvent` for the PATCH route, carrying a real session
 * principal.
 *
 * `authMethod: "session"` is the value `hooks.server.ts` stamps on a
 * verified session cookie and the ONLY one `requireSessionAuth` allows —
 * so an API key cannot be substituted here even in a test.
 */
function patchEvent(delegationId: string, userId: string, maxTokensPerRun = 100_000) {
  const url = `http://localhost/api/workflows/delegations/${delegationId}`;
  return {
    url: new URL(url),
    params: { id: delegationId },
    locals: {
      user: { id: userId, email: `${userId}@c3.test`, name: userId, role: "member" },
      authMethod: "session",
    },
    request: new Request(url, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxTokensPerRun }),
    }),
  } as never;
}

async function capOf(delegationId: string): Promise<number> {
  const res = (await db.execute(sql`
    SELECT max_tokens_per_run FROM workflow_delegations WHERE id = ${delegationId}
  `)) as unknown as { rows: Array<{ max_tokens_per_run: number }> };
  return res.rows[0]!.max_tokens_per_run;
}

/**
 * Every delegation row for one `job_ref`, live or tombstoned, oldest
 * first — the proof that a PATCH minted no new row and revoked no old
 * one.
 *
 * A supersede would show TWO here (a tombstone and its successor), which
 * is exactly the shape that stranded parked runs before phase 6 carried
 * them forward.
 */
async function delegationRowsFor(jobRef: string): Promise<Array<[string, boolean]>> {
  const res = (await db.execute(sql`
    SELECT id, (revoked_at IS NULL) AS live FROM workflow_delegations
     WHERE job_ref = ${jobRef} ORDER BY consented_at
  `)) as unknown as { rows: Array<{ id: string; live: boolean }> };
  return res.rows.map((r) => [r.id, r.live]);
}

/**
 * Resume a parked run through the REAL executor, handing it the row the
 * daemon would hand it.
 *
 * `resumeWorkflow` re-reads `suspended_reason` from the database rather
 * than taking it off this argument, and re-derives `delegationId` from
 * the row — so a resume cannot shed the ceiling by parking, and this
 * helper cannot smuggle a verdict past the gate under test.
 */
async function resume(workflowRunId: string) {
  const res = (await db.execute(sql`
    SELECT id, workflow_name, status, input, cursor, definition_hash,
           project_id, user_id, started_at, delegation_id
      FROM workflow_runs WHERE id = ${workflowRunId}
  `)) as unknown as {
    rows: Array<{
      id: string;
      workflow_name: string;
      status: string;
      input: Record<string, unknown> | null;
      cursor: { batchIndex: number; completedSteps: string[]; prevStepName: string | null } | null;
      definition_hash: string | null;
      project_id: string | null;
      user_id: string | null;
      started_at: string;
      delegation_id: string | null;
    }>;
  };
  const row = res.rows[0]!;
  return getWorkflowRuntime()!.workflowExecutor.resumeWorkflow(CHAIN, {
    id: row.id,
    workflowName: row.workflow_name,
    status: row.status,
    input: row.input,
    cursor: row.cursor,
    definitionHash: row.definition_hash,
    projectId: row.project_id,
    userId: row.user_id,
    startedAt: new Date(row.started_at),
    delegationId: row.delegation_id,
  });
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (${OWNER}, 'ceiling@c3.test', 'h', 'Owner', 'member', 'active'),
           (${STRANGER}, 'stranger@c3.test', 'h', 'Stranger', 'member', 'active')
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

  test("the PATCH route unblocks the parked run, and it runs to completion", async () => {
    // ── THE point of phase 8a, proved end to end ────────────────────
    //
    // Every hop is real: the delegated frame walks the ladder, the
    // executor parks the run on its own ceiling, a HUMAN AT A SESSION
    // calls the real `PATCH` handler against the same PGlite, and the
    // real `resumeWorkflow` then finishes the graph.
    //
    // Before this route the sequence was impossible. The only writer of
    // `max_tokens_per_run` was the consent route, and a supersede
    // tombstones the row `RESUME_RULES["budget-exceeded"]` re-reads — so
    // the remedy that rule names in its own prose ("only raising that cap
    // lets it continue") had no implementation, and this run would have
    // stayed parked forever.
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-patch", 150);
    await handleWorkflowsRpc(frame("job-patch"), handlerCtx());
    await settle();

    const parked = (await runsFor(delegationId))[0]!;
    expect(parked.status).toBe("suspended");
    expect(parked.suspended_reason).toBe("budget-exceeded");
    expect(invocations).toBe(2);

    // The route, with the session the consenting human actually has.
    const res = (await PATCH(patchEvent(delegationId, OWNER))) as Response;
    expect(res.status, await res.clone().text()).toBe(200);
    const patched = (await res.json()) as {
      delegation: { id: string; maxTokensPerRun: number };
    };
    // IN PLACE. The same row id — no supersede, so the parked run's own
    // `delegation_id` still points at a live authority without anything
    // having had to carry it forward.
    expect(patched.delegation.id).toBe(delegationId);
    expect(patched.delegation.maxTokensPerRun).toBe(100_000);
    // Still exactly ONE row for this job, and it is still live. A
    // supersede would show a tombstone plus a successor here.
    expect(await delegationRowsFor("job-patch")).toEqual([[delegationId, true]]);

    // The between-processes gate now allows, and it re-read both numbers
    // itself rather than being told.
    expect(await resumeReasonRefusal("budget-exceeded", { workflowRunId: parked.id })).toBeNull();

    // …and the run actually finishes. This is the assertion the
    // `resumeReasonRefusal` check alone cannot make: a predicate that
    // returns null proves the gate opened, not that the work completed.
    const run = await resume(parked.id);
    expect(run.status).toBe("success");
    // The THIRD agent step ran and the first two did not run again — the
    // cursor did its job, so "resumable" did not mean "re-executed".
    expect(invocations).toBe(3);
    const after = (await runsFor(delegationId))[0]!;
    expect(after.status).toBe("success");
    expect(after.finished_at).not.toBeNull();
    // `suspended_reason` deliberately SURVIVES the terminalization —
    // `finalizeWorkflowRunRow` leaves it exactly as the park wrote it
    // unless a caller overrides it, and only the approval-timeout sweep
    // does. It is the trace's record of why this run once stopped, not a
    // live flag, and the status is what says it is finished.
    expect(after.suspended_reason).toBe("budget-exceeded");
    expect(await sumWorkflowRunTokens(parked.id)).toBe(300);
  });

  test("a STRANGER's PATCH is a 404 and the run stays parked", async () => {
    // The pair for the row above. Without it, "the PATCH unblocked it"
    // is satisfied by a route that lets anyone raise anyone's cap — which
    // would make the unblock a bug rather than the feature.
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-stranger", 150);
    await handleWorkflowsRpc(frame("job-stranger"), handlerCtx());
    await settle();
    const parked = (await runsFor(delegationId))[0]!;
    expect(parked.status).toBe("suspended");

    const res = (await PATCH(patchEvent(delegationId, STRANGER))) as Response;
    expect(res.status).toBe(404);

    // Nothing moved: the cap, the gate and the run are all as they were.
    expect(await capOf(delegationId)).toBe(150);
    expect(await resumeReasonRefusal("budget-exceeded", { workflowRunId: parked.id })).toContain(
      "max_tokens_per_run",
    );
    const run = await resume(parked.id);
    expect(run.status).toBe("suspended");
    expect(invocations).toBe(2);
  });

  test("PATCHing a DISABLED delegation is refused, and the run stays parked", async () => {
    // The re-enable decision, proved on a real row rather than argued.
    // A delegation the platform switched off is not repaired by a bigger
    // budget, and clearing `enabled` here would restore the
    // approval-ANSWERING authority `delegationHoldsAuthority()` withdrew
    // before any fire re-asks D7's question. Re-consent is the re-enable
    // path precisely because it re-asks.
    registerRuntime(100);
    invocations = 0;
    const delegationId = await makeDelegation("job-disabled", 150);
    await handleWorkflowsRpc(frame("job-disabled"), handlerCtx());
    await settle();
    const parked = (await runsFor(delegationId))[0]!;
    expect(parked.status).toBe("suspended");

    await db.execute(sql`
      UPDATE workflow_delegations
         SET enabled = false, disabled_reason = 'This job stopped: the workflow moved out of reach.'
       WHERE id = ${delegationId}
    `);

    const res = (await PATCH(patchEvent(delegationId, OWNER))) as Response;
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: string };
    // The reason reaches the human — it is the only thing they will ever
    // read about why the job stopped.
    expect(error).toContain("moved out of reach");
    expect(error).toContain("Consent again");
    expect(await capOf(delegationId)).toBe(150);

    // Still disabled, still parked. And the run's resume gate agrees:
    // `budget-exceeded` fails closed on a row that holds no authority.
    const [row] = (
      (await db.execute(sql`
        SELECT enabled, disabled_reason FROM workflow_delegations WHERE id = ${delegationId}
      `)) as unknown as { rows: Array<{ enabled: boolean; disabled_reason: string }> }
    ).rows;
    expect(row?.enabled).toBe(false);
    expect(row?.disabled_reason).toContain("moved out of reach");
    expect(await resumeReasonRefusal("budget-exceeded", { workflowRunId: parked.id })).toContain(
      "max_tokens_per_run",
    );
  });

  test("a LOOPED step is counted ONCE — the daily sum must not double-count", async () => {
    // ── The double-count hazard, on a real looped run ────────────────
    //
    // `runLoop` accumulates each iteration's usage ONTO the parent
    // `workflow_step_runs` row with `+=`, AND writes a per-iteration
    // child row carrying the same numbers. The two tables are a rollup
    // and its detail, not two disjoint sets — so a daily aggregate that
    // summed both would charge every looped agent step twice, and a
    // service account would hit its cap at half the spend it actually
    // made.
    //
    // Proved by executing a real loop and reading both tables, not by
    // reading the executor: the assertion below is that the two are
    // EQUAL and that the iteration rows are non-empty, so the test would
    // fail either if the sum double-counted or if the loop had silently
    // stopped writing children (which would make the equality vacuous).
    registerRuntime(100);
    invocations = 0;
    const accountId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO service_accounts (id, name, created_by_user_id, max_tokens_per_day)
      VALUES (${accountId}, ${`loop-acct-${accountId}`}, ${OWNER}, 1000000)
    `);
    const delegationId = await makeDelegation("job-loop", 1_000_000, {
      definition: LOOPED,
      ownerKind: "service",
      ownerId: accountId,
    });

    const resp = await handleWorkflowsRpc(frame("job-loop"), handlerCtx());
    expect(resp.error).toBeUndefined();
    await settle();

    const rows = await runsFor(delegationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    // Three iterations of one agent step, 100 tokens each.
    expect(invocations).toBe(3);

    const parentTotal = await sumWorkflowRunTokens(rows[0]!.id);
    expect(parentTotal).toBe(300);

    // The detail rows exist and carry the SAME tokens — so summing both
    // tables would return 600, not 300.
    const iterations = (
      (await db.execute(sql`
        SELECT COALESCE(SUM(COALESCE(i.input_tokens,0) + COALESCE(i.output_tokens,0)), 0) AS total,
               COUNT(*) AS n
          FROM workflow_step_iterations i
          JOIN workflow_step_runs s ON s.id = i.workflow_step_run_id
         WHERE s.workflow_run_id = ${rows[0]!.id}
      `)) as unknown as { rows: Array<{ total: string | number; n: string | number }> }
    ).rows[0]!;
    expect(Number(iterations.n)).toBe(3);
    expect(Number(iterations.total)).toBe(300);

    // THE assertion: the daily aggregate charges the account 300, not
    // 600. It reads `workflow_step_runs` alone, deliberately.
    expect(await sumServiceAccountTokensSince(accountId, new Date(0))).toBe(300);
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
