/**
 * C3 phase 6 — `op: "runFor"`, the D1–D10 ladder.
 *
 * (Phase 8a added rung D10, `service_accounts.max_tokens_per_day` — the
 * column phase 2 shipped and nothing read. Its block is at the end,
 * followed by the three-bounds separation: D8 counts RUNS for one
 * delegation, D9 asks whether the per-RUN token cap admits any work, D10
 * sums TOKENS for one ACCOUNT across every delegation it owns. Three
 * conditions, three codes, three remedies.)
 *
 * ## What every test here asserts, and why it is two things
 *
 * The instruction this suite is written against is "one test per rung:
 * WHICH deny code, and WHICH audit destination" — not "it denies". A
 * blanket refusal passes the first half of every refusal test in this
 * file, so each rung is ALSO paired with the legitimate caller getting
 * through, and the destination is read out of the two real tables rather
 * than from a spy over the function that chooses between them.
 *
 * The destination is the sharp half. `sdk_capability_calls.on_behalf_of`
 * is NOT NULL with an FK to `users`, so a `owner_kind='service'` outcome
 * — which carries a NULL user by construction — does not merely land in
 * the wrong table if this is wrong: `recordCapabilityCall` never throws
 * by contract, so the insert is SWALLOWED and the denial vanishes. That
 * is why every service-kind row below is asserted present in `audit_log`
 * AND absent from `sdk_capability_calls`.
 *
 * Runs against real PGlite and the real `migrate()`: the ladder's whole
 * job is to read rows and write rows, and a mocked query layer would
 * prove the ladder against a world that agrees with it.
 */
import {
  test, expect, describe, beforeAll, beforeEach, afterAll, afterEach, mock, spyOn,
} from "bun:test";
import { restoreModuleMocks } from "../../__tests__/helpers/mock-cleanup";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "../../__tests__/helpers/test-pglite";

mock.module("../../db/queries/settings", () => ({
  async getAllSettings() { return {}; },
  async getSetting() { return undefined; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

mockDbConnection();

import {
  handleWorkflowsRpc,
  delegatedWorkflowsDisabled,
  DELEGATED_OP,
  DELEGATED_WORKFLOWS_METHOD,
  _resetWorkflowTriggerQuotaForTests,
  _resetWorkflowRateLimitForTests,
  _awaitDelegatedDispatchForTests,
  type WorkflowsHandlerContext,
} from "../workflows-handler";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../../runtime/workflow/runtime-registry";
import { createUser } from "../../db/queries/users";
import { createServiceAccount } from "../../db/queries/service-accounts";
import { createWorkflowDelegation } from "../../db/queries/workflow-delegations";
import { insertWorkflowRun } from "../../db/queries/workflow-runs";
import { computeDelegationConsentRecord } from "../../runtime/workflow-delegation-record";
import { delegationPrincipal } from "../../runtime/workflow-delegation-consent";
import {
  extensions, projects, sdkCapabilityCalls, auditLog, users,
  serviceAccounts, workflowDelegations, workflowRuns, workflowStepRuns, messages, errorLogs,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../types";
import type { AgentDefinition, WorkflowDefinition, WorkflowRun } from "../../types";
import { systemCachedWorkflow, type CachedWorkflow } from "../../runtime/workflow-scope";
// The SDK surface under test in phase 7. Imported from source (the package
// is a bun workspace) so these run against the file the gate measures, not
// against a built artifact that could lag it.
import { Workflows } from "../../../packages/@ezcorp/sdk/src/runtime/workflows";
import {
  __resetChannelForTests,
  getChannel,
  JsonRpcError,
  type HostChannel,
} from "../../../packages/@ezcorp/sdk/src/runtime/channel";

const EXT_NAME = "delegated-ext";

let ownerUserId: string;
let lowPrivUserId: string;
let serviceAccountId: string;
let adminUserId: string;
let extensionId: string;
let projectId: string;

/** Every run the fake executor was asked to start, with its options bag
 *  verbatim — `delegationId` rides there and is the ONE gate on the
 *  step-boundary ceiling, so a test could not otherwise tell "forwarded"
 *  from "silently dropped". */
let started: Array<{
  workflow: WorkflowDefinition;
  input: Record<string, unknown>;
  projectId?: string;
  userId?: string;
  opts?: Record<string, unknown>;
}>;

/** What the fake executor's run resolves to, so the failure-counter fold
 *  can be driven without a real graph. */
let runStatus: WorkflowRun["status"] = "success";
let runWorkflowThrows = false;
/** Return a REJECTED promise rather than throwing synchronously — the
 *  "executor bug" shape, which must be absorbed and logged rather than
 *  taking the process down with an unhandled rejection. */
let runWorkflowRejects = false;

// ── The workflow population ──────────────────────────────────────────
//
// Three visibilities, because the ladder's whole strength IS the read/run
// ladder and the three rows behave differently per owner kind.

const SYSTEM_WF: WorkflowDefinition = {
  name: "org-nightly",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};
const PROJECT_WF: WorkflowDefinition = {
  name: "team-fork",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};
/**
 * The one workflow here that REACHES something.
 *
 * Every other definition in this population is a lone `transform`, which
 * contributes no capability at all — so the whole closure hashes to an
 * EMPTY capability set and neither a widening nor a narrowing is
 * expressible against it. D6's gate is now the widening test, so it needs
 * a graph that can actually widen. The tool is not registered, which is
 * deliberate and is itself a capability fact: an unreachable tool hashes
 * as `tool::<name>` PLUS `tool:unreachable::<name>`, both stable.
 */
const TOOLED_WF: WorkflowDefinition = {
  name: "org-tooled",
  description: "",
  steps: [{ name: "call", kind: "tool", tool: "ext__do_thing", input: {} }],
};
/** `team-fork`, but reaching a tool — for the closure-difference tests,
 *  where the child has to contribute a capability for the parent's set to
 *  change when the child drops in or out of the principal's view. */
const PROJECT_TOOLED_WF: WorkflowDefinition = {
  name: "team-fork",
  description: "",
  steps: [{ name: "call", kind: "tool", tool: "ext__child_thing", input: {} }],
};
const PRIVATE_WF: WorkflowDefinition = {
  name: "someones-private",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};
/** Namespaced to an extension that is NOT installed — the liveness rung. */
const DEAD_EXT_WF: WorkflowDefinition = {
  name: "ghost-ext:deploy",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};

function dbEntry(
  definition: WorkflowDefinition,
  visibility: "system" | "project" | "private",
  userId: string | null,
): CachedWorkflow {
  return {
    definition,
    source: "db",
    id: `def-${definition.name}`,
    projectId: null,
    userId,
    visibility,
    forkedFrom: null,
  } as CachedWorkflow;
}

let cachedEntries: CachedWorkflow[];
let agents: AgentDefinition[];
/** Set to `undefined` to prove the fail-CLOSED path. */
let cacheReader: (() => CachedWorkflow[]) | undefined;
let agentReader: (() => AgentDefinition[]) | undefined;

function registerRuntime(): void {
  registerWorkflowRuntime({
    workflowExecutor: {
      async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
      },
      // Deliberately NOT `async`. The registry's `runWorkflow` is an
      // INTERFACE any registration may satisfy, and one that throws
      // synchronously — a wiring error, a proxy, a stub — must be caught
      // and turned into a typed denial rather than escaping as an
      // unhandled rejection. An `async` double could not reach that
      // branch at all, because an async function never throws
      // synchronously.
      runWorkflow(workflow, input, proj, uid, _signal, opts) {
        if (runWorkflowThrows) throw new Error("executor refused");
        if (runWorkflowRejects) return Promise.reject(new Error("executor bug"));
        started.push({
          workflow,
          input,
          ...(proj !== undefined ? { projectId: proj } : {}),
          ...(uid !== undefined ? { userId: uid } : {}),
          ...(opts !== undefined ? { opts: opts as Record<string, unknown> } : {}),
        });
        return Promise.resolve({
          id: "run-1",
          workflowName: workflow.name,
          status: runStatus,
          startedAt: Date.now(),
          steps: [],
        } satisfies WorkflowRun);
      },
    },
    getWorkflows: () => cachedEntries.map((e) => e.definition),
    ...(cacheReader !== undefined ? { getCachedWorkflows: cacheReader } : {}),
    ...(agentReader !== undefined ? { listAgents: agentReader } : {}),
  });
}

function manifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "0.0.1",
    description: "",
    author: { name: "t" },
    permissions: { workflows: { names: [], maxRunsPerHour: 20, allowDelegated: true } },
  } as unknown as ExtensionManifestV2;
}

function granted(
  overrides: Partial<NonNullable<ExtensionPermissions["workflows"]>> = {},
): ExtensionPermissions {
  return {
    grantedAt: { workflows: Date.now() },
    workflows: { names: [], maxRunsPerHour: 20, allowDelegated: true, ...overrides },
  };
}

/** The delegated caller is OWNERLESS — a cron tick. That is the whole
 *  feature: rung 0's tolerant resolver lets it through with `userId: null`
 *  and the delegation supplies the principal. */
function ctx(overrides: Partial<WorkflowsHandlerContext> = {}): WorkflowsHandlerContext {
  return {
    extensionName: EXT_NAME,
    extensionId,
    userId: null,
    conversationId: null,
    grantedPermissions: granted(),
    manifest: manifest(),
    ...overrides,
  };
}

function req(params: Record<string, unknown> = {}): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: DELEGATED_WORKFLOWS_METHOD,
    params: { v: 1, op: DELEGATED_OP, jobRef: "job-1", ...params },
  };
}

/** Both audit tables, so a test names the destination rather than
 *  asserting "something was written". Returns a VERDICT the caller
 *  asserts on inline — a helper that asserted for me would read as a
 *  vacuous test to the gate, and would also hide which half failed. */
async function auditDestinations(): Promise<{
  sdk: Array<{ errorCode: string | null; onBehalfOf: string; action: string }>;
  log: Array<{ action: string; userId: string | null; metadata: unknown }>;
}> {
  const sdk = await getTestDb()
    .select({
      errorCode: sdkCapabilityCalls.errorCode,
      onBehalfOf: sdkCapabilityCalls.onBehalfOf,
      action: sdkCapabilityCalls.action,
    })
    .from(sdkCapabilityCalls);
  const log = await getTestDb()
    .select({
      action: auditLog.action,
      userId: auditLog.userId,
      metadata: auditLog.metadata,
    })
    .from(auditLog);
  return { sdk, log };
}

interface DelegationSpec {
  ownerKind: "user" | "service";
  ownerId: string;
  workflowName: string;
  jobRef?: string;
  maxTokensPerRun?: number;
  maxRunsPerDay?: number;
  projectId?: string | null;
  /** Overrides the correctly-computed SEMANTIC hash, to drive D6. */
  consentHash?: string;
  /** Overrides the correctly-computed ADVISORY hash. */
  definitionHash?: string;
  /** Overrides the consented capability set — the one input the WIDENING
   *  test actually judges. A set narrower than what the graph reaches is
   *  what makes D6 park; a broken hash alone no longer does. */
  capabilitySet?: Array<{ kind: string; value: string | null }>;
  consentedByUserId?: string;
}

/** Compute the consent record THIS build would take for a spec, through
 *  the same shared assembly the handler uses — a fixture that hard-coded
 *  a digest would pass while the two drifted. */
async function consentRecordFor(spec: DelegationSpec) {
  return computeDelegationConsentRecord({
    entry: cachedEntries.find((e) => e.definition.name === spec.workflowName)!,
    extensionName: EXT_NAME,
    workflowName: spec.workflowName,
    projectId: spec.projectId ?? null,
    runAs: { kind: spec.ownerKind, id: spec.ownerId },
    trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
    principal: delegationPrincipal(spec.ownerKind, spec.ownerId),
    entries: cachedEntries,
    agents,
  });
}

/** Write a delegation whose consent record is what THIS build recomputes
 *  at fire time, so D6 passes unless a test deliberately breaks it. */
async function delegate(spec: DelegationSpec): Promise<string> {
  const record = await consentRecordFor(spec);
  const created = await createWorkflowDelegation({
    extensionId,
    jobRef: spec.jobRef ?? "job-1",
    ownerKind: spec.ownerKind,
    ownerId: spec.ownerId,
    workflowName: spec.workflowName,
    definitionVersionId: null,
    projectId: spec.projectId ?? null,
    triggerKind: "cron",
    triggerSpec: { expr: "0 3 * * *" },
    consentHash: spec.consentHash ?? record.consentHash,
    definitionHash: spec.definitionHash ?? record.definitionHash,
    capabilitySet: spec.capabilitySet ?? record.capabilitySet,
    maxTokensPerRun: spec.maxTokensPerRun ?? 10_000,
    maxRunsPerDay: spec.maxRunsPerDay ?? 10,
    consentedByUserId: spec.consentedByUserId ?? ownerUserId,
  });
  if (!created.ok) throw new Error(`fixture could not consent: ${created.message}`);
  return created.delegation.id;
}

/** The three consent columns off a live row — what a carry-forward moves
 *  and what a park must leave alone. */
async function consentColumnsOf(id: string): Promise<{
  consentHash: string;
  definitionHash: string | null;
  capabilitySet: Array<{ kind: string; value: string | null }>;
}> {
  const [row] = await getTestDb()
    .select({
      consentHash: workflowDelegations.consentHash,
      definitionHash: workflowDelegations.definitionHash,
      capabilitySet: workflowDelegations.capabilitySet,
    })
    .from(workflowDelegations)
    .where(eq(workflowDelegations.id, id));
  return row!;
}

beforeAll(async () => {
  await setupTestDb();
  const owner = await createUser({
    email: "c3-owner@example.com", passwordHash: "h", name: "Owner",
    role: "member", status: "active",
  });
  ownerUserId = owner.id;
  const low = await createUser({
    email: "c3-low@example.com", passwordHash: "h", name: "Low",
    role: "member", status: "active",
  });
  lowPrivUserId = low.id;
  const admin = await createUser({
    email: "c3-admin@example.com", passwordHash: "h", name: "Admin",
    role: "admin", status: "active",
  });
  adminUserId = admin.id;
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "0.0.1", description: "",
    manifest: manifest() as never,
    source: "test", enabled: true, grantedPermissions: granted() as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
  const [proj] = await getTestDb().insert(projects)
    .values({ name: "c3-proj", path: "/tmp/c3" }).returning({ id: projects.id });
  projectId = proj!.id;
  const account = await createServiceAccount({
    name: "org-runner",
    description: "",
    createdBy: { id: adminUserId, role: "admin" },
    projectId: null,
    scopes: [],
    maxTokensPerDay: 100_000,
  });
  serviceAccountId = account.account.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  await getTestDb().delete(workflowStepRuns);
  await getTestDb().delete(workflowRuns);
  await getTestDb().delete(workflowDelegations);
  _resetWorkflowTriggerQuotaForTests();
  _resetWorkflowRateLimitForTests(extensionId);
  _resetWorkflowRuntimeForTests();
  started = [];
  runStatus = "success";
  runWorkflowThrows = false;
  runWorkflowRejects = false;
  cachedEntries = [
    dbEntry(SYSTEM_WF, "system", ownerUserId),
    dbEntry(PROJECT_WF, "project", ownerUserId),
    dbEntry(PRIVATE_WF, "private", adminUserId),
    dbEntry(DEAD_EXT_WF, "system", null),
    dbEntry(TOOLED_WF, "system", ownerUserId),
  ];
  agents = [];
  cacheReader = () => cachedEntries;
  agentReader = () => agents;
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
  delete process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS;
  registerRuntime();
});

afterAll(async () => {
  restoreModuleMocks();
  _resetWorkflowRuntimeForTests();
  await closeTestDb();
});

// ══ THE LEGITIMATE CALLER — the pair for every refusal below ══════════

describe("the accept path", () => {
  test("a user-kind delegation fires as the OWNER and writes all three C3 columns", async () => {
    const delegationId = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      v: 1, workflow: "org-nightly", runAs: "user", started: true,
    });
    expect(started).toHaveLength(1);
    // The OWNER, not the caller — the caller is ownerless.
    expect(started[0]?.userId).toBe(ownerUserId);
    expect(started[0]?.opts).toEqual({
      jobRef: "job-1",
      delegationId,
      runAsKind: "user",
      runAs: ownerUserId,
    });
  });

  test("the wire cannot name the workflow, the owner or the project", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      projectId,
    });

    await handleWorkflowsRpc(
      req({
        // Every one of these is ignored: R-5 took the name off the wire,
        // and the owner/project come off the row. None of them has a
        // representation the handler reads.
        workflow: "someones-private",
        userId: adminUserId,
        onBehalfOf: adminUserId,
        projectId: "forged-project",
        runAs: "service",
      }),
      ctx(),
    );

    expect(started[0]?.workflow.name).toBe("org-nightly");
    expect(started[0]?.userId).toBe(ownerUserId);
    expect(started[0]?.projectId).toBe(projectId);
  });

  test("a user-kind accept audits to sdk_capability_calls as the OWNER, action runFor", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    await handleWorkflowsRpc(req(), ctx());

    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(1);
    expect(sdk[0]).toMatchObject({
      errorCode: null, onBehalfOf: ownerUserId, action: "runFor",
    });
    expect(log).toHaveLength(0);
  });

  test("a SERVICE-kind accept fires with NO user and audits to audit_log", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect((resp.result as { runAs: string }).runAs).toBe("service");
    // No session to stream to — that is the documented trade.
    expect(started[0]?.userId).toBeUndefined();
    expect(started[0]?.opts).toMatchObject({ runAsKind: "service", runAs: serviceAccountId });

    const { sdk, log } = await auditDestinations();
    // The whole point: NOT in sdk_capability_calls, because the insert
    // would be swallowed by the NOT NULL FK and the row would vanish.
    expect(sdk).toHaveLength(0);
    expect(log).toHaveLength(1);
    expect(log[0]?.action).toBe("ext:workflow-delegation-service");
    expect(log[0]?.userId).toBeNull();
  });
});

// ══ R-1 — pinned HONESTLY ════════════════════════════════════════════

describe("the ladder is exactly as wide as the read/run ladder (R-1)", () => {
  test("a LOW-PRIVILEGE user's delegation reaches a `project` workflow it does not own", async () => {
    // This is not a bug and this test is not aspirational. `project`
    // resolves to "any-authenticated-principal"
    // (`workflow-scope.ts` — `readRunAudience`), the platform has no
    // project-membership model, and fork stamps `project`. So a
    // user-kind delegation held by any member reaches every
    // project-visible workflow on the instance.
    //
    // It is pinned so that nobody later reads D7 as narrower than it is,
    // and so that the day a membership model lands, THIS test is what
    // fails and forces the decision to be explicit.
    await delegate({
      ownerKind: "user", ownerId: lowPrivUserId, workflowName: "team-fork",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started[0]?.workflow.name).toBe("team-fork");
    expect(started[0]?.userId).toBe(lowPrivUserId);
  });

  test("…and the SAME workflow is refused for a service account, which reaches `system` only", async () => {
    // The pair that proves the row above is about the LADDER and not
    // about the handler waving everything through.
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "team-fork",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS" });
    expect(started).toHaveLength(0);
  });

  test("`private` binds even a user-kind delegation — the one confidentiality boundary D7 has", async () => {
    await delegate({
      ownerKind: "user", ownerId: lowPrivUserId, workflowName: "someones-private",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS" });
    expect(started).toHaveLength(0);
  });

  test("…and its OWNER's delegation runs it, so the refusal above is ownership and not a blanket deny", async () => {
    await delegate({
      ownerKind: "user", ownerId: adminUserId, workflowName: "someones-private",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started[0]?.workflow.name).toBe("someones-private");
  });
});

// ══ THE RUNGS — deny code × audit destination ════════════════════════

describe("rung 1b — EZCORP_DISABLE_DELEGATED_WORKFLOWS", () => {
  test("the flag reads only `1`", () => {
    expect(delegatedWorkflowsDisabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      delegatedWorkflowsDisabled({ EZCORP_DISABLE_DELEGATED_WORKFLOWS: "true" } as never),
    ).toBe(false);
    expect(
      delegatedWorkflowsDisabled({ EZCORP_DISABLE_DELEGATED_WORKFLOWS: "1" } as never),
    ).toBe(true);
  });

  test("DELEGATION_DISABLED, before any DB work, to the caller's destination", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS = "1";

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_DISABLED" });
    expect(started).toHaveLength(0);
    const { sdk, log } = await auditDestinations();
    // The caller is ownerless, so this pre-attribution rung lands in
    // audit_log under the TRIGGER action — it is not yet a delegation
    // outcome, because no delegation has been read.
    expect(sdk).toHaveLength(0);
    expect(log[0]?.action).toBe("ext:workflow-trigger-no-owner");
  });

  test("it does NOT disable the ordinary ops on the same method", async () => {
    process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS = "1";

    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 2, method: DELEGATED_WORKFLOWS_METHOD, params: { v: 1, op: "runs" } },
      ctx({ userId: ownerUserId }),
    );

    // Refused for having no relation to the kill switch — `runs` reaches
    // its own rungs. What matters is that the reason is NOT
    // DELEGATION_DISABLED.
    expect(resp.error?.data).not.toEqual({ reason: "DELEGATION_DISABLED" });
  });
});

describe("the op is admitted ONLY on the delegated method", () => {
  test("`runFor` on `ezcorp/workflows` is an unknown op", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(
      { ...req(), method: "ezcorp/workflows" },
      ctx({ userId: ownerUserId }),
    );

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_BAD_OP" });
    expect(started).toHaveLength(0);
  });

  test("…and on the delegated method the identical frame runs", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req(), ctx({ userId: ownerUserId }));

    expect(resp.error).toBeUndefined();
  });
});

describe("rung 2b — DELEGATION_NOT_GRANTED", () => {
  test("a grant without `allowDelegated` is refused even though it clears rung 2", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(
      req(),
      // `names` non-empty so rung 2 passes structurally: this proves 2b is
      // its own rung and not a side effect of the rung-2 predicate.
      ctx({ grantedPermissions: granted({ names: ["something"], allowDelegated: false }) }),
    );

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_NOT_GRANTED" });
    expect(started).toHaveLength(0);
    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(0);
    expect(log[0]?.action).toBe("ext:workflow-trigger-no-owner");
  });

  test("…and the same frame with the bit set runs", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ grantedPermissions: granted({ names: ["something"], allowDelegated: true }) }),
    );

    expect(resp.error).toBeUndefined();
  });
});

describe("rung 6 — the PDP, on a KIND-ONLY capability", () => {
  test("a deny is WORKFLOWS_PERM_DENIED and the cap carries NO value", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    const seen: unknown[] = [];

    const resp = await handleWorkflowsRpc(
      req(),
      ctx({
        engine: {
          async authorize(_c: unknown, needed: unknown) {
            seen.push(needed);
            return { decision: "deny" };
          },
        } as never,
      }),
    );

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_PERM_DENIED" });
    // Kind-only: a valued grant cannot cover a valueless need, and job
    // refs are minted after install, so a per-job value is unrepresentable.
    expect(seen).toEqual([[{ kind: "ezcorp:workflows:run-delegated" }]]);
    expect(started).toHaveLength(0);
  });

  test("…and an allow from the same engine runs", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ engine: { async authorize() { return { decision: "allow" }; } } as never }),
    );

    expect(resp.error).toBeUndefined();
  });
});

describe("rung D1 — DELEGATION_BAD_REF", () => {
  test("a non-id-shaped ref is refused as a param error", async () => {
    const resp = await handleWorkflowsRpc(req({ jobRef: "has space" }), ctx());

    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.data).toEqual({ reason: "DELEGATION_BAD_REF" });
  });

  test("a missing ref is refused too — there is no default job", async () => {
    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 1, method: DELEGATED_WORKFLOWS_METHOD, params: { v: 1, op: DELEGATED_OP } },
      ctx(),
    );

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_BAD_REF" });
  });
});

describe("rung D2 — DELEGATION_NOT_FOUND (the §4 inexpressibility)", () => {
  test("a FORGED ref matches zero rows", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req({ jobRef: "job-forged" }), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_NOT_FOUND" });
    expect(started).toHaveLength(0);
  });

  test("another extension's delegation is invisible — the key is the REGISTRY id", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    const [other] = await getTestDb().insert(extensions).values({
      name: "other-ext", version: "0.0.1", description: "",
      manifest: manifest() as never, source: "test", enabled: true,
      grantedPermissions: granted() as never,
    }).returning({ id: extensions.id });

    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ extensionId: other!.id, extensionName: "other-ext" }),
    );

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_NOT_FOUND" });
  });

  test("a REVOKED delegation is not found either", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ revokedAt: new Date() })
      .where(eq(workflowDelegations.id, id));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_NOT_FOUND" });
  });
});

describe("rung D4 — DELEGATION_OWNER_UNRESOLVED, audit_log for BOTH kinds", () => {
  test("a DEACTIVATED owner refuses, and the trail is in audit_log with a NULL user", async () => {
    await delegate({ ownerKind: "user", ownerId: lowPrivUserId, workflowName: "org-nightly" });
    await getTestDb().update(users)
      .set({ status: "inactive" })
      .where(eq(users.id, lowPrivUserId));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_UNRESOLVED" });
    // The message names the FACT, and the fact is the only one that can
    // reach this rung: `owner_user_id` is ON DELETE CASCADE, so a deleted
    // user dies at D2 instead.
    expect(resp.error?.message).toContain("can no longer act");
    const { sdk, log } = await auditDestinations();
    // NOT sdk_capability_calls: the FK would reject an unproven owner and
    // the insert is swallowed, so the denial would VANISH.
    expect(sdk).toHaveLength(0);
    expect(log).toHaveLength(1);
    expect(log[0]?.action).toBe("ext:workflow-delegation-no-owner");
    expect(log[0]?.userId).toBeNull();

    await getTestDb().update(users)
      .set({ status: "active" })
      .where(eq(users.id, lowPrivUserId));
  });

  test("…and the same delegation runs once the owner is active again", async () => {
    await delegate({ ownerKind: "user", ownerId: lowPrivUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("a DISABLED service account refuses to audit_log too", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });
    await getTestDb().update(serviceAccounts)
      .set({ enabled: false })
      .where(eq(serviceAccounts.id, serviceAccountId));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_UNRESOLVED" });
    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(0);
    expect(log[0]?.action).toBe("ext:workflow-delegation-no-owner");

    await getTestDb().update(serviceAccounts)
      .set({ enabled: true })
      .where(eq(serviceAccounts.id, serviceAccountId));
  });

  test("…and the same delegation runs once the account is enabled again", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("a row on the mapped arm with a NULL id names nobody and is refused", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    // The state the CASCADE FKs and `ownerColumnValues` exist to make
    // unreachable — reached here by hand, because "unreachable" is a
    // claim about writers and this rung is the reader that must not trust
    // it.
    await getTestDb().update(workflowDelegations)
      .set({ ownerUserId: null })
      .where(eq(workflowDelegations.id, id));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_UNRESOLVED" });
    const { log } = await auditDestinations();
    expect(log[0]?.action).toBe("ext:workflow-delegation-no-owner");
  });
});

describe("rung D3 — DELEGATION_DISABLED_ROW carries the REASON", () => {
  test("the refusal surfaces `disabled_reason`, not a generic message", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ enabled: false, disabledReason: "stopped: the workflow went private" })
      .where(eq(workflowDelegations.id, id));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_DISABLED_ROW" });
    expect(resp.error?.message).toBe("stopped: the workflow went private");
    // Attribution is already PROVEN at this rung (D4 ran first), so a
    // user-kind outcome names the owner in sdk_capability_calls.
    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(1);
    expect(sdk[0]).toMatchObject({
      errorCode: "DELEGATION_DISABLED_ROW", onBehalfOf: ownerUserId, action: "runFor",
    });
    expect(log).toHaveLength(0);
  });

  test("a disabled SERVICE delegation routes the same refusal to audit_log", async () => {
    const id = await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ enabled: false, disabledReason: "switched off" })
      .where(eq(workflowDelegations.id, id));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_DISABLED_ROW" });
    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(0);
    expect(log[0]?.action).toBe("ext:workflow-delegation-service");
  });

  test("…and an enabled row runs, so the refusal is `enabled` and not the lookup", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });
});

describe("rung D7 — fail CLOSED when the runtime cannot answer", () => {
  test("an unregistered `getCachedWorkflows` refuses instead of falling back", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    _resetWorkflowRuntimeForTests();
    cacheReader = undefined;
    registerRuntime();

    const resp = await handleWorkflowsRpc(req(), ctx());

    // NOT the `systemCachedWorkflow` reconstruction rung 12b may use:
    // that is a `system` entry whose run audience is "anyone", so
    // inheriting it here would turn "we cannot tell who owns this" into
    // "everyone may run it".
    expect(resp.error?.data).toEqual({ reason: "DELEGATION_RUNTIME_UNAVAILABLE" });
    expect(started).toHaveLength(0);
  });

  test("an unregistered `listAgents` refuses too — the hash cannot be honest without it", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    _resetWorkflowRuntimeForTests();
    agentReader = undefined;
    registerRuntime();

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_RUNTIME_UNAVAILABLE" });
    expect(started).toHaveLength(0);
  });

  test("no runtime at all is the pre-existing WORKFLOWS_RUNTIME_UNAVAILABLE", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    _resetWorkflowRuntimeForTests();

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_RUNTIME_UNAVAILABLE" });
  });

  test("…and with both readers registered the same delegation runs", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });
});

describe("rung D7 — DELEGATION_OWNER_LOST_WORKFLOW_ACCESS drives disabled_reason", () => {
  test("a RE-TIERED workflow stops the job, states why, and disables the row", async () => {
    // The scenario the code exists for: a `system` workflow, legitimately
    // consented to by a service account, re-tiered to `project` later.
    const id = await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });
    cachedEntries = [
      dbEntry(SYSTEM_WF, "project", ownerUserId),
      ...cachedEntries.slice(1),
    ];

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS" });
    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    // This is the whole rung: a stated reason instead of silent
    // `consecutive_failures` accrual toward the auto-disable threshold.
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toContain("This job stopped");
    expect(row?.consecutiveFailures).toBe(0);
    // The authority is not destroyed — it is stopped, and re-consenting
    // supersedes it.
    expect(row?.revokedAt).toBeNull();
  });

  test("a workflow the principal cannot even SEE is DELEGATION_WORKFLOW_NOT_FOUND", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    cachedEntries = cachedEntries.filter((e) => e.definition.name !== "org-nightly");

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.data).toEqual({ reason: "DELEGATION_WORKFLOW_NOT_FOUND" });
  });

  test("a DEAD owning extension stops the job — the rung the ladder does not express", async () => {
    // `reloadWorkflows()` never fires on extension install/uninstall, so
    // a disabled extension's workflows stay in the merged cache. The
    // liveness half of `canRunWorkflow` is what catches it, and the
    // ladder alone would wave this through as a `system` entry.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "ghost-ext:deploy",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS" });
    expect(resp.error?.message).toContain("which is not installed");
  });

  test("…and an unchanged, live target runs", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });
});

/**
 * ## D6 is a WIDENING test now, not an equality test
 *
 * It used to park on ANY difference between the stored digest and the
 * recomputed one, over a single hash that folded the workflow definition
 * in with the capability closure. `ez-factory` is BUNDLED — its workflows
 * ship inside the app image — so every release that edited one of its
 * `*.workflow.yaml` files, its permissions block, or a referenced agent's
 * capabilities parked EVERY delegation and stopped unattended execution
 * until a human re-approved a capability set that had not moved.
 *
 * `consent_hash` is now the SEMANTIC surface (the delegation facts, the
 * flat capability closure, the walk's bounds), `definition_hash` is the
 * ADVISORY graph fingerprint, and the gate is: **did the closure GROW?**
 * Every test below is paired accordingly — one that grows and parks, one
 * that does not and carries — because "it parks" is satisfied by a rung
 * that parks unconditionally and "it runs" by one that never checks.
 */
describe("rung D6 — a WIDENED closure PARKS the run", () => {
  test("a closure that GREW writes a suspended run instead of executing", async () => {
    // The delegation was consented against a set that reaches NOTHING;
    // the live graph reaches a tool. That is a capability the human never
    // approved, so nothing may execute under it.
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
      capabilitySet: [],
      consentHash: "a-hash-from-a-graph-that-no-longer-exists",
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
    expect(started).toHaveLength(0);
    const runs = await getTestDb().select().from(workflowRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "suspended",
      suspendedReason: "consent-stale",
      delegationId: id,
      runAsKind: "user",
      runAs: ownerUserId,
      userId: ownerUserId,
      runPhase: "boundary",
    });
    expect(runs[0]?.finishedAt).toBeNull();
    expect(runs[0]?.cursor).toEqual({ batchIndex: 0, completedSteps: [], prevStepName: null });
    // The response names the parked run so a console can link to it.
    expect(resp.error?.data).toMatchObject({ workflowRunId: runs[0]!.id });
    // A park CHANGES NOTHING on the row. The whole point is that a human
    // has to look; a rung that healed the record it just refused would be
    // granting the consent it is asking for.
    const after = await consentColumnsOf(id);
    expect(after.consentHash).toBe("a-hash-from-a-graph-that-no-longer-exists");
    expect(after.capabilitySet).toEqual([]);
  });

  test("the audit row NAMES the keys that widened, so a reviewer need not re-derive them", async () => {
    // Without this the operator is told "something changed" and has to
    // walk the closure by hand to find out what.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
      consentHash: "stale",
      capabilitySet: [{ kind: "tool", value: "ext__do_thing" }],
    });

    await handleWorkflowsRpc(req(), ctx());

    const { sdk } = await auditDestinations();
    expect(sdk).toHaveLength(1);
    const after = (
      await getTestDb().select({ after: sdkCapabilityCalls.after }).from(sdkCapabilityCalls)
    )[0]?.after as { parked: boolean; added: string[] };
    expect(after.parked).toBe(true);
    // Only the key that was NOT consented. `tool::ext__do_thing` was.
    expect(after.added).toEqual(["tool:unreachable::ext__do_thing"]);
  });

  test("no `workflow_approvals` row is written — answering one would not resume it", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
      capabilitySet: [],
      consentHash: "stale",
    });

    await handleWorkflowsRpc(req(), ctx());

    const { workflowApprovals } = await import("../../db/schema");
    const approvals = await getTestDb().select().from(workflowApprovals);
    expect(approvals).toHaveLength(0);
  });

  test("a SERVICE park routes its audit row to audit_log and owns no user", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-tooled",
      capabilitySet: [],
      consentHash: "stale",
    });

    await handleWorkflowsRpc(req(), ctx());

    const runs = await getTestDb().select().from(workflowRuns);
    expect(runs[0]?.userId).toBeNull();
    expect(runs[0]?.runAs).toBe(serviceAccountId);
    const { sdk, log } = await auditDestinations();
    expect(sdk).toHaveLength(0);
    expect(log[0]?.action).toBe("ext:workflow-delegation-service");
  });

  test("the closure is still the OWNER KIND's: a delegation that GAINS a child parks", async () => {
    // The direction that matters. A `service` principal cannot resolve
    // the project-visible child, so it consents to a strictly smaller
    // graph. Storing THAT record on a `user` delegation — which does
    // resolve the child — means the fire reaches the child's tool, a
    // capability nobody approved.
    const parent: WorkflowDefinition = {
      name: "org-nightly",
      description: "",
      steps: [{ name: "n", kind: "workflow", workflow: "team-fork", input: {} }],
    };
    cachedEntries = [
      dbEntry(parent, "system", ownerUserId),
      dbEntry(PROJECT_TOOLED_WF, "project", ownerUserId),
    ];
    const asService = await consentRecordFor({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
    });
    expect(asService.capabilitySet, "the service principal cannot see the child").toEqual([]);
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      consentHash: asService.consentHash,
      definitionHash: asService.definitionHash,
      capabilitySet: asService.capabilitySet,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
    expect(started).toHaveLength(0);
  });
});

describe("rung D6 — an unchanged or NARROWED closure carries consent forward", () => {
  /** Every `ext:workflow-delegation-reauthorized` row, with its metadata. */
  async function carryRows(): Promise<Array<{ userId: string | null; metadata: unknown }>> {
    const { log } = await auditDestinations();
    return log
      .filter((r) => r.action === "ext:workflow-delegation-reauthorized")
      .map((r) => ({ userId: r.userId, metadata: r.metadata }));
  }

  test("an UNCHANGED graph passes D6, runs, and re-stamps nothing", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
    });
    const before = await consentColumnsOf(id);

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(await getTestDb().select().from(workflowRuns)).toHaveLength(0);
    // `fresh` writes NOTHING — not the row, and not an audit row claiming
    // a release re-authorized something that never moved.
    expect(await consentColumnsOf(id)).toEqual(before);
    expect(await carryRows()).toHaveLength(0);
  });

  test("a DEFINITION-only edit runs and audits 're-authorized by release'", async () => {
    // THE defect. Consent against the current graph…
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
    });
    const before = await consentColumnsOf(id);
    // …then do what a release does to a bundled extension's shipped
    // workflow: change a step's `when` guard. No capability declaration
    // moves, so the job reaches exactly what was approved. This used to
    // park every delegation on the extension.
    cachedEntries = [
      ...cachedEntries.slice(0, 4),
      dbEntry(
        {
          ...TOOLED_WF,
          steps: [
            {
              name: "call",
              kind: "tool",
              tool: "ext__do_thing",
              input: {},
              when: { ref: "$input.go", op: "truthy" },
            },
          ],
        },
        "system",
        ownerUserId,
      ),
    ];

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(await getTestDb().select().from(workflowRuns)).toHaveLength(0);
    // The ADVISORY digest moved and the SEMANTIC one did not.
    const after = await consentColumnsOf(id);
    expect(after.definitionHash).not.toBe(before.definitionHash);
    expect(after.consentHash).toBe(before.consentHash);
    expect(after.capabilitySet).toEqual(before.capabilitySet);
    // And it is on the record, attributed to the human answerable for the
    // consent — a re-authorization with no trace is the one shape a
    // consent control must never have.
    const rows = await carryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ownerUserId);
    expect(rows[0]?.metadata).toMatchObject({
      reason: "re-authorized by release",
      delegationId: id,
      definitionChanged: true,
      semanticChanged: false,
      removed: [],
      stamped: true,
    });
  });

  test("a NARROWED closure carries forward AND rewrites capability_set", async () => {
    // The re-widening hole. If the row kept the wider set, the release
    // that puts the tool back would compare against it, find nothing
    // added, and re-grant with no human in the loop.
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
    });
    expect((await consentColumnsOf(id)).capabilitySet.length).toBeGreaterThan(0);
    const narrowed = { ...TOOLED_WF, steps: [{ name: "call", kind: "transform" as const, output: {} }] };
    cachedEntries = [...cachedEntries.slice(0, 4), dbEntry(narrowed, "system", ownerUserId)];

    const first = await handleWorkflowsRpc(req(), ctx());

    expect(first.error).toBeUndefined();
    expect(await consentColumnsOf(id)).toMatchObject({ capabilitySet: [] });
    const rows = await carryRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      semanticChanged: true,
      removed: ["tool::ext__do_thing", "tool:unreachable::ext__do_thing"],
    });

    // …and putting it back is a WIDENING against the narrowed set.
    cachedEntries = [...cachedEntries.slice(0, 4), dbEntry(TOOLED_WF, "system", ownerUserId)];
    _resetWorkflowRateLimitForTests(extensionId);
    const second = await handleWorkflowsRpc(req(), ctx());

    expect(second.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
  });

  test("a PRE-SPLIT row (definition_hash NULL) heals on its first fire", async () => {
    // The migration, executed. There is deliberately no backfill: a row
    // written before the split has no honest value for the new column, so
    // NULL reads as "the definition changed" and the widening test decides.
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-tooled",
    });
    await getTestDb()
      .update(workflowDelegations)
      .set({ definitionHash: null, consentHash: "a-v1-combined-digest" })
      .where(eq(workflowDelegations.id, id));

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    const after = await consentColumnsOf(id);
    expect(after.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.consentHash).not.toBe("a-v1-combined-digest");
    expect((await carryRows())[0]?.metadata).toMatchObject({ definitionChanged: true });
  });

  test("a NARROWED closure carried forward is still the OWNER KIND's", async () => {
    // The mirror of the widening test above: a record consented as a USER
    // (which resolves the project child) stored on a SERVICE delegation
    // reaches strictly LESS at fire time, so it carries rather than parks.
    const parent: WorkflowDefinition = {
      name: "org-nightly",
      description: "",
      steps: [{ name: "n", kind: "workflow", workflow: "team-fork", input: {} }],
    };
    cachedEntries = [
      dbEntry(parent, "system", ownerUserId),
      dbEntry(PROJECT_TOOLED_WF, "project", ownerUserId),
    ];
    const asUser = await consentRecordFor({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    expect(asUser.capabilitySet.length, "the user principal DOES see the child").toBeGreaterThan(0);
    const id = await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
      consentHash: asUser.consentHash,
      definitionHash: asUser.definitionHash,
      capabilitySet: asUser.capabilitySet,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started).toHaveLength(1);
    expect((await consentColumnsOf(id)).capabilitySet).toEqual([]);
  });
});

describe("rung D8 — DELEGATION_QUOTA_EXCEEDED, a UTC calendar day", () => {
  test("the cap refuses once today's runs reach it", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      maxRunsPerDay: 2,
    });
    for (let i = 0; i < 2; i++) {
      await getTestDb().insert(workflowRuns).values({
        id: `today-${i}`, workflowName: "org-nightly", status: "success",
        input: {}, startedAt: new Date(), delegationId: id,
      });
    }

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.code).toBe(-32103);
    expect(resp.error?.data).toEqual({ reason: "DELEGATION_QUOTA_EXCEEDED" });
    const { sdk } = await auditDestinations();
    expect(sdk[0]).toMatchObject({
      errorCode: "DELEGATION_QUOTA_EXCEEDED", onBehalfOf: ownerUserId,
    });
  });

  test("YESTERDAY's runs do not count — it is a calendar day, not a rolling window", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      maxRunsPerDay: 2,
    });
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      await getTestDb().insert(workflowRuns).values({
        id: `old-${i}`, workflowName: "org-nightly", status: "success",
        input: {}, startedAt: yesterday, delegationId: id,
      });
    }

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("ANOTHER delegation's runs do not count against this one", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      maxRunsPerDay: 1,
    });
    const otherId = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "team-fork",
      jobRef: "job-2", maxRunsPerDay: 1,
    });
    await getTestDb().insert(workflowRuns).values({
      id: "other-run", workflowName: "team-fork", status: "success",
      input: {}, startedAt: new Date(), delegationId: otherId,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });
});

describe("rung D9 — DELEGATION_SPEND_EXCEEDED at dispatch", () => {
  test("a cap that admits no work refuses instead of starting a permanently-stuck run", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      maxTokensPerRun: 0,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_SPEND_EXCEEDED" });
    expect(started).toHaveLength(0);
    // Nothing was created — the point is that a zero cap would otherwise
    // produce a run that parks at its first boundary and that the
    // `budget-exceeded` resume rule then refuses forever.
    expect(await getTestDb().select().from(workflowRuns)).toHaveLength(0);
  });

  test("…and a positive cap runs, carrying delegationId into the executor", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      maxTokensPerRun: 1,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started[0]?.opts?.delegationId).toBe(id);
  });
});

// ══ rung D10 — service_accounts.max_tokens_per_day ═══════════════════
//
// Phase 2 shipped the column and NOTHING read it: a control that was not
// one. This is the rung that reads it, and every test below asserts the
// deny code AND the audit destination, because a `service` outcome
// carries a NULL user and `sdk_capability_calls.on_behalf_of` is NOT NULL
// with an FK to `users` — get the destination wrong and the denial is not
// merely misfiled, it is SWALLOWED.

/** A settled day of spend attributed to one service account: a run row
 *  carrying the `run_as` snapshot, plus a step row carrying the tokens. */
async function seedServiceSpend(spec: {
  accountId: string;
  tokens: number;
  runId: string;
  startedAt?: Date;
}): Promise<void> {
  await getTestDb().insert(workflowRuns).values({
    id: spec.runId,
    workflowName: "org-nightly",
    status: "success",
    input: {},
    startedAt: spec.startedAt ?? new Date(),
    // The SNAPSHOT, not `delegation_id`. That is what the aggregate keys
    // on, precisely so a revoke or a supersede cannot refund a day.
    runAsKind: "service",
    runAs: spec.accountId,
  });
  await getTestDb().insert(workflowStepRuns).values({
    workflowRunId: spec.runId,
    stepName: "s1",
    status: "success",
    inputTokens: spec.tokens,
    outputTokens: 0,
  });
}

/** A fresh service account with a chosen daily cap. Named uniquely
 *  because `uniq_service_account_name` is global and `beforeEach` does
 *  not clear this table. */
async function account(maxTokensPerDay: number): Promise<string> {
  const created = await createServiceAccount({
    name: `d10-${crypto.randomUUID()}`,
    description: "",
    createdBy: { id: adminUserId, role: "admin" },
    projectId: null,
    scopes: [],
    maxTokensPerDay,
  });
  return created.account.id;
}

describe("rung D10 — DELEGATION_DAILY_TOKENS_EXCEEDED, and it audits to audit_log", () => {
  test("an account that has spent its day is refused, and the denial lands in audit_log", async () => {
    const accountId = await account(500);
    await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
    });
    await seedServiceSpend({ accountId, tokens: 500, runId: "spent-1" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_DAILY_TOKENS_EXCEEDED" });
    // The message names both halves, because the remedy (an admin raising
    // the ACCOUNT's cap) is a different object from the delegation.
    expect(resp.error?.message).toContain("500/500");
    expect(started).toHaveLength(0);

    const { sdk, log } = await auditDestinations();
    // THE destination assertion. A `service` outcome has no `users` row,
    // so an attempt to file it here would be swallowed by the FK and the
    // denial would vanish.
    expect(sdk).toHaveLength(0);
    expect(log).toHaveLength(1);
    expect(log[0]?.action).toBe("ext:workflow-delegation-service");
    expect(log[0]?.userId).toBeNull();
    expect((log[0]?.metadata as { reason?: string })?.reason).toBe(
      "DELEGATION_DAILY_TOKENS_EXCEEDED",
    );
  });

  test("…and the SAME account one token under its cap fires", async () => {
    // The pair. Without it, "it refused" is satisfied by a rung that
    // refuses every service-kind delegation outright.
    const accountId = await account(500);
    const id = await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
    });
    await seedServiceSpend({ accountId, tokens: 499, runId: "spent-2" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started[0]?.opts?.delegationId).toBe(id);
    // A service-owned run streams to nobody — no session to stream to.
    expect(started[0]?.userId).toBeUndefined();
  });

  test("YESTERDAY's tokens do not count — a calendar day, not a rolling window", async () => {
    const accountId = await account(500);
    await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
    });
    await seedServiceSpend({
      accountId,
      tokens: 5_000,
      runId: "spent-old",
      startedAt: new Date(Date.now() - 36 * 60 * 60 * 1000),
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("ANOTHER account's spend does not count against this one", async () => {
    const mine = await account(500);
    const theirs = await account(500);
    await delegate({ ownerKind: "service", ownerId: mine, workflowName: "org-nightly" });
    await seedServiceSpend({ accountId: theirs, tokens: 9_000, runId: "spent-theirs" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("spend attributed to a USER-kind run does not count against an account", async () => {
    // Both columns are filtered, not just `run_as`. The two ids live in
    // different namespaces and are both bare text; matching on the id
    // alone would let a user run drain an account's day if the two ever
    // collided.
    const accountId = await account(500);
    await delegate({ ownerKind: "service", ownerId: accountId, workflowName: "org-nightly" });
    await getTestDb().insert(workflowRuns).values({
      id: "user-kind-run",
      workflowName: "org-nightly",
      status: "success",
      input: {},
      startedAt: new Date(),
      runAsKind: "user",
      // Deliberately the ACCOUNT's id on the `user` arm — the exact
      // collision the discriminator exists to reject.
      runAs: accountId,
    });
    await getTestDb().insert(workflowStepRuns).values({
      workflowRunId: "user-kind-run",
      stepName: "s1",
      status: "success",
      inputTokens: 9_000,
      outputTokens: 0,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });

  test("a USER-kind delegation is not subject to this rung at all", async () => {
    // `users` carries no daily token column, and D4's `user` arm returns
    // `dailyTokenCap: null` rather than inventing a default. A user
    // delegation whose owner has spent an enormous amount today still
    // fires — it is bounded by its own two caps, which is what the human
    // agreed to.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().insert(workflowRuns).values({
      id: "user-spend", workflowName: "org-nightly", status: "success",
      input: {}, startedAt: new Date(), runAsKind: "user", runAs: ownerUserId,
    });
    await getTestDb().insert(workflowStepRuns).values({
      workflowRunId: "user-spend", stepName: "s1", status: "success",
      inputTokens: 1_000_000, outputTokens: 1_000_000,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
  });
});

describe("the three token/run bounds are SEPARATE, and each says which one it was", () => {
  // D8 counts RUNS for one delegation. D9 asks whether the per-RUN token
  // cap admits any work. D10 sums TOKENS for one ACCOUNT across every
  // delegation it owns. Three conditions, three codes, three remedies —
  // and a caller must be able to tell them apart from the audit row
  // alone, because "my cron job stopped" looks identical from outside.

  test("D10 fires while D8 and D9 are both generous", async () => {
    const accountId = await account(100);
    await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
      // Both of the OTHER bounds wide open.
      maxRunsPerDay: 1000, maxTokensPerRun: 1_000_000,
    });
    await seedServiceSpend({ accountId, tokens: 100, runId: "sep-1" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_DAILY_TOKENS_EXCEEDED" });
  });

  test("D8 fires while D10 is generous — a RUN count, not a token count", async () => {
    const accountId = await account(1_000_000);
    const id = await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
      maxRunsPerDay: 1, maxTokensPerRun: 1_000_000,
    });
    // One prior run TODAY against this delegation, spending nothing. D10
    // sees zero tokens; D8 sees one run.
    await getTestDb().insert(workflowRuns).values({
      id: "sep-2", workflowName: "org-nightly", status: "success",
      input: {}, startedAt: new Date(), delegationId: id,
      runAsKind: "service", runAs: accountId,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_QUOTA_EXCEEDED" });
  });

  test("D9 fires while D8 and D10 are both generous — a PER-RUN cap", async () => {
    const accountId = await account(1_000_000);
    await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
      maxRunsPerDay: 1000, maxTokensPerRun: 0,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_SPEND_EXCEEDED" });
  });

  test("…and with all three satisfied the fire goes through", async () => {
    const accountId = await account(1_000_000);
    const id = await delegate({
      ownerKind: "service", ownerId: accountId, workflowName: "org-nightly",
      maxRunsPerDay: 1000, maxTokensPerRun: 1_000_000,
    });
    await seedServiceSpend({ accountId, tokens: 10, runId: "sep-4" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(started[0]?.opts?.delegationId).toBe(id);
  });
});

describe("rung 13 — dispatch, and the failure counter", () => {
  test("a throwing executor is WORKFLOWS_DISPATCH_FAILED and counts a failure", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    runWorkflowThrows = true;

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_DISPATCH_FAILED" });
    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(1);
  });

  test("five consecutive ERROR outcomes auto-disable the row with a stated reason", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    runStatus = "error";
    for (let i = 0; i < 5; i++) {
      _resetWorkflowRateLimitForTests(extensionId);
      await handleWorkflowsRpc(req(), ctx());
      // The counter is folded in from the run's terminal status, which
      // arrives on the fire-and-forget promise. Awaited through the
      // module's own handle rather than by sleeping — a tick loop is the
      // assertion that passes on a fast machine and hides a dropped write
      // on a slow one.
      await _awaitDelegatedDispatchForTests();
    }

    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(5);
    expect(row?.enabled).toBe(false);
    expect(row?.disabledReason).toContain("5 consecutive failed runs");
  });

  test("a SUCCESS resets the counter — a job that recovers is not one failure from disabled", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ consecutiveFailures: 4 })
      .where(eq(workflowDelegations.id, id));

    await handleWorkflowsRpc(req(), ctx());
    await _awaitDelegatedDispatchForTests();

    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(0);
    expect(row?.enabled).toBe(true);
  });

  test("a REJECTED dispatch promise is absorbed, logged, and counts NOTHING", async () => {
    // An executor that rejects is a BUG, not a run outcome. Absorbing it
    // keeps an unhandled rejection from taking the process down; counting
    // it would auto-disable a healthy job because the host misbehaved.
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ consecutiveFailures: 2 })
      .where(eq(workflowDelegations.id, id));
    runWorkflowRejects = true;

    // The RPC still succeeds — the dispatch is un-awaited by design.
    const resp = await handleWorkflowsRpc(req(), ctx());
    expect(resp.error).toBeUndefined();
    await _awaitDelegatedDispatchForTests();

    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(2);
    expect(row?.enabled).toBe(true);
  });

  test("a SUSPENDED run is not a failure — an approval-parked job must not auto-disable", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    await getTestDb().update(workflowDelegations)
      .set({ consecutiveFailures: 3 })
      .where(eq(workflowDelegations.id, id));
    runStatus = "suspended";

    await handleWorkflowsRpc(req(), ctx());
    await _awaitDelegatedDispatchForTests();

    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(3);
  });
});

describe("the shared rungs still bound the delegated op", () => {
  test("rung 10 — a non-object `input` is WORKFLOWS_BAD_PAYLOAD", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req({ input: [1, 2] }), ctx());

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("rung 10 — a missing `v` is refused", async () => {
    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 1, method: DELEGATED_WORKFLOWS_METHOD, params: { op: DELEGATED_OP, jobRef: "job-1" } },
      ctx(),
    );

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("rung 11 — the delegated op consumes the SAME hourly budget as `run`", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });

    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ grantedPermissions: granted({ maxRunsPerHour: 1 }) }),
    );
    expect(resp.error).toBeUndefined();

    _resetWorkflowRateLimitForTests(extensionId);
    const second = await handleWorkflowsRpc(
      req(),
      ctx({ grantedPermissions: granted({ maxRunsPerHour: 1 }) }),
    );
    expect(second.error?.data).toEqual({ reason: "WORKFLOWS_QUOTA_EXCEEDED" });
  });

  test("rung 9 — the delegated op drains the SAME bucket the `run` op uses", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    // The hourly ceiling is raised out of the way so the refusal below can
    // only be the INSTANTANEOUS bucket — rung 11 has its own test. The
    // bound on the drain loop is what makes a broken limiter fail rather
    // than hang.
    //
    // THE CLOCK IS FROZEN FOR THE WHOLE EXCHANGE, and that is load-bearing.
    // `createRateLimiter` refills on WALL-CLOCK time (50 tokens/s = one
    // token per 20ms) and a REFUSED consume deducts nothing — so the instant
    // the loop sees its first `WORKFLOWS_RATE_LIMITED` the bucket already
    // holds some fraction in [0,1) and is climbing back toward 1. Whether
    // the `run` op below still finds it empty was therefore a race against
    // however long that call takes to reach rung 9: locally it wins by ~1ms,
    // but on a loaded runner a single scheduler preemption of ~13ms hands
    // the `run` op a refilled token and the rung goes red for a reason that
    // has nothing to do with the property it pins. (Observed: PR #88 CI,
    // `shard 1/12`, where the isolated plain re-run failed too — the same
    // suite is green on a quiet box, which is exactly the signature.)
    //
    // Freezing removes the refill term entirely: the drain becomes exactly
    // MAX_OPS_PER_SECOND accepted calls then a refusal, and the bucket is
    // PROVABLY at zero when the `run` op asks. Nothing is loosened — this is
    // the strict form of the same claim, and it is the same technique the
    // sibling burst test states in prose ("no wall-clock refill can smear
    // the burst", `workflows-handler.test.ts`).
    const wide = ctx({ grantedPermissions: granted({ maxRunsPerHour: 5000 }) });
    const runner = ctx({
      userId: ownerUserId,
      grantedPermissions: granted({ names: ["own"], maxRunsPerHour: 5000 }),
      manifest: {
        ...manifest(),
        permissions: { workflows: { names: ["own"], maxRunsPerHour: 5000 } },
      } as unknown as ExtensionManifestV2,
    });

    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    let drained = false;
    let shared: Awaited<ReturnType<typeof handleWorkflowsRpc>>;
    try {
      for (let i = 0; i < 400 && !drained; i++) {
        const r = await handleWorkflowsRpc(req(), wide);
        drained = (r.error?.data as { reason?: string } | undefined)?.reason
          === "WORKFLOWS_RATE_LIMITED";
      }
      // THE point of the test: a plain `run` on the SAME extension is now
      // refused too. A delegated fire that carried its own bucket would
      // double the extension's burst budget, and this is what would notice.
      shared = await handleWorkflowsRpc(
        { jsonrpc: "2.0", id: 9, method: "ezcorp/workflows", params: { v: 1, workflow: "own" } },
        runner,
      );
    } finally {
      // Restored before the assertions so a red rung can never leak a
      // frozen clock into the rest of the file.
      clock.mockRestore();
    }

    expect(drained).toBe(true);
    expect(shared.error?.data).toEqual({ reason: "WORKFLOWS_RATE_LIMITED" });
  });

  test("rung 8 — a conversation the extension is not wired to is refused", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    const { conversations } = await import("../../db/schema");
    const [conv] = await getTestDb().insert(conversations)
      .values({ projectId, userId: ownerUserId, title: "t", kind: "regular" })
      .returning({ id: conversations.id });

    const resp = await handleWorkflowsRpc(req(), ctx({ conversationId: conv!.id }));

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_NOT_WIRED" });
  });

  test("rung 1 — the tier kill switch still wins over everything", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "WORKFLOWS_DISABLED" });
  });
});

describe("the ordinary `run` op requires release provenance", () => {
  test("an extension workflow without cached release provenance is refused", async () => {
    _resetWorkflowRuntimeForTests();
    cacheReader = undefined;
    cachedEntries = [systemCachedWorkflow(
      { name: `${EXT_NAME}:own`, description: "", steps: [{ name: "t", kind: "transform", output: {} }] },
      "extension",
    )];
    registerRuntime();

    const resp = await handleWorkflowsRpc(
      {
        jsonrpc: "2.0", id: 3, method: "ezcorp/workflows",
        params: { v: 1, workflow: "own" },
      },
      ctx({
        userId: ownerUserId,
        grantedPermissions: granted({ names: ["own"] }),
        manifest: {
          ...manifest(),
          permissions: { workflows: { names: ["own"], maxRunsPerHour: 20 } },
        } as unknown as ExtensionManifestV2,
      }),
    );

    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOW_NOT_FOUND" });
    expect(started).toHaveLength(0);
  });
});

// ══ PHASE 7 — the SDK surface that speaks to this ladder ══════════════
//
// `packages/@ezcorp/sdk/src/runtime/workflows.ts` is the only `runFor`
// caller a third-party author will ever write. These tests drive the REAL
// `Workflows` class — no hand-built frame — and route whatever it emits
// into the REAL handler above, translating the response the way
// `HostChannel` itself does (`channel.ts`: a JSON-RPC `error` envelope
// with a numeric `code` becomes a rejected `JsonRpcError`).
//
// That transport double is the whole point. The SDK's own unit tests can
// only assert about the frame it chooses to send, and this file's other
// tests can only assert about frames a test author chose to build. Between
// the two there is exactly one gap — an SDK that sends a frame this ladder
// does not answer the way the SDK's docs claim — and it is the gap an
// extension author falls into.
describe("the SDK surface — Workflows.runFor", () => {
  /** Route the SDK's outbound frame into the real handler, optionally
   *  overriding the METHOD to prove the op is not admitted on the other
   *  one. Returns the frames it saw, for the caller to assert on inline. */
  function wireSdkToHost(
    opts: { ctx?: Partial<WorkflowsHandlerContext>; method?: string } = {},
  ): {
    seen: Array<{ method: string; params: Record<string, unknown> }>;
    spy: ReturnType<typeof spyOn>;
  } {
    const ch: HostChannel = getChannel();
    const spy = spyOn(ch, "request");
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    spy.mockImplementation((async (method: string, params: unknown) => {
      const frameParams = (params ?? {}) as Record<string, unknown>;
      seen.push({ method, params: frameParams });
      const frame: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: opts.method ?? method,
        params: frameParams,
      };
      const resp = await handleWorkflowsRpc(frame, ctx(opts.ctx ?? {}));
      if (resp.error) {
        throw new JsonRpcError(resp.error.code, resp.error.message, resp.error.data);
      }
      return resp.result;
    }) as HostChannel["request"]);
    return { seen, spy };
  }

  /** The rejection the SDK caller actually sees, as a verdict to assert on
   *  inline — `.rejects.toThrow` matches a MESSAGE, and every one of these
   *  rungs is distinguished by its `data.reason`, not by its wording. */
  async function refusal(promise: Promise<unknown>): Promise<JsonRpcError> {
    const err = await promise.then(() => null).catch((e: unknown) => e);
    if (!(err instanceof JsonRpcError)) {
      throw new Error(`expected a JsonRpcError, got: ${String(err)}`);
    }
    return err;
  }

  afterEach(() => {
    __resetChannelForTests();
  });

  test("THE LEGITIMATE CALLER — the SDK fires a real delegation and gets the envelope its type promises", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const { seen, spy } = wireSdkToHost();

    const res = await new Workflows().runFor({ jobRef: "job-1", input: { ref: "main" } });

    expect(res).toEqual({ v: 1, workflow: "org-nightly", runAs: "user", started: true });
    // It reached the executor as the OWNER, not as the (ownerless) caller.
    expect(started).toHaveLength(1);
    expect(started[0]?.userId).toBe(ownerUserId);
    expect(started[0]?.input).toEqual({ ref: "main" });
    // And the frame that got it there named no principal and no workflow.
    expect(seen[0]?.method).toBe(DELEGATED_WORKFLOWS_METHOD);
    expect(Object.keys(seen[0]!.params).sort()).toEqual(["input", "jobRef", "op", "v"]);
    spy.mockRestore();
  });

  test("without `allowDelegated` it is DELEGATION_NOT_GRANTED — rung 2b, not some other refusal", async () => {
    // The pair for the accept above: same delegation, same call, one bit
    // off a grant that still clears rung 2 structurally (non-empty
    // `names`, matching the rung-2b fixture higher up this file).
    // `WORKFLOWS_BAD_OP` here would mean the op never got routed at all —
    // which reads as "it denied" to a test that only asserted a rejection.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const { spy } = wireSdkToHost({
      ctx: { grantedPermissions: granted({ names: ["something"], allowDelegated: false }) },
    });

    const err = await refusal(new Workflows().runFor({ jobRef: "job-1" }));

    expect(err.data).toEqual({ reason: "DELEGATION_NOT_GRANTED" });
    expect(started).toHaveLength(0);
    spy.mockRestore();
  });

  test("…but a DELEGATED-ONLY grant that lost the bit dies one rung earlier, as WORKFLOWS_NOT_GRANTED", async () => {
    // The shape a real delegated-only extension actually has — `names: []`
    // — and the reason the SDK's docs name BOTH codes rather than just the
    // delegated one. Dropping `allowDelegated` from such a manifest takes
    // the empty-`names` carve-out away with it, so the grant stops being
    // structurally usable at rung 2 and never reaches 2b. Same author
    // mistake, different code: an author who only handled
    // `DELEGATION_NOT_GRANTED` would see an unrecognised failure for the
    // most likely way of making it.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const { spy } = wireSdkToHost({
      ctx: { grantedPermissions: granted({ names: [], allowDelegated: false }) },
    });

    const err = await refusal(new Workflows().runFor({ jobRef: "job-1" }));

    expect(err.data).toEqual({ reason: "WORKFLOWS_NOT_GRANTED" });
    expect(started).toHaveLength(0);
    spy.mockRestore();
  });

  test("the SAME frame on `ezcorp/workflows` is WORKFLOWS_BAD_OP — the method is the control", async () => {
    // The SDK targets `ezcorp/workflows-delegated` because that method's
    // rung 0 tolerates an ownerless fire. If a future edit "simplified"
    // the SDK onto the one method the other three ops use, this is the
    // wall it hits — and it hits it with a live delegation in the table,
    // so the refusal is about the method and nothing else.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const { spy } = wireSdkToHost({ method: "ezcorp/workflows" });

    const err = await refusal(new Workflows().runFor({ jobRef: "job-1" }));

    expect(err.data).toEqual({ reason: "WORKFLOWS_BAD_OP" });
    expect(err.code).toBe(-32602);
    expect(started).toHaveLength(0);
    spy.mockRestore();
  });

  test("under the kill switch it is DELEGATION_DISABLED, and the delegation row is untouched", async () => {
    // What the SDK's docblock tells an author: transient, instance-wide,
    // operator-controlled, and NOT a statement about their job — so they
    // must not disable or delete anything of their own in response. That
    // advice is only safe if the host really does leave the row alone,
    // which is what the row comparison below is for. (Rung 1b sits above
    // every database rung, so "untouched" is also the observable half of
    // "refused before any database work".)
    const delegationId = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const before = await getTestDb()
      .select().from(workflowDelegations).where(eq(workflowDelegations.id, delegationId));
    process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS = "1";
    const { spy } = wireSdkToHost();

    const err = await refusal(new Workflows().runFor({ jobRef: "job-1" }));

    expect(err.data).toEqual({ reason: "DELEGATION_DISABLED" });
    expect(started).toHaveLength(0);
    const after = await getTestDb()
      .select().from(workflowDelegations).where(eq(workflowDelegations.id, delegationId));
    expect(after).toEqual(before);
    // Scoped to this VERB: the same extension's status poll still answers
    // while the switch is set, which is the other half of the claim.
    const runs = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 9, method: DELEGATED_WORKFLOWS_METHOD, params: { v: 1, op: "runs" } },
      ctx({ userId: ownerUserId }),
    );
    expect(runs.error).toBeUndefined();
    spy.mockRestore();
  });

  test("the delegated run is INVISIBLE to `ctx.workflows.runs()` — the SDK says so because it is true", async () => {
    // The SDK's docblock tells an author `runFor()` is fire-and-forget and
    // that polling `runs()` will never find the run. That is a claim about
    // the READ path, so it is proved here rather than asserted there: an
    // author who believed the opposite would poll an empty list forever,
    // which is the same failure shape as the `workflow:*` subscription
    // that registers and never fires.
    //
    // Paired with the first-party run in the SAME read, so this cannot
    // pass merely because the fixture or the reader is broken.
    // Written through the same query helper the park path uses, rather
    // than a hand-built row: a fixture that drifted from the real writer
    // would prove nothing about the real reader.
    for (const workflowName of ["org-nightly", `${EXT_NAME}:own`]) {
      await insertWorkflowRun({
        id: crypto.randomUUID(),
        workflowName,
        userId: ownerUserId,
        input: {},
        startedAt: new Date(),
        jobRef: "job-1",
      });
    }

    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 7, method: DELEGATED_WORKFLOWS_METHOD, params: { v: 1, op: "runs" } },
      // A grant naming the extension's OWN workflow — the most generous
      // grant that could possibly see the delegated run, and it still
      // cannot: `readRuns` namespaces every granted name under this
      // extension, and the delegated workflow is not one of its assets.
      ctx({ userId: ownerUserId, grantedPermissions: granted({ names: ["own"] }) }),
    );

    const names = (resp.result as { runs: Array<{ workflowName: string }> }).runs
      .map((r) => r.workflowName);
    expect(names).toEqual([`${EXT_NAME}:own`]);
    expect(names).not.toContain("org-nightly");
  });

  test("a forged ref from the SDK matches zero rows — DELEGATION_NOT_FOUND, nothing started", async () => {
    // The client-side half of §4: the SDK gives an author no way to name a
    // principal, so the most they can do is guess a ref. A guess is not a
    // weaker authorization, it is no row.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
    });
    const { spy } = wireSdkToHost();

    const err = await refusal(new Workflows().runFor({ jobRef: "not-a-real-job" }));

    expect(err.data).toEqual({ reason: "DELEGATION_NOT_FOUND" });
    expect(started).toHaveLength(0);
    spy.mockRestore();
  });
});
