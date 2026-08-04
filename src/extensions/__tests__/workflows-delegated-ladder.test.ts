/**
 * C3 phase 6 — `op: "runFor"`, the D1–D9 ladder.
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
import { test, expect, describe, beforeAll, beforeEach, afterAll, mock } from "bun:test";
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
  type WorkflowsHandlerContext,
} from "../workflows-handler";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../../runtime/workflow/runtime-registry";
import { createUser } from "../../db/queries/users";
import { createServiceAccount } from "../../db/queries/service-accounts";
import { createWorkflowDelegation } from "../../db/queries/workflow-delegations";
import { computeDelegationConsentRecord } from "../../runtime/workflow-delegation-record";
import { delegationPrincipal } from "../../runtime/workflow-delegation-consent";
import {
  extensions, projects, sdkCapabilityCalls, auditLog, users,
  serviceAccounts, workflowDelegations, workflowRuns, messages, errorLogs,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../types";
import type { AgentDefinition, WorkflowDefinition, WorkflowRun } from "../../types";
import { systemCachedWorkflow, type CachedWorkflow } from "../../runtime/workflow-scope";

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
  /** Overrides the correctly-computed hash, to drive D6. */
  consentHash?: string;
  consentedByUserId?: string;
}

/** Write a delegation whose `consent_hash` is the value THIS build would
 *  recompute at fire time, so D6 passes unless a test deliberately breaks
 *  it. Computed through the same shared assembly the handler uses — a
 *  fixture that hard-coded a digest would pass while the two drifted. */
async function delegate(spec: DelegationSpec): Promise<string> {
  const entry = cachedEntries.find((e) => e.definition.name === spec.workflowName);
  let consentHash = spec.consentHash;
  if (consentHash === undefined) {
    const record = await computeDelegationConsentRecord({
      entry: entry!,
      extensionName: EXT_NAME,
      workflowName: spec.workflowName,
      projectId: spec.projectId ?? null,
      runAs: { kind: spec.ownerKind, id: spec.ownerId },
      trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
      principal: delegationPrincipal(spec.ownerKind, spec.ownerId),
      entries: cachedEntries,
      agents,
    });
    consentHash = record.consentHash;
  }
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
    consentHash,
    capabilitySet: [],
    maxTokensPerRun: spec.maxTokensPerRun ?? 10_000,
    maxRunsPerDay: spec.maxRunsPerDay ?? 10,
    consentedByUserId: spec.consentedByUserId ?? ownerUserId,
  });
  if (!created.ok) throw new Error(`fixture could not consent: ${created.message}`);
  return created.delegation.id;
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
  await getTestDb().delete(workflowRuns);
  await getTestDb().delete(workflowDelegations);
  _resetWorkflowTriggerQuotaForTests();
  _resetWorkflowRateLimitForTests(extensionId);
  _resetWorkflowRuntimeForTests();
  started = [];
  runStatus = "success";
  runWorkflowThrows = false;
  cachedEntries = [
    dbEntry(SYSTEM_WF, "system", ownerUserId),
    dbEntry(PROJECT_WF, "project", ownerUserId),
    dbEntry(PRIVATE_WF, "private", adminUserId),
    dbEntry(DEAD_EXT_WF, "system", null),
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

describe("rung D6 — DELEGATION_CONSENT_STALE PARKS the run", () => {
  test("a stale hash writes a suspended run instead of executing", async () => {
    const id = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
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
    expect((resp.error?.data as { workflowRunId: string }).workflowRunId).toBe(runs[0]!.id);
  });

  test("no `workflow_approvals` row is written — answering one would not resume it", async () => {
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly",
      consentHash: "stale",
    });

    await handleWorkflowsRpc(req(), ctx());

    const { workflowApprovals } = await import("../../db/schema");
    const approvals = await getTestDb().select().from(workflowApprovals);
    expect(approvals).toHaveLength(0);
  });

  test("a SERVICE park routes its audit row to audit_log and owns no user", async () => {
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
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

  test("editing the workflow AFTER consent stales it — the hash is over live state", async () => {
    // Consent against the current graph…
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });
    // …then change a step's `when` guard, which changes REACHABILITY and
    // no capability declaration at all.
    cachedEntries = [
      dbEntry(
        {
          ...SYSTEM_WF,
          steps: [
            {
              name: "t",
              kind: "transform",
              output: { a: "b" },
              when: { ref: "$input.go", op: "truthy" },
            },
          ],
        },
        "system",
        ownerUserId,
      ),
      ...cachedEntries.slice(1),
    ];

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
  });

  test("…and an UNCHANGED graph passes D6 and runs", async () => {
    await delegate({ ownerKind: "user", ownerId: ownerUserId, workflowName: "org-nightly" });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(await getTestDb().select().from(workflowRuns)).toHaveLength(0);
  });

  test("the hash is the OWNER KIND's: the same graph consented as a user is stale for a service", async () => {
    // Two delegations over the same nested graph. The `service` principal
    // cannot resolve the project-visible child, so it walks a smaller
    // graph and MUST hash differently — hashing the flat cache would
    // certify a step the run would refuse.
    const parent: WorkflowDefinition = {
      name: "org-nightly",
      description: "",
      steps: [{ name: "n", kind: "workflow", workflow: "team-fork", input: {} }],
    };
    cachedEntries = [
      dbEntry(parent, "system", ownerUserId),
      dbEntry(PROJECT_WF, "project", ownerUserId),
    ];
    // Consent as a USER (sees the child) …
    const userHash = (
      await computeDelegationConsentRecord({
        entry: cachedEntries[0]!,
        extensionName: EXT_NAME,
        workflowName: "org-nightly",
        projectId: null,
        runAs: { kind: "user", id: ownerUserId },
        trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
        principal: delegationPrincipal("user", ownerUserId),
        entries: cachedEntries,
        agents,
      })
    ).consentHash;
    // … and store it on a SERVICE delegation, which does not.
    await delegate({
      ownerKind: "service", ownerId: serviceAccountId, workflowName: "org-nightly",
      consentHash: userHash,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
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
      // arrives on the fire-and-forget promise.
      for (let t = 0; t < 20; t++) await new Promise((r) => setTimeout(r, 0));
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
    for (let t = 0; t < 20; t++) await new Promise((r) => setTimeout(r, 0));

    const [row] = await getTestDb().select().from(workflowDelegations)
      .where(eq(workflowDelegations.id, id));
    expect(row?.consecutiveFailures).toBe(0);
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
    for (let t = 0; t < 20; t++) await new Promise((r) => setTimeout(r, 0));

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
    // bucket refills on wall-clock time (50/s), so the drain is a bounded
    // loop rather than exactly 50 calls; the bound is what makes a broken
    // limiter fail rather than hang.
    const wide = ctx({ grantedPermissions: granted({ maxRunsPerHour: 5000 }) });
    let drained = false;
    for (let i = 0; i < 400 && !drained; i++) {
      const r = await handleWorkflowsRpc(req(), wide);
      drained = (r.error?.data as { reason?: string } | undefined)?.reason
        === "WORKFLOWS_RATE_LIMITED";
    }
    expect(drained).toBe(true);

    // THE point of the test: a plain `run` on the SAME extension is now
    // refused too. A delegated fire that carried its own bucket would
    // double the extension's burst budget, and this is what would notice.
    const shared = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 9, method: "ezcorp/workflows", params: { v: 1, workflow: "own" } },
      ctx({
        userId: ownerUserId,
        grantedPermissions: granted({ names: ["own"], maxRunsPerHour: 5000 }),
        manifest: {
          ...manifest(),
          permissions: { workflows: { names: ["own"], maxRunsPerHour: 5000 } },
        } as unknown as ExtensionManifestV2,
      }),
    );

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

describe("the ordinary `run` op is untouched by any of this", () => {
  test("a `system` cache entry still reconstructs when getCachedWorkflows is absent", async () => {
    // Rung 12b's `cachedEntryFor` fallback is DELIBERATELY weaker than
    // D7's refusal, and this pins that the two paths kept their separate
    // behaviours — the trap in this phase was inheriting the fallback.
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

    expect(resp.error).toBeUndefined();
    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:own`);
  });
});
