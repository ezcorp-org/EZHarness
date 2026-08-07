/**
 * C3 phase 6 — what happens when the `consent-stale` PARK cannot be
 * written.
 *
 * Its own file because the only honest way to reach this branch is to
 * make the run-row write fail, and `mock.module` on
 * `db/queries/workflow-runs` would break every other test in the ladder
 * suite, which needs those writes for real.
 *
 * ## The property, and why it is not obvious
 *
 * D6 refuses by SUSPENDING rather than failing — a hard refusal trains
 * authors to disable the check. But the suspension is two database
 * writes, and either can fail. The wrong answer is to let the fire
 * proceed when the park could not be recorded: that would execute the
 * workflow under a consent the human has NOT given, which is the one
 * outcome the rung exists to prevent. So the refusal stands on its own
 * and the failure is reported rather than swallowed — `parked: false`
 * says the run row is not there to link to.
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

/** The seam. `insertWorkflowRun` is what the park calls first. */
let insertThrows = false;
mock.module("../../db/queries/workflow-runs", () => ({
  async insertWorkflowRun() {
    if (insertThrows) throw new Error("disk is on fire");
  },
  async suspendWorkflowRun() {
    return 1;
  },
}));

mockDbConnection();

const {
  handleWorkflowsRpc,
  DELEGATED_OP,
  DELEGATED_WORKFLOWS_METHOD,
  _resetWorkflowTriggerQuotaForTests,
  _resetWorkflowRateLimitForTests,
} = await import("../workflows-handler");
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import(
  "../../runtime/workflow/runtime-registry"
);
const { createUser } = await import("../../db/queries/users");
const { createWorkflowDelegation } = await import("../../db/queries/workflow-delegations");
const { extensions, sdkCapabilityCalls, auditLog } = await import("../../db/schema");

import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../types";
import type { WorkflowDefinition, WorkflowRun } from "../../types";
import type { CachedWorkflow } from "../../runtime/workflow-scope";

const EXT_NAME = "park-fail-ext";
let ownerUserId: string;
let extensionId: string;

/** Reaches a TOOL, deliberately. D6's gate is the WIDENING test, so a
 *  graph whose capability closure is empty cannot be made stale at all —
 *  a delegation consented to nothing and reaching nothing has not widened,
 *  whatever its stored digest says. This one reaches a capability that
 *  {@link staleDelegation} then withholds. */
const WF: WorkflowDefinition = {
  name: "nightly",
  description: "",
  steps: [{ name: "call", kind: "tool", tool: "ext__do_thing", input: {} }],
};

let entry: CachedWorkflow;
let started = 0;

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

function granted(): ExtensionPermissions {
  return {
    grantedAt: { workflows: Date.now() },
    workflows: { names: [], maxRunsPerHour: 20, allowDelegated: true },
  };
}

function ctx() {
  return {
    extensionName: EXT_NAME,
    extensionId,
    userId: null,
    conversationId: null,
    grantedPermissions: granted(),
    manifest: manifest(),
  } as never;
}

function req(): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: DELEGATED_WORKFLOWS_METHOD,
    params: { v: 1, op: DELEGATED_OP, jobRef: "job-1" },
  };
}

beforeAll(async () => {
  await setupTestDb();
  const owner = await createUser({
    email: "park@c3.test", passwordHash: "h", name: "Owner",
    role: "member", status: "active",
  });
  ownerUserId = owner.id;
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "0.0.1", description: "",
    manifest: manifest() as never,
    source: "test", enabled: true, grantedPermissions: granted() as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
  entry = {
    definition: WF,
    source: "db",
    id: "def-nightly",
    projectId: null,
    userId: ownerUserId,
    visibility: "system",
    forkedFrom: null,
  } as unknown as CachedWorkflow;
});

beforeEach(async () => {
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(auditLog);
  started = 0;
  insertThrows = false;
  _resetWorkflowTriggerQuotaForTests();
  _resetWorkflowRateLimitForTests(extensionId);
  _resetWorkflowRuntimeForTests();
  registerWorkflowRuntime({
    workflowExecutor: {
      async resumeWorkflow() {
        throw new Error("not exercised");
      },
      async runWorkflow(workflow) {
        started++;
        return {
          id: "run-1", workflowName: workflow.name, status: "success",
          startedAt: Date.now(), steps: [],
        } satisfies WorkflowRun;
      },
    },
    getWorkflows: () => [WF],
    getCachedWorkflows: () => [entry],
    listAgents: () => [],
  });
});

afterAll(async () => {
  restoreModuleMocks();
  _resetWorkflowRuntimeForTests();
  await closeTestDb();
});

/** A live delegation consented to an EMPTY capability set over a graph
 *  that reaches a tool — a genuine widening, which is what D6 parks on
 *  now. (A merely-different digest carries consent forward instead, so a
 *  fixture that only broke the hash would never reach the park at all.) */
async function staleDelegation(): Promise<string> {
  const created = await createWorkflowDelegation({
    extensionId,
    jobRef: "job-1",
    ownerKind: "user",
    ownerId: ownerUserId,
    workflowName: WF.name,
    definitionVersionId: null,
    projectId: null,
    triggerKind: "cron",
    triggerSpec: null,
    consentHash: "a-hash-from-a-graph-that-no-longer-exists",
    definitionHash: "a-graph-that-no-longer-exists",
    capabilitySet: [],
    maxTokensPerRun: 10_000,
    maxRunsPerDay: 10,
    consentedByUserId: ownerUserId,
  });
  if (!created.ok) throw new Error(`fixture: ${created.message}`);
  return created.delegation.id;
}

describe("D6 — when the park itself cannot be written", () => {
  test("the fire is STILL refused, and the response says the run is not there", async () => {
    await staleDelegation();
    insertThrows = true;

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toEqual({ reason: "DELEGATION_CONSENT_STALE" });
    expect(resp.error?.message).toContain("consent again");
    // The load-bearing half: nothing executed. Proceeding on a failed
    // park would run the workflow under a consent the human has not
    // given, which is exactly what this rung exists to prevent.
    expect(started).toBe(0);
  });

  test("…and when the park DOES land, the response links the parked run", async () => {
    // The pair. Without it "it refuses" is satisfied by a rung that
    // refuses unconditionally, and the `parked` flag would be
    // meaningless.
    await staleDelegation();
    insertThrows = false;

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "DELEGATION_CONSENT_STALE" });
    expect(
      (resp.error?.data as { workflowRunId?: string } | undefined)?.workflowRunId,
      "a successful park names its run so a console can link to it",
    ).toBeTruthy();
    expect(started).toBe(0);
  });

  test("the failed park still audits, with `parked: false` on the row", async () => {
    await staleDelegation();
    insertThrows = true;

    await handleWorkflowsRpc(req(), ctx());

    const rows = await getTestDb()
      .select({
        errorCode: sdkCapabilityCalls.errorCode,
        onBehalfOf: sdkCapabilityCalls.onBehalfOf,
        after: sdkCapabilityCalls.after,
      })
      .from(sdkCapabilityCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      errorCode: "DELEGATION_CONSENT_STALE",
      onBehalfOf: ownerUserId,
    });
    expect((rows[0]?.after as { parked?: boolean })?.parked).toBe(false);
  });
});
