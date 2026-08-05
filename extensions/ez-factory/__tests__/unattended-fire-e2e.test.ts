/**
 * ez-factory — **the unattended fire, end to end, with nobody present.**
 *
 * ## The one claim this file makes
 *
 * A cron tick delivered as `ezcorp/trigger-fire` to this extension's own
 * receiver drives a saved job to a `workflow_runs` row with
 * `status='success'` and a non-null `finished_at`. Not "a trigger was
 * accepted". Not "an event was dispatched". A COMPLETED RUN.
 *
 * That distinction is the whole point of the file. This program has
 * repeatedly shipped green tests that asserted the near end of the pipe —
 * that a registration returned `{removed:true}`, that a notification was
 * sent — and proved nothing about whether anything ran.
 *
 * ## Every hop is real
 *
 *   - real PGlite and the real `migrate()`;
 *   - the real `handleTriggersRpc` writing a real `extension_schedules`
 *     row from the real save handler;
 *   - the real `computeDelegationConsentRecord`, so D6 passes on its own
 *     terms rather than on a fixture's guess;
 *   - the real `handleWorkflowsRpc` D1–D10 ladder;
 *   - the real `WorkflowExecutor` with `persist: true`, so the run row and
 *     its step rows are the ones production writes;
 *   - the real `ez-factory` subprocess module — its save handler, its
 *     trigger receiver, its fire handler, its job store, its audit log.
 *
 * The only doubles are the `AgentExecutor` (scripted, so the run is
 * deterministic and spends no provider) and the CHANNEL, which is a bridge
 * rather than a stub: it routes each reverse-RPC method to the very host
 * handler `rpc-handlers.ts` routes it to.
 *
 * ## The bridge models ONE thing, and a test pins the model
 *
 * `rpc-handlers.ts` picks a provenance resolver per method, and the choice
 * is the entire ordering constraint this feature hangs on:
 *
 *   | method                        | resolver                       | ownerless |
 *   |-------------------------------|--------------------------------|-----------|
 *   | `ezcorp/triggers`             | `resolveReverseRpcMeta`        | REFUSED   |
 *   | `ezcorp/workflows`            | `resolveReverseRpcMeta`        | REFUSED   |
 *   | `ezcorp/workflows-delegated`  | `resolveDelegatedProvenance`   | allowed   |
 *   | `ezcorp/storage`              | `resolveStorageProvenance`     | allowed   |
 *
 * The bridge reproduces that table from a single `callerOwner` variable,
 * set to `null` for a fire and to the clicking user for a page action. So
 * if a later author moves registration into the fire path, this file goes
 * red rather than a production log going quiet. The MODEL itself is pinned
 * against the three real resolvers by the first describe block, driving a
 * genuine ownerless fire token through them.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as realRuntime from "@ezcorp/sdk/runtime";
import * as schema from "../../../src/db/schema";
import { migrate } from "../../../src/db/migrate";
import { EventBus } from "../../../src/runtime/events";
import type { AgentEvents, AgentRun, WorkflowDefinition } from "../../../src/types";
import type { AgentExecutor } from "../../../src/runtime/executor";
import type { JsonRpcRequest } from "../../../src/extensions/types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../../../src/db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

// The console never reads settings, but `workflows-handler`'s import graph
// reaches the settings queries; keeping them off the DB makes the bridge's
// behaviour a function of this file alone.
mock.module("../../../src/db/queries/settings", () => ({
  async getAllSettings() {
    return {};
  },
  async getSetting() {
    return undefined;
  },
  async upsertSetting() {},
  async deleteSetting() {
    return false;
  },
  async isListingInstalled() {
    return false;
  },
}));

const EXT_NAME = "ez-factory";
const EXT_ID = "ext-ezfactory-fire";
const OWNER = "u-fire-owner";
const PROJECT_ID = "p-fire";

/** Whoever the CURRENT reverse-RPC is attributed to. `null` models an
 *  ownerless background fire — the state `ScheduleDaemon.dispatchFire`
 *  stamps on its call token. */
let callerOwner: string | null = OWNER;

/** Handlers the extension mounted with `getChannel().onRequest`. */
const receivers = new Map<string, (params: unknown) => Promise<unknown>>();
/** In-memory `ezcorp/storage`, matching `storage-handler.ts`'s wire shape. */
let storage = new Map<string, unknown>();
/** Page ids `invalidatePage` dropped. */
let invalidated: string[] = [];

const storageRequest = (params: unknown): unknown => {
  const p = params as Record<string, unknown>;
  const key = String(p.key ?? "");
  switch (p.action) {
    case "set":
      storage.set(key, JSON.parse(JSON.stringify(p.value)));
      return { ok: true, sizeBytes: 1 };
    case "delete":
      return { deleted: storage.delete(key) };
    case "list": {
      const prefix = typeof p.prefix === "string" ? p.prefix : "";
      return { keys: [...storage.keys()].filter((k) => k.startsWith(prefix)) };
    }
    default:
      return storage.has(key)
        ? { value: storage.get(key), exists: true }
        : { value: null, exists: false };
  }
};

/** The host's typed refusal, in the shape the SDK's channel rejects with —
 *  `data.reason` is what `describeFireRefusal` branches on. */
class BridgeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** Turn a host `JsonRpcResponse` into a resolve or a reject, exactly as
 *  `HostChannelImpl` does for an inbound response frame. */
function settle(res: { result?: unknown; error?: { code: number; message: string; data?: unknown } }): unknown {
  if (res.error) throw new BridgeRpcError(res.error.code, res.error.message, res.error.data);
  return res.result;
}

let handleWorkflowsRpc: typeof import("../../../src/extensions/workflows-handler").handleWorkflowsRpc;
let handleTriggersRpc: typeof import("../../../src/extensions/triggers-handler").handleTriggersRpc;

const GRANTED = {
  grantedAt: { workflows: Date.now(), triggers: Date.now() },
  workflows: { names: ["docs-factory", "etl-factory", "draft-and-verify"], maxRunsPerHour: 60, allowDelegated: true },
  triggers: { maxCron: 25, maxWebhooks: 25, webhookPrefix: "factory-", maxRunsPerDay: 500 },
} as never;

const MANIFEST = {
  schemaVersion: 2,
  name: EXT_NAME,
  version: "0.1.0",
  description: "",
  author: { name: "EZCorp" },
  permissions: {
    workflows: { names: ["docs-factory", "etl-factory", "draft-and-verify"], maxRunsPerHour: 60, allowDelegated: true },
    triggers: { maxCron: 25, maxWebhooks: 25, webhookPrefix: "factory-", maxRunsPerDay: 500 },
  },
} as never;

/** `-32106`, the shape `resolveReverseRpcMeta` returns for an ownerless
 *  call — see the header's resolver table. */
const ownerlessRefusal = (): never => {
  throw new BridgeRpcError(
    -32106,
    "No owner scope for this background fire — capability unavailable",
    undefined,
  );
};

const bridgeRequest = async (method: string, params: unknown): Promise<unknown> => {
  if (method === "ezcorp/storage") return storageRequest(params);

  const req: JsonRpcRequest = { jsonrpc: "2.0", id: 1, method, params: params as never };

  if (method === "ezcorp/triggers") {
    if (callerOwner === null) return ownerlessRefusal();
    return settle(
      await handleTriggersRpc(req, {
        extensionName: EXT_NAME,
        extensionId: EXT_ID,
        userId: callerOwner,
        conversationId: null,
        grantedPermissions: GRANTED,
        manifest: MANIFEST,
      }),
    );
  }

  if (method === "ezcorp/workflows") {
    if (callerOwner === null) return ownerlessRefusal();
  }

  if (method === "ezcorp/workflows" || method === "ezcorp/workflows-delegated") {
    return settle(
      await handleWorkflowsRpc(req, {
        extensionName: EXT_NAME,
        extensionId: EXT_ID,
        userId: callerOwner,
        conversationId: null,
        grantedPermissions: GRANTED,
        manifest: MANIFEST,
      }),
    );
  }

  throw new Error(`bridge has no route for ${method}`);
};

mock.module("@ezcorp/sdk/runtime", () => ({
  ...realRuntime,
  createToolDispatcher: () => {},
  definePage: () => {},
  invalidatePage: (pageId: string) => {
    invalidated.push(pageId);
  },
  getChannel: () => ({
    start: () => {},
    request: bridgeRequest,
    onRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => {
      receivers.set(method, handler);
    },
    notify: () => {},
  }),
  getToolContext: () => undefined,
}));

const { WorkflowExecutor } = await import("../../../src/runtime/workflow-executor");
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import(
  "../../../src/runtime/workflow/runtime-registry"
);
const { systemCachedWorkflow } = await import("../../../src/runtime/workflow-scope");
const { computeDelegationConsentRecord } = await import(
  "../../../src/runtime/workflow-delegation-record"
);
const { delegationPrincipal } = await import(
  "../../../src/runtime/workflow-delegation-consent"
);
const { createWorkflowDelegation } = await import(
  "../../../src/db/queries/workflow-delegations"
);
const {
  _resetWorkflowTriggerQuotaForTests,
  _resetWorkflowRateLimitForTests,
  _awaitDelegatedDispatchForTests,
} = await import("../../../src/extensions/workflows-handler");
const { _resetTriggersRateLimitForTests } = await import(
  "../../../src/extensions/triggers-handler"
);
const { registerFireCallProvenance } = await import("../../../src/extensions/call-provenance");
const { resolveReverseRpcMeta, resolveDelegatedProvenance, resolveStorageProvenance } =
  await import("../../../src/extensions/tool-executor/provenance");

handleWorkflowsRpc = (await import("../../../src/extensions/workflows-handler"))
  .handleWorkflowsRpc;
handleTriggersRpc = (await import("../../../src/extensions/triggers-handler"))
  .handleTriggersRpc;

const {
  __resetStateForTests,
  auditLog,
  handleJobSave,
  handleTriggerFire,
  installTriggerReceivers,
  jobStore,
  liveTriggerKeys,
} = await import("../index");

const {
  EDIT_SCOPE_FIELD,
  EDIT_SCOPE_TRIGGER,
  inputFieldId,
  JOB_FORM_FIELDS,
  JOB_RUN_EVENT,
} = await import("../lib/page");
const { triggerKeyForJob } = await import("../lib/triggers");

/**
 * The graph a job runs. TWO agent steps in a chain, so the run crosses a
 * real step boundary rather than terminalising inside one batch — the
 * boundary is where the delegated token ceiling lives, and a one-step graph
 * would prove completion without ever reaching it.
 *
 * Named `ez-factory:etl-factory` because that is what the host registers a
 * shipped `*.workflow.yaml` as, and the delegation row names the namespaced
 * form. The STEPS are a fixture; the NAME is production's.
 */
const GRAPH: WorkflowDefinition = {
  name: `${EXT_NAME}:etl-factory`,
  description: "",
  steps: [
    { name: "ingest", agent: "stub" },
    { name: "report", agent: "stub", dependsOn: ["ingest"] },
  ],
};

const ENTRY = systemCachedWorkflow(GRAPH, "extension");

let agentInvocations = 0;

function registerRuntime(): void {
  _resetWorkflowRuntimeForTests();
  const bus = new EventBus<AgentEvents>();
  const agentExec = {
    cancelRun() {},
    async runAgent(): Promise<AgentRun> {
      agentInvocations++;
      const runId = crypto.randomUUID();
      // `workflow_step_runs.run_id` is a real FK and the persistence
      // contract never throws, so without a real `runs` row every step
      // write would be dropped silently.
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
        inputTokens: 10,
        outputTokens: 5,
      } as AgentRun;
    },
  } as unknown as AgentExecutor;
  registerWorkflowRuntime({
    workflowExecutor: new WorkflowExecutor(agentExec, bus, { persist: true }),
    getWorkflows: () => [GRAPH],
    getCachedWorkflows: () => [ENTRY],
    listAgents: () => [],
  });
}

/** Let the executor's fire-and-forget step writes land and the handler's
 *  un-awaited dispatch settle. */
async function drain(): Promise<void> {
  await _awaitDelegatedDispatchForTests();
  for (let i = 0; i < 400; i++) await new Promise((r) => setTimeout(r, 0));
  await _awaitDelegatedDispatchForTests();
}

/** One page action, as the Hub delivers it. */
async function save(payload: Record<string, unknown>): Promise<void> {
  callerOwner = OWNER;
  await handleJobSave({ userId: OWNER, payload } as never);
}

/** The schedule form's half of a save. Split out because the console's job
 *  page really does submit two forms — the host caps a form at 10 fields —
 *  and `edit_scope` is what tells the handler which half arrived. */
async function saveSchedule(
  jobId: string,
  trigger: Record<string, unknown>,
): Promise<void> {
  await save({
    [JOB_FORM_FIELDS.jobId]: jobId,
    [EDIT_SCOPE_FIELD]: EDIT_SCOPE_TRIGGER,
    ...trigger,
  });
}

/** The cron half of a schedule submission. */
const CRON_FIELDS = {
  [JOB_FORM_FIELDS.triggerKind]: "cron",
  [JOB_FORM_FIELDS.triggerCron]: "0 3 * * *",
  [JOB_FORM_FIELDS.triggerTimezone]: "UTC",
  [JOB_FORM_FIELDS.triggerRunsPerDay]: "5",
  [JOB_FORM_FIELDS.triggerTokensPerRun]: "100000",
} as const;

/**
 * Save a CRON job the way the console actually builds one: a create (which
 * renders ONE form and therefore lands `manual`), then a schedule edit.
 *
 * Doing it in one payload would be a shape no rendered form produces, and
 * it would skip `candidateDraft` — the function that keeps a schedule from
 * silently vanishing when the OTHER form is saved.
 */
async function saveCronJob(name: string): Promise<string> {
  await save({
    [JOB_FORM_FIELDS.name]: name,
    [JOB_FORM_FIELDS.description]: "",
    [JOB_FORM_FIELDS.workflow]: "etl-factory",
    [JOB_FORM_FIELDS.enabled]: "yes",
    [inputFieldId("globs")]: "src/**/*.ts",
    [inputFieldId("outPath")]: "out/report.md",
  });
  const created = (await jobStore().listJobs()).find((j) => j.name === name);
  if (created === undefined) throw new Error(`fixture: '${name}' did not save`);
  await saveSchedule(created.id, { ...CRON_FIELDS });
  return created.id;
}

/** Mint the delegation a human would have consented to for this job, with
 *  the hash THIS build recomputes at fire time. */
async function consent(jobRef: string): Promise<string> {
  const record = await computeDelegationConsentRecord({
    entry: ENTRY,
    extensionName: EXT_NAME,
    workflowName: GRAPH.name,
    projectId: PROJECT_ID,
    runAs: { kind: "user", id: OWNER },
    trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
    principal: delegationPrincipal("user", OWNER),
    entries: [ENTRY],
    agents: [],
  });
  const created = await createWorkflowDelegation({
    extensionId: EXT_ID,
    jobRef,
    ownerKind: "user",
    ownerId: OWNER,
    workflowName: GRAPH.name,
    definitionVersionId: null,
    projectId: PROJECT_ID,
    triggerKind: "cron",
    triggerSpec: { expr: "0 3 * * *" },
    consentHash: record.consentHash,
    capabilitySet: record.capabilitySet,
    maxTokensPerRun: 100_000,
    maxRunsPerDay: 5,
    consentedByUserId: OWNER,
  });
  if (!created.ok) throw new Error(`fixture could not consent: ${created.message}`);
  return created.delegation.id;
}

/**
 * THE FIRE. Delivered exactly as `ScheduleDaemon.dispatchFire` delivers a
 * dynamic cron row — through the receiver the extension mounted, with NO
 * acting user.
 */
async function fire(key: string, kind: "cron" | "webhook" = "cron"): Promise<void> {
  const receiver = receivers.get("ezcorp/trigger-fire");
  if (receiver === undefined) throw new Error("no ezcorp/trigger-fire receiver mounted");
  callerOwner = null;
  try {
    await receiver({
      v: 1,
      key,
      kind,
      ...(kind === "cron" ? { cron: "0 3 * * *" } : { payload: { steer: "elsewhere" } }),
      firedAt: new Date().toISOString(),
      fireId: crypto.randomUUID(),
      catchUp: false,
      attempt: 0,
    });
  } finally {
    callerOwner = OWNER;
  }
  await drain();
}

interface RunRow {
  id: string;
  status: string;
  suspended_reason: string | null;
  finished_at: string | null;
  job_ref: string | null;
  delegation_id: string | null;
  run_as_kind: string | null;
  run_as: string | null;
  input: Record<string, unknown> | null;
  project_id: string | null;
  user_id: string | null;
}

async function runsFor(jobRef: string): Promise<RunRow[]> {
  const res = (await db.execute(sql`
    SELECT id, status, suspended_reason, finished_at, job_ref, delegation_id,
           run_as_kind, run_as, input, project_id, user_id
      FROM workflow_runs WHERE job_ref = ${jobRef} ORDER BY started_at
  `)) as unknown as { rows: RunRow[] };
  return res.rows;
}

async function cronRows(): Promise<Array<{ key: string | null; cron: string; enabled: boolean }>> {
  const res = (await db.execute(sql`
    SELECT key, cron, enabled FROM extension_schedules
     WHERE extension_id = ${EXT_ID} AND dynamic = true AND enabled = true ORDER BY key
  `)) as unknown as { rows: Array<{ key: string | null; cron: string; enabled: boolean }> };
  return res.rows;
}

/** `extension_webhooks.extension_id` holds the extension NAME (its FK
 *  targets `extensions.name`, not `extensions.id`) — the one column in this
 *  pair whose name does not say what it holds. */
async function webhookRows(): Promise<Array<{ key: string | null; slug: string }>> {
  const res = (await db.execute(sql`
    SELECT key, slug FROM extension_webhooks
     WHERE extension_id = ${EXT_NAME} AND dynamic = true AND enabled = true ORDER BY key
  `)) as unknown as { rows: Array<{ key: string | null; slug: string }> };
  return res.rows;
}

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status)
    VALUES (${OWNER}, 'fire-owner@ezf.test', 'h', 'Owner', 'member', 'active')
  `);
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES (${EXT_ID}, ${EXT_NAME}, '0.1.0', '{}'::jsonb, 'bundled')
  `);
  await db.execute(sql`
    INSERT INTO projects (id, name, path) VALUES (${PROJECT_ID}, 'fire-proj', '/tmp/fire')
  `);
});

beforeEach(async () => {
  await db.execute(sql`DELETE FROM workflow_step_runs`);
  await db.execute(sql`DELETE FROM workflow_runs`);
  await db.execute(sql`DELETE FROM workflow_delegations`);
  await db.execute(sql`DELETE FROM extension_schedule_fires`);
  await db.execute(sql`DELETE FROM extension_schedules`);
  await db.execute(sql`DELETE FROM extension_webhooks`);
  await db.execute(sql`DELETE FROM sdk_capability_calls`);
  await db.execute(sql`DELETE FROM audit_log`);
  storage = new Map();
  invalidated = [];
  receivers.clear();
  callerOwner = OWNER;
  agentInvocations = 0;
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
  delete process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS;
  delete process.env.EZCORP_DISABLE_DYNAMIC_TRIGGERS;
  _resetWorkflowTriggerQuotaForTests();
  _resetWorkflowRateLimitForTests(EXT_ID);
  _resetTriggersRateLimitForTests(EXT_ID);
  __resetStateForTests();
  registerRuntime();
  installTriggerReceivers();
});

afterAll(async () => {
  _resetWorkflowRuntimeForTests();
  await pglite?.close().catch(() => {});
});

describe("the resolver table the bridge models — pinned against the real resolvers", () => {
  /** A genuine ownerless fire token, minted the way
   *  `ScheduleDaemon.dispatchFire` mints one. */
  function ownerlessFireReq(method: string): JsonRpcRequest {
    const ezCallId = registerFireCallProvenance(
      {
        onBehalfOf: null,
        conversationId: null,
        runId: null,
        parentCallId: null,
        actorExtensionId: EXT_ID,
        kind: "schedule",
        ownerless: true,
      },
      { autoReleaseMs: 60_000 },
    );
    return { jsonrpc: "2.0", id: 1, method, params: { _meta: { ezCallId } } as never };
  }

  test("REGISTRATION cannot happen from inside a fire — resolveReverseRpcMeta answers -32106", () => {
    // This is the constraint the whole design is arranged around. If it
    // ever stops holding, `syncJobTrigger` could move into the fire path
    // and this file's premise would be wrong — so it is asserted against
    // the real function rather than described in a comment.
    const resolved = resolveReverseRpcMeta(EXT_ID, ownerlessFireReq("ezcorp/triggers"));
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    expect(resolved.errorResponse.error?.code).toBe(-32106);
  });

  test("the DELEGATED fire IS admitted by the same token — ownerless, onBehalfOf null", () => {
    const resolved = resolveDelegatedProvenance(
      EXT_ID,
      ownerlessFireReq("ezcorp/workflows-delegated"),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.onBehalfOf).toBeNull();
  });

  test("STORAGE is admitted too — which is why a fire can read its own job", () => {
    // The fire handler's first act is `jobStore().getJob(...)`. If storage
    // were owner-scoped there would be no unattended path at all.
    const resolved = resolveStorageProvenance(EXT_ID, ownerlessFireReq("ezcorp/storage"));
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.onBehalfOf).toBeNull();
  });
});

describe("THE CLAIM — an unattended fire runs a job to completion", () => {
  test("saving a cron job REGISTERS its host row, on the user-driven save path", async () => {
    const jobId = await saveCronJob("nightly etl");

    // The row the host now holds, written by the real `handleTriggersRpc`
    // through the real `ctx.triggers.register`.
    const rows = await cronRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe(triggerKeyForJob(jobId));
    expect(rows[0]?.cron).toBe("0 3 * * *");
    expect(rows[0]?.enabled).toBe(true);
  });

  test("…and the fire then runs it to a COMPLETED workflow run", async () => {
    const jobId = await saveCronJob("nightly etl");
    const delegationId = await consent(jobId);

    await fire(triggerKeyForJob(jobId)!);

    // ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────
    const runs = await runsFor(jobId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("success");
    expect(run.finished_at).not.toBeNull();
    expect(run.suspended_reason).toBeNull();
    // It really executed the graph — both steps, through the real
    // executor, not a short-circuit that stamped a terminal status.
    expect(agentInvocations).toBe(2);
    const steps = (await db.execute(sql`
      SELECT step_name, status FROM workflow_step_runs
       WHERE workflow_run_id = ${run.id} ORDER BY step_name
    `)) as unknown as { rows: Array<{ step_name: string; status: string }> };
    expect(steps.rows.map((r) => [r.step_name, r.status])).toEqual([
      ["ingest", "success"],
      ["report", "success"],
    ]);

    // Attributed to the DELEGATION, not to the caller — the caller had no
    // identity at all.
    expect(run.delegation_id).toBe(delegationId);
    expect(run.run_as_kind).toBe("user");
    expect(run.run_as).toBe(OWNER);
    expect(run.user_id).toBe(OWNER);
    // The project came off the consent row, never off the fire.
    expect(run.project_id).toBe(PROJECT_ID);
    // The input is the SAVED job's, which is what the human authorized.
    expect(run.input).toEqual({ globs: "src/**/*.ts", outPath: "out/report.md" });

    // The job's own record says it fired cleanly.
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.ok).toBe(true);
  });

  test("the same job fired MANUALLY still goes through `run`, and the two do not collide", async () => {
    // The attended verb is unchanged: `handleJobRun` has a clicking user,
    // so `ctx.workflows.run()` is the right call and switching it to
    // `runFor` would break every MANUAL job (no delegation row exists for
    // one) and mis-attribute every background job to its delegation owner
    // instead of to the person who pressed the button.
    const { handleJobRun } = await import("../index");
    const jobId = await saveCronJob("nightly etl");
    await consent(jobId);

    callerOwner = OWNER;
    await handleJobRun({
      userId: OWNER,
      payload: { [JOB_FORM_FIELDS.jobId]: jobId },
    } as never);
    await drain();

    const runs = await runsFor(jobId);
    expect(runs).toHaveLength(1);
    // No delegation touched: the run is the clicker's own.
    expect(runs[0]?.delegation_id).toBeNull();
    expect(runs[0]?.user_id).toBe(OWNER);
    expect(JOB_RUN_EVENT).toBe("ez-factory:job-run");
  });
});

describe("a WEBHOOK fire", () => {
  test("runs the SAVED input and does not forward the inbound payload", async () => {
    // A webhook is a doorbell, not a parameter channel. The delegation's
    // consent hash covers the workflow and its capability closure, NOT the
    // input — so a forwarded body would let whoever holds the hook token
    // steer a run executing as the human who consented.
    const jobId = await saveCronJob("hookable");
    // Move it to a webhook trigger through the schedule form, as an
    // operator would.
    await saveSchedule(jobId, {
      [JOB_FORM_FIELDS.triggerKind]: "webhook",
      [JOB_FORM_FIELDS.triggerRunsPerDay]: "5",
      [JOB_FORM_FIELDS.triggerTokensPerRun]: "100000",
    });
    // The cron row it used to hold is gone; a webhook row took its place.
    expect(await cronRows()).toHaveLength(0);
    expect(await webhookRows()).toHaveLength(1);

    await consent(jobId);
    await fire(triggerKeyForJob(jobId)!, "webhook");

    const runs = await runsFor(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("success");
    expect(runs[0]?.input).toEqual({ globs: "src/**/*.ts", outPath: "out/report.md" });
    // Nothing from the inbound body reached the run.
    expect(JSON.stringify(runs[0]?.input)).not.toContain("steer");
  });
});

describe("the parked state is LEGIBLE", () => {
  test("a stale consent PARKS the run and the job says so in the operator's words", async () => {
    const jobId = await saveCronJob("nightly etl");
    const delegationId = await consent(jobId);
    // What a release does: the workflow definition (or the extension's
    // grants, or a referenced agent) moves, and the recomputed hash no
    // longer matches what the human approved.
    await db.execute(sql`
      UPDATE workflow_delegations SET consent_hash = 'stale-after-a-deploy' WHERE id = ${delegationId}
    `);

    await fire(triggerKeyForJob(jobId)!);

    // The run row exists and is PARKED, not failed — it is what a
    // re-consent resumes.
    const runs = await runsFor(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("suspended");
    expect(runs[0]?.suspended_reason).toBe("consent-stale");
    expect(runs[0]?.finished_at).toBeNull();
    // Nothing executed.
    expect(agentInvocations).toBe(0);

    // ── THE LEGIBILITY ──────────────────────────────────────────────
    // An operator opening the console can tell "consent went stale" from
    // "the job is broken" WITHOUT being able to see the run row — which
    // matters, because `op:"runs"` scopes on `user_id` and a
    // service-owned parked run is invisible to every viewer.
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.ok).toBe(false);
    expect(job?.lastFire?.reason).toBe("DELEGATION_CONSENT_STALE");
    expect(job?.lastFire?.kind).toBe("consent");
    expect(job?.lastFire?.remedy).toContain("consent again");
  });

  test("a MISSING delegation reads as 'never authorized', a different remedy entirely", async () => {
    // The control that makes the assertion above about consent staleness
    // rather than about any refusal at all.
    const jobId = await saveCronJob("unauthorized");

    await fire(triggerKeyForJob(jobId)!);

    expect(await runsFor(jobId)).toHaveLength(0);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("DELEGATION_NOT_FOUND");
    expect(job?.lastFire?.kind).toBe("consent");
    expect(job?.lastFire?.remedy).toContain("No live authorization");
  });

  test("the daily cap is reported as a LIMIT, not as a breakage", async () => {
    const jobId = await saveCronJob("chatty");
    const delegationId = await consent(jobId);
    await db.execute(sql`
      UPDATE workflow_delegations SET max_runs_per_day = 1 WHERE id = ${delegationId}
    `);

    await fire(triggerKeyForJob(jobId)!);
    expect((await runsFor(jobId))[0]?.status).toBe("success");

    await fire(triggerKeyForJob(jobId)!);
    expect(await runsFor(jobId)).toHaveLength(1);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("DELEGATION_QUOTA_EXCEEDED");
    expect(job?.lastFire?.kind).toBe("quota");
    expect(job?.lastFire?.remedy).toContain("Nothing is broken");
  });
});

describe("the fire's own rungs", () => {
  test("a DISABLED job does not fire, even when a host row survived", async () => {
    const jobId = await saveCronJob("retired");
    await consent(jobId);
    // Retire it through the JOB form (which carries `enabled`), then put
    // the host row back — the exact state an unregister that failed would
    // leave behind.
    await save({
      [JOB_FORM_FIELDS.jobId]: jobId,
      [JOB_FORM_FIELDS.name]: "retired",
      [JOB_FORM_FIELDS.description]: "",
      [JOB_FORM_FIELDS.workflow]: "etl-factory",
      [JOB_FORM_FIELDS.enabled]: "no",
      [inputFieldId("globs")]: "src/**/*.ts",
      [inputFieldId("outPath")]: "out/report.md",
    });
    await db.execute(
      sql`UPDATE extension_schedules SET enabled = true WHERE extension_id = ${EXT_ID}`,
    );

    await fire(triggerKeyForJob(jobId)!);

    expect(await runsFor(jobId)).toHaveLength(0);
    expect(agentInvocations).toBe(0);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("LOCAL_JOB_DISABLED");
  });

  test("a fire for a key this console cannot parse runs nothing and is recorded", async () => {
    await fire("job:not a legal id");
    expect(agentInvocations).toBe(0);
    // No job to mark, so the trail is the only destination.
    const trail = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(
      trail.some(
        (e) => "kind" in e && e.kind === "job-fire-refused",
      ),
    ).toBe(true);
  });

  test("a cron row that fires at a job which is now WEBHOOK-triggered runs nothing", async () => {
    const jobId = await saveCronJob("switched");
    await consent(jobId);
    await saveSchedule(jobId, {
      [JOB_FORM_FIELDS.triggerKind]: "webhook",
      [JOB_FORM_FIELDS.triggerRunsPerDay]: "5",
      [JOB_FORM_FIELDS.triggerTokensPerRun]: "100000",
    });

    // A leftover cron tick. The delegation a human consented to named a
    // trigger; honouring a different one would run under authority nobody
    // gave.
    await fire(triggerKeyForJob(jobId)!, "cron");

    expect(await runsFor(jobId)).toHaveLength(0);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("LOCAL_TRIGGER_KIND_MISMATCH");
  });
});

describe("a registration that the host REFUSES", () => {
  test("does not fail the save, and the job says it is not armed", async () => {
    // C2's own kill switch, which an operator can set. The refusal is real
    // — it comes out of `handleTriggersRpc` rung 1b — rather than a stubbed
    // throw, so the shape this code branches on is the shape production
    // produces.
    process.env.EZCORP_DISABLE_DYNAMIC_TRIGGERS = "1";
    const jobId = await saveCronJob("unarmable");
    delete process.env.EZCORP_DISABLE_DYNAMIC_TRIGGERS;

    // The SAVE landed — the operator's edit is not lost to a failed
    // registration.
    const job = await jobStore().getJob(jobId);
    expect(job?.trigger.kind).toBe("cron");
    // And nothing was armed.
    expect(await cronRows()).toHaveLength(0);
    // Which the console can see, rather than showing a schedule that will
    // never fire.
    expect(job?.lastFire?.ok).toBe(false);
    expect(job?.lastFire?.reason).toBe("DYNAMIC_TRIGGERS_DISABLED");
    expect(job?.lastFire?.kind).toBe("install");
  });

  test("an unregister for a row the host never held is a NO-OP, not a failure", async () => {
    const jobId = await saveCronJob("cleanup");
    // Delete the row behind the console's back — the state a swept or
    // never-written registration leaves.
    await db.execute(sql`DELETE FROM extension_schedules WHERE extension_id = ${EXT_ID}`);

    await saveSchedule(jobId, { [JOB_FORM_FIELDS.triggerKind]: "manual" });

    // The save landed and the job is manual. Without the not-found
    // tolerance this job would be permanently un-editable: every later
    // save would try to retire a row that does not exist.
    const job = await jobStore().getJob(jobId);
    expect(job?.trigger.kind).toBe("manual");
    const trail = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(
      trail.some((e) => "kind" in e && e.kind === "trigger-already-gone"),
    ).toBe(true);
  });

  test("an unregister refused for ANY OTHER reason is recorded as a failure", async () => {
    const jobId = await saveCronJob("stuck");
    process.env.EZCORP_DISABLE_DYNAMIC_TRIGGERS = "1";
    await saveSchedule(jobId, { [JOB_FORM_FIELDS.triggerKind]: "manual" });
    delete process.env.EZCORP_DISABLE_DYNAMIC_TRIGGERS;

    const trail = await auditLog().readDay(new Date().toISOString().slice(0, 10));
    expect(
      trail.some((e) => "kind" in e && e.kind === "trigger-unregister-failed"),
    ).toBe(true);
    // The row is still live, so the fire path's own rungs are what stop it
    // running — which is exactly why they exist.
    expect(await cronRows()).toHaveLength(1);
    await fire(triggerKeyForJob(jobId)!);
    expect(await runsFor(jobId)).toHaveLength(0);
  });

  test("a job whose id cannot make a key is skipped rather than throwing", async () => {
    // Only reachable for a row written by something other than this
    // console's `crypto.randomUUID()` — `isValidJobId` admits uppercase and
    // the host's key charset does not.
    const { syncJobTrigger } = await import("../index");
    callerOwner = OWNER;
    await syncJobTrigger(
      {
        id: "Uppercase",
        name: "n",
        description: "",
        workflow: "etl-factory",
        input: {},
        trigger: { kind: "manual" },
        enabled: true,
        runAs: { kind: "user", id: OWNER },
        consentHash: null,
        createdBy: OWNER,
        createdAt: "2026-08-05T00:00:00.000Z",
        updatedBy: OWNER,
        updatedAt: "2026-08-05T00:00:00.000Z",
      },
      { kind: "cron", cron: "0 3 * * *", timezone: "UTC", maxRunsPerDay: 5, maxTokensPerRun: 10 },
      OWNER,
      "2026-08-05T00:00:00.000Z",
    );
    // Nothing was spent and nothing threw.
    expect(await cronRows()).toHaveLength(0);
  });
});

describe("the fire's remaining refusals", () => {
  test("a key naming a job that does not exist runs nothing", async () => {
    await fire("job:11111111-2222-4333-8444-555555555555");
    expect(agentInvocations).toBe(0);
  });

  test("a leftover row firing at a job that went MANUAL runs nothing", async () => {
    const jobId = await saveCronJob("demoted");
    await consent(jobId);
    await saveSchedule(jobId, { [JOB_FORM_FIELDS.triggerKind]: "manual" });

    await fire(triggerKeyForJob(jobId)!);

    expect(await runsFor(jobId)).toHaveLength(0);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("LOCAL_NOT_A_BACKGROUND_JOB");
  });

  test("a stored job that no longer passes the ALLOWLIST is refused at the point of spend", async () => {
    // Invariant B, re-asserted where it matters most: nobody is watching.
    // The row is written behind the store's back, which is the only way a
    // job can hold a key the allowlist would now reject — a row written
    // before the allowlist narrowed.
    const jobId = await saveCronJob("drifted");
    await consent(jobId);
    const stored = storage.get(`job:${jobId}`) as Record<string, unknown>;
    storage.set(`job:${jobId}`, {
      ...stored,
      input: { globs: "src/**", smuggled: "yes" },
    });

    await fire(triggerKeyForJob(jobId)!);

    expect(await runsFor(jobId)).toHaveLength(0);
    expect(agentInvocations).toBe(0);
    const job = await jobStore().getJob(jobId);
    expect(job?.lastFire?.reason).toBe("LOCAL_JOB_NO_LONGER_VALID");
  });
});

describe("the orphan sweep's answer", () => {
  test("claims exactly the keys whose jobs are live, enabled and background", async () => {
    const armed = await saveCronJob("armed");
    const manual = await saveCronJob("goes manual");
    await saveSchedule(manual, { [JOB_FORM_FIELDS.triggerKind]: "manual" });

    // The answer is derived from the JOB STORE, so a job that stopped
    // being background stops being claimed — which is what lets the host's
    // sweep retire its row instead of waking the subprocess forever.
    expect(await liveTriggerKeys()).toEqual([triggerKeyForJob(armed)!]);

    // And the receiver the sweep actually calls answers the same thing.
    const sync = receivers.get("ezcorp/triggers-sync");
    expect(sync).toBeDefined();
    expect(await sync!({ v: 1, keys: [] })).toEqual({
      v: 1,
      keys: [triggerKeyForJob(armed)!],
    });
  });

  test("handleTriggerFire is reachable directly and never throws on a bad frame", async () => {
    // The channel swallows a notification handler's throw
    // (`handleIncoming` catches and drops), so a throw here would convert
    // every failure into silence. Asserted rather than assumed.
    callerOwner = null;
    await expect(
      handleTriggerFire({
        v: 1,
        key: "nonsense",
        kind: "cron",
        firedAt: new Date().toISOString(),
        fireId: "f",
        catchUp: false,
        attempt: 0,
      }),
    ).resolves.toBeUndefined();
    callerOwner = OWNER;
    expect(invalidated).toContain("factory");
  });
});
