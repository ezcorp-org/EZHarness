/**
 * INVESTIGATION (branch `investigate/runfor-extension-workflows`).
 *
 * ## The one question this file answers
 *
 * Does `op: "runFor"` accept a `workflow_delegations` row whose
 * `workflow_name` names a workflow the CALLING EXTENSION ITSELF SHIPS
 * (`<extensionName>:<bare>`, a `*.workflow.yaml` at its install root)?
 *
 * The SDK header says `runFor()` "fires a workflow you do NOT ship"
 * (`packages/@ezcorp/sdk/src/runtime/workflows.ts`), and the handler's own
 * module doc repeats it. Both are PROSE about the intended use case. The
 * ladder in `runForDelegation` never asks the question: it reads
 * `row.workflowName` verbatim, resolves it through the SHARED read/run
 * ladder (`authorizeDelegationConsent` → `resolveWorkflowForCaller` →
 * `authorizeWorkflow`). Extension assets now carry private owner-bound
 * release provenance. Delegation must retain that authority rather than
 * treating a self-shipped workflow as a public system asset.
 *
 * These tests EXECUTE the path with an extension-shipped workflow so the
 * answer is behaviour rather than reading. The population deliberately
 * carries BOTH namespaces:
 *
 *   - `delegated-ext:etl-factory` — shipped by the CALLING extension. The
 *     `ez-factory` shape ("fire one of my own three workflows on cron").
 *   - `ghost-ext:deploy`         — shipped by an extension that is NOT
 *     installed, the control that proves the liveness rung is real and the
 *     accept above is not a blanket wave-through.
 *
 * Real PGlite and the real `migrate()`, for the same reason the sibling
 * ladder suite gives: the ladder's job is to read and write rows, and a
 * mocked query layer would prove it against a world that agrees with it.
 */
import {
  test, expect, describe, beforeAll, beforeEach, afterAll, mock,
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
  extensions, projects, projectMembers, sdkCapabilityCalls, auditLog,
  workflowDelegations, workflowRuns, workflowStepRuns, messages, errorLogs,
} from "../../db/schema";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../types";
import type { AgentDefinition, WorkflowDefinition, WorkflowRun } from "../../types";
import { systemCachedWorkflow, workflowDelegationReleaseBinding, type CachedWorkflow } from "../../runtime/workflow-scope";
import { workflowReleaseFixture } from "../../__tests__/helpers/workflow-release";

/** The calling extension. Stands in for `ez-factory`. */
const EXT_NAME = "delegated-ext";

let ownerUserId: string;
let adminUserId: string;
let serviceAccountId: string;
let extensionId: string;
let projectId: string;

let started: Array<{
  workflow: WorkflowDefinition;
  input: Record<string, unknown>;
  projectId?: string;
  userId?: string;
  opts?: Record<string, unknown>;
}>;

/** The extension's OWN shipped asset — exactly what `ez-factory` has three
 *  of. Namespaced by the host at load, so the name carries the calling
 *  extension's own prefix. */
const SELF_SHIPPED_WF: WorkflowDefinition = {
  name: `${EXT_NAME}:etl-factory`,
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};
/** A DB workflow, the shape the feature was written for. */
const FOREIGN_WF: WorkflowDefinition = {
  name: "org-nightly",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};
/** Shipped by an extension that is NOT installed — the control. */
const DEAD_EXT_WF: WorkflowDefinition = {
  name: "ghost-ext:deploy",
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};

let cachedEntries: CachedWorkflow[];
let agents: AgentDefinition[];

function registerRuntime(): void {
  registerWorkflowRuntime({
    workflowExecutor: {
      async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
      },
      runWorkflow(workflow, input, proj, uid, _signal, opts) {
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
          status: "success",
          startedAt: Date.now(),
          steps: [],
        } satisfies WorkflowRun);
      },
    },
    getWorkflows: () => cachedEntries.map((e) => e.definition),
    getCachedWorkflows: () => cachedEntries,
    listAgents: () => agents,
  });
}

function manifest(): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "0.0.1",
    description: "",
    author: { name: "t" },
    // `names: []` — the DELEGATED-ONLY grant. Note what this proves on its
    // own: the extension declares NO name at all, and still reaches its own
    // shipped workflow through the delegated verb.
    permissions: { workflows: { names: [], maxRunsPerHour: 20, allowDelegated: true } },
  } as unknown as ExtensionManifestV2;
}

function granted(): ExtensionPermissions {
  return {
    grantedAt: { workflows: Date.now() },
    workflows: { names: [], maxRunsPerHour: 20, allowDelegated: true },
  };
}

/** The delegated caller is OWNERLESS — a cron tick, which is the whole
 *  `ez-factory` scenario. */
function ctx(): WorkflowsHandlerContext {
  return {
    extensionName: EXT_NAME,
    extensionId,
    userId: null,
    conversationId: null,
    grantedPermissions: granted(),
    manifest: manifest(),
  };
}

function req(jobRef = "job-1"): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: DELEGATED_WORKFLOWS_METHOD,
    params: { v: 1, op: DELEGATED_OP, jobRef },
  };
}

/** Write a consent whose `consent_hash` is the value THIS build recomputes
 *  at fire time, through the same shared assembly the handler uses — so D6
 *  passes unless the workflow itself is unreachable to the principal. */
async function delegate(spec: {
  ownerKind: "user" | "service";
  ownerId: string;
  workflowName: string;
  jobRef?: string;
  projectId?: string | null;
}): Promise<string> {
  const entry = cachedEntries.find((e) => e.definition.name === spec.workflowName);
  const record = await computeDelegationConsentRecord({
    entry: entry!,
    extensionName: EXT_NAME,
    workflowName: spec.workflowName,
    projectId: spec.projectId ?? null,
    runAs: { kind: spec.ownerKind, id: spec.ownerId },
    // A CRON trigger — the unattended fire `ez-factory` wants.
    trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
    principal: delegationPrincipal(spec.ownerKind, spec.ownerId),
    entries: cachedEntries,
    agents,
  });
  const created = await createWorkflowDelegation({
    extensionId,
    jobRef: spec.jobRef ?? "job-1",
    ownerKind: spec.ownerKind,
    ownerId: spec.ownerId,
    workflowName: spec.workflowName,
    // NULL — an extension-shipped workflow has no `workflow_definitions`
    // row to version, which is the documented unversioned path
    // (`resolveDelegationVersionPin`).
    definitionVersionId: null,
    extensionReleaseBinding: entry ? workflowDelegationReleaseBinding(entry) : null,
    projectId: spec.projectId ?? null,
    triggerKind: "cron",
    triggerSpec: { expr: "0 3 * * *" },
    consentHash: record.consentHash,
    definitionHash: record.definitionHash,
    capabilitySet: record.capabilitySet,
    maxTokensPerRun: 10_000,
    maxRunsPerDay: 10,
    consentedByUserId: ownerUserId,
  });
  if (!created.ok) throw new Error(`fixture could not consent: ${created.message}`);
  return created.delegation.id;
}

beforeAll(async () => {
  await setupTestDb();
  const owner = await createUser({
    email: "selfship-owner@example.com", passwordHash: "h", name: "Owner",
    role: "member", status: "active",
  });
  ownerUserId = owner.id;
  const admin = await createUser({
    email: "selfship-admin@example.com", passwordHash: "h", name: "Admin",
    role: "admin", status: "active",
  });
  adminUserId = admin.id;
  // The CALLING extension, installed and ENABLED — which is what the
  // liveness rung reads for a `delegated-ext:`-namespaced name.
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "0.0.1", description: "",
    manifest: manifest() as never,
    source: "test", enabled: true, grantedPermissions: granted() as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
  const [proj] = await getTestDb().insert(projects)
    .values({ name: "selfship-proj", path: "/tmp/selfship" }).returning({ id: projects.id });
  projectId = proj!.id;
  await getTestDb().insert(projectMembers).values({ projectId, userId: ownerUserId, role: "owner" });
  const account = await createServiceAccount({
    name: "selfship-runner",
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
  cachedEntries = [
    workflowReleaseFixture(SELF_SHIPPED_WF, ownerUserId, extensionId).entry,
    systemCachedWorkflow(DEAD_EXT_WF, "extension"),
    {
      definition: FOREIGN_WF, source: "db", id: "def-org-nightly",
      projectId: null, userId: ownerUserId, visibility: "system", forkedFrom: null,
    } as CachedWorkflow,
  ];
  agents = [];
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
  delete process.env.EZCORP_DISABLE_DELEGATED_WORKFLOWS;
  registerRuntime();
});

afterAll(async () => {
  restoreModuleMocks();
  _resetWorkflowRuntimeForTests();
  await closeTestDb();
});

describe("THE QUESTION — runFor against a workflow the caller itself ships", () => {
  test("a user-kind delegation on the extension's OWN shipped workflow FIRES on a cron trigger", async () => {
    const delegationId = await delegate({
      ownerKind: "user",
      ownerId: ownerUserId,
      workflowName: SELF_SHIPPED_WF.name,
      projectId,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    // The decisive assertion. No rung of D1–D10 asks whether the name's
    // namespace is the caller's own.
    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      v: 1,
      workflow: `${EXT_NAME}:etl-factory`,
      runAs: "user",
      started: true,
    });
    expect(started).toHaveLength(1);
    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:etl-factory`);
    // The OWNER scopes the run, not the caller — the caller is ownerless.
    expect(started[0]?.userId).toBe(ownerUserId);
    expect(started[0]?.projectId).toBe(projectId);
    expect(started[0]?.opts).toEqual({
      jobRef: "job-1",
      delegationId,
      runAsKind: "user",
      runAs: ownerUserId,
    });
  });

  test("…and it is NOT an artefact of holding a per-name grant: `names` is empty", async () => {
    // The `run` op is refused for the SAME workflow at rung 4/5 (nothing
    // declared, nothing granted), which is what makes the accept above a
    // property of the DELEGATED ladder rather than of the grant.
    await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: SELF_SHIPPED_WF.name,
    });

    const viaRun = await handleWorkflowsRpc(
      {
        jsonrpc: "2.0", id: 2, method: "ezcorp/workflows",
        params: { v: 1, workflow: "etl-factory" },
      },
      ctx(),
    );

    expect(viaRun.error?.code).toBe(-32001);
    expect(viaRun.error?.data).toMatchObject({ reason: "WORKFLOW_NOT_DECLARED" });
    expect(started).toHaveLength(0);
  });

  test("a SERVICE-kind delegation on the extension's own shipped workflow also fires", async () => {
    await delegate({
      ownerKind: "service",
      ownerId: serviceAccountId,
      workflowName: SELF_SHIPPED_WF.name,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect((resp.result as { runAs: string }).runAs).toBe("service");
    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:etl-factory`);
    // No session to stream to — the documented service-account trade.
    expect(started[0]?.userId).toBeUndefined();
    expect(started[0]?.opts).toMatchObject({
      runAsKind: "service", runAs: serviceAccountId,
    });
  });

  test("the CONTROL — a workflow shipped by an extension that is NOT installed is refused, and the row is DISABLED", async () => {
    // Proves the accepts above are the liveness rung passing rather than
    // the ladder never looking at the namespace at all.
    const delegationId = await delegate({
      ownerKind: "user", ownerId: ownerUserId, workflowName: DEAD_EXT_WF.name,
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({
      reason: "DELEGATION_OWNER_LOST_WORKFLOW_ACCESS",
    });
    expect(started).toHaveLength(0);
    const [row] = await getTestDb()
      .select({ enabled: workflowDelegations.enabled })
      .from(workflowDelegations);
    expect(row?.enabled).toBe(false);
    expect(delegationId).toBeTruthy();
  });

  test("the version pin for an extension asset resolves to NULL, not a divergence refusal", async () => {
    // Item 4's `definition_version_id` claim, executed. An extension
    // workflow has no `workflow_definitions` row, so
    // `latestWorkflowVersionFor` finds nothing and
    // `resolveDelegationVersionPin` returns the documented unversioned
    // path — NOT `DELEGATION_VERSION_DIVERGENCE`, which would make the
    // consent route answer 409 and the row unmintable.
    const record = await computeDelegationConsentRecord({
      entry: cachedEntries.find((e) => e.definition.name === SELF_SHIPPED_WF.name)!,
      extensionName: EXT_NAME,
      workflowName: SELF_SHIPPED_WF.name,
      projectId: null,
      runAs: { kind: "user", id: ownerUserId },
      trigger: { kind: "cron", spec: { expr: "0 3 * * *" } },
      principal: delegationPrincipal("user", ownerUserId),
      entries: cachedEntries,
      agents,
    });
    expect(record.pin).toEqual({ ok: true, definitionVersionId: null });
    expect(record.consentHash).toMatch(/^[0-9a-f]{16,}$/);
  });

  test("the consent-time policy agrees — the SAME shared function admits the self-shipped name", async () => {
    // `authorizeDelegationConsent` is the one policy both the consent route
    // and rung D7 ask, so the route would mint this row too. If consent
    // refused what the fire admits (or the reverse) the feature would be
    // unusable in one direction; it does neither.
    const { authorizeDelegationConsent } = await import(
      "../../runtime/workflow-delegation-consent"
    );
    const asUser = authorizeDelegationConsent(
      cachedEntries, SELF_SHIPPED_WF.name, "user", ownerUserId,
    );
    const unboundService = authorizeDelegationConsent(
      cachedEntries, SELF_SHIPPED_WF.name, "service", serviceAccountId,
    );
    const asService = authorizeDelegationConsent(
      cachedEntries, SELF_SHIPPED_WF.name, "service", serviceAccountId,
      workflowDelegationReleaseBinding(cachedEntries.find(entry => entry.definition.name === SELF_SHIPPED_WF.name)!),
    );
    expect(asUser.ok).toBe(true);
    expect(unboundService.ok).toBe(false);
    expect(asService.ok).toBe(true);
  });
});
