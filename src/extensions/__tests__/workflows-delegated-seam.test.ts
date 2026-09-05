/**
 * C3 Phase 0b — the DELEGATED workflow provenance seam.
 *
 * A cron / webhook fire is OWNERLESS by construction
 * (`event-subscription-dispatcher.ts` stamps `ownerless: true` when owner
 * resolution finds nobody). `resolveReverseRpcMeta` refuses every ownerless
 * fire at rung 0 — BEFORE `handlePiWorkflows` builds a handler context — so
 * a background trigger asking to run a workflow never reaches a single rung
 * of `workflows-handler.ts`'s authorization ladder.
 *
 * This suite pins the seam that unblocks that, and pins that it unblocked
 * NOTHING ELSE:
 *
 *   1. `resolveDelegatedProvenance` passes an ownerless fire through with
 *      `onBehalfOf: null`, and still fail-fasts an UNRESOLVED token.
 *   2. `resolveReverseRpcMeta` is UNCHANGED — the same ownerless token it
 *      refused before still gets a byte-identical `-32106`.
 *   3. A delegated call REACHES the ladder — proved by the `audit_log` row
 *      that only rung 7 writes and rung 0 never did.
 *   4. It is still REFUSED there. No delegation model exists yet, so the
 *      seam is a door frame with the door shut.
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
  handlePiWorkflows,
  handlePiWorkflowsDelegated,
  type RpcHandlerDeps,
} from "../tool-executor/rpc-handlers";
import {
  resolveDelegatedProvenance,
  resolveReverseRpcMeta,
} from "../tool-executor/provenance";
import {
  registerCallProvenance,
  _resetCallProvenanceForTests,
  type CallProvenance,
} from "../call-provenance";
import {
  _resetWorkflowTriggerQuotaForTests,
  _resetWorkflowRateLimitForTests,
} from "../workflows-handler";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../../runtime/workflow/runtime-registry";
import { createStubPermissionEngine } from "../../__tests__/helpers/permission-engine-stub";
import { createUser } from "../../db/queries/users";
import { addConversationExtensions } from "../../db/queries/conversation-extensions";
import {
  extensions, conversations, projects, conversationExtensions,
  sdkCapabilityCalls, messages, errorLogs, auditLog,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type { ExtensionRegistry } from "../registry";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../types";
import type { WorkflowDefinition, WorkflowRun } from "../../types";

const EXT_NAME = "wf-delegated-ext";

let userId: string;
let extensionId: string;
let projectId: string;
let conversationId: string;
let started: Array<{ workflow: WorkflowDefinition; userId?: string }>;

const SHIPPED: WorkflowDefinition = {
  name: `${EXT_NAME}:deploy`,
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};

function manifest(names: string[] = ["deploy"]): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: EXT_NAME,
    version: "0.0.1",
    description: "",
    author: { name: "t" },
    permissions: { workflows: { names, maxRunsPerHour: 20 } },
  } as unknown as ExtensionManifestV2;
}

function granted(): ExtensionPermissions {
  return {
    grantedAt: { workflows: Date.now() },
    workflows: { names: ["deploy"], maxRunsPerHour: 20 },
  };
}

/** A registry whose grant/manifest are whatever the test asks for. */
function stubRegistry(perms: ExtensionPermissions = granted()): ExtensionRegistry {
  return {
    getGrantedPermissions: () => perms,
    getManifest: () => manifest(),
    getInstallPath: () => "/tmp/ext",
    getRegisteredTool: () => null,
  } as unknown as ExtensionRegistry;
}

function deps(perms?: ExtensionPermissions): RpcHandlerDeps {
  return {
    registry: stubRegistry(perms),
    engine: createStubPermissionEngine("allow-all"),
    resolveExtensionScopeGrant: async () => true,
  } as unknown as RpcHandlerDeps;
}

function registerRuntime() {
  registerWorkflowRuntime({
    workflowExecutor: {
      async runWorkflow(workflow, _input, _proj, uid) {
        started.push({ workflow, ...(uid !== undefined ? { userId: uid } : {}) });
        const run: WorkflowRun = {
          id: "run-d1",
          workflowName: workflow.name,
          status: "success",
          startedAt: Date.now(),
          steps: [],
        };
        return run;
      },
      // Required by the registry since C4. A delegated fire only ever
      // STARTS a run; resuming a parked one is the approval path, which
      // never routes through this seam.
      resumeWorkflow: (async () => {
        throw new Error("resumeWorkflow must NEVER be called from a delegated fire");
      }) as never,
    },
    getWorkflows: () => [SHIPPED],
  });
}

/** Mint a host-issued token for an OWNERLESS fire — exactly the shape
 *  `event-subscription-dispatcher` registers for a cron/webhook. */
function ownerlessToken(): string {
  const prov: CallProvenance = {
    onBehalfOf: null,
    conversationId: null,
    runId: null,
    parentCallId: null,
    actorExtensionId: extensionId,
    kind: "event",
    ownerless: true,
  };
  return registerCallProvenance(prov);
}

/** Mint a host-issued token for an ordinary OWNED chat-turn call. */
function ownedToken(conv: string | null = null): string {
  const prov: CallProvenance = {
    onBehalfOf: userId,
    conversationId: conv,
    runId: null,
    parentCallId: null,
    actorExtensionId: extensionId,
    kind: "tool",
    ownerless: false,
  };
  return registerCallProvenance(prov);
}

function req(method: string, ezCallId: string | undefined): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      v: 1,
      workflow: "deploy",
      ...(ezCallId ? { _meta: { ezCallId } } : {}),
    },
  };
}

async function noOwnerAuditRows() {
  return getTestDb().select().from(auditLog)
    .where(eq(auditLog.action, "ext:workflow-trigger-no-owner"));
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "wf-deleg@example.com", passwordHash: "h", name: "U",
    role: "admin", status: "active",
  });
  userId = u.id;
  const [row] = await getTestDb().insert(extensions).values({
    name: EXT_NAME, version: "0.0.1", description: "",
    manifest: manifest() as never,
    source: "test", enabled: true, grantedPermissions: granted() as never,
  }).returning({ id: extensions.id });
  extensionId = row!.id;
  const [proj] = await getTestDb().insert(projects)
    .values({ name: "wf-d-proj", path: "/tmp/wfd" }).returning({ id: projects.id });
  projectId = proj!.id;
  const [conv] = await getTestDb().insert(conversations)
    .values({ projectId, userId, title: "t", kind: "regular" })
    .returning({ id: conversations.id });
  conversationId = conv!.id;
});

beforeEach(async () => {
  await getTestDb().delete(messages);
  await getTestDb().delete(sdkCapabilityCalls);
  await getTestDb().delete(errorLogs);
  await getTestDb().delete(auditLog);
  await getTestDb().delete(conversationExtensions);
  await addConversationExtensions(conversationId, [{ extensionId }]);
  _resetCallProvenanceForTests();
  _resetWorkflowTriggerQuotaForTests();
  _resetWorkflowRateLimitForTests(extensionId);
  _resetWorkflowRuntimeForTests();
  started = [];
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
  registerRuntime();
});

afterAll(async () => {
  restoreModuleMocks();
  _resetWorkflowRuntimeForTests();
  _resetCallProvenanceForTests();
  await closeTestDb();
});

// ── 1. The resolver itself ─────────────────────────────────────────────

describe("resolveDelegatedProvenance", () => {
  test("passes an OWNERLESS fire through with onBehalfOf: null", () => {
    const id = ownerlessToken();
    const out = resolveDelegatedProvenance(extensionId, req("ezcorp/workflows-delegated", id));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.onBehalfOf).toBeNull();
    expect(out.conversationId).toBeNull();
  });

  test("carries the OWNER through when the fire has one", () => {
    const id = ownedToken(conversationId);
    const out = resolveDelegatedProvenance(extensionId, req("ezcorp/workflows-delegated", id));

    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected ok");
    expect(out.onBehalfOf).toBe(userId);
    expect(out.conversationId).toBe(conversationId);
  });

  test("an UNRESOLVED token still fail-fasts with -32602", () => {
    const out = resolveDelegatedProvenance(
      extensionId,
      req("ezcorp/workflows-delegated", "bogus-token"),
    );

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.errorResponse.error?.code).toBe(-32602);
  });

  test("a MISSING token fail-fasts too — tolerance is about owners, not tokens", () => {
    const out = resolveDelegatedProvenance(
      extensionId,
      req("ezcorp/workflows-delegated", undefined),
    );

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    expect(out.errorResponse.error?.code).toBe(-32602);
  });

  test("a token minted for another extension cannot delegate capabilities", () => {
    // Parity with `resolveStorageProvenance`/`resolveReverseRpcMeta`: the
    // actorExtensionId mismatch is observability, not a gate, because the
    // cross-extension `ezcorp/invoke` correspondence is subtle.
    const id = ownedToken(null);
    const out = resolveDelegatedProvenance("a-different-extension", req("x", id));

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("foreign token accepted");
    expect(out.errorResponse.error?.code).toBe(-32602);
  });
});

// ── 2. The existing strict path is untouched ───────────────────────────

describe("resolveReverseRpcMeta is NOT loosened", () => {
  test("the same ownerless token still gets a byte-identical -32106", () => {
    const id = ownerlessToken();
    const request = req("ezcorp/workflows", id);
    const out = resolveReverseRpcMeta(extensionId, request);

    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected refusal");
    // Byte-identical: the WHOLE response object, not just the code.
    expect(out.errorResponse).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32106,
        message: "No owner scope for this background fire — capability unavailable",
      },
    });
  });

  test("`ezcorp/workflows` refuses an ownerless fire BEFORE the ladder — no audit row", async () => {
    // This is the rung-0 refusal: it writes nothing anywhere. It is the
    // control the delegated method must not disturb, and the contrast that
    // makes the next describe's audit row meaningful.
    const id = ownerlessToken();
    const resp = await handlePiWorkflows(deps(), extensionId, req("ezcorp/workflows", id));

    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.message).toBe(
      "No owner scope for this background fire — capability unavailable",
    );
    expect(await noOwnerAuditRows()).toHaveLength(0);
    expect(await getTestDb().select().from(sdkCapabilityCalls)).toHaveLength(0);
    expect(started).toHaveLength(0);
  });
});

// ── 3. The delegated method reaches the ladder — and is refused there ──

describe("ezcorp/workflows-delegated", () => {
  test("an ownerless fire REACHES the handler — proved by rung 7's audit row", async () => {
    const id = ownerlessToken();
    const resp = await handlePiWorkflowsDelegated(
      deps(),
      extensionId,
      req("ezcorp/workflows-delegated", id),
    );

    // Same refusal code as rung 0 — but arrived at from INSIDE the ladder.
    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NO_OWNER" });

    // The discriminator. Rung 0 writes nothing; rung 7 writes exactly this.
    const rows = await noOwnerAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.target).toBe(extensionId);
    expect(rows[0]?.metadata).toMatchObject({ reason: "no-owner", newValue: "deploy" });

    // And it started nothing. The seam opens the ladder, not the door.
    expect(started).toHaveLength(0);
  });

  test("an UNRESOLVED token still fail-fasts -32602 — never reaches the ladder", async () => {
    const resp = await handlePiWorkflowsDelegated(
      deps(),
      extensionId,
      req("ezcorp/workflows-delegated", "bogus-token"),
    );

    expect(resp.error?.code).toBe(-32602);
    expect(await noOwnerAuditRows()).toHaveLength(0);
    expect(started).toHaveLength(0);
  });

  test("an OWNED delegated call runs the ladder to completion, exactly like ezcorp/workflows", async () => {
    const id = ownedToken(conversationId);
    const resp = await handlePiWorkflowsDelegated(
      deps(),
      extensionId,
      req("ezcorp/workflows-delegated", id),
    );

    expect(resp.error).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:deploy`);
    // Attributed to the token's owner — never the wire.
    expect(started[0]?.userId).toBe(userId);
  });

  test("an ownerless fire is still bound by the grant ladder — and the deny is AUDITED, not swallowed", async () => {
    // `sdk_capability_calls.on_behalf_of` is NOT NULL with an FK to users,
    // so an ownerless deny cannot be recorded there. Before the fallback it
    // was a swallowed insert and the rejection vanished entirely; now it
    // lands in `audit_log` alongside rung 7's.
    const id = ownerlessToken();
    const ungranted: ExtensionPermissions = { grantedAt: {} };
    const resp = await handlePiWorkflowsDelegated(
      deps(ungranted),
      extensionId,
      req("ezcorp/workflows-delegated", id),
    );

    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NOT_GRANTED" });
    expect(await getTestDb().select().from(sdkCapabilityCalls)).toHaveLength(0);
    const rows = await noOwnerAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ reason: "WORKFLOWS_NOT_GRANTED" });
    expect(started).toHaveLength(0);
  });

  test("an unknown extension is refused by the registry gate before provenance runs", async () => {
    const emptyRegistry = {
      getGrantedPermissions: () => undefined,
      getManifest: () => undefined,
    } as unknown as ExtensionRegistry;
    const resp: JsonRpcResponse = await handlePiWorkflowsDelegated(
      { ...deps(), registry: emptyRegistry },
      extensionId,
      req("ezcorp/workflows-delegated", ownerlessToken()),
    );

    expect(resp.error?.code).toBe(-32603);
    expect(await noOwnerAuditRows()).toHaveLength(0);
  });
});
