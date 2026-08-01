/**
 * `ezcorp/workflows` reverse-RPC handler (W2) — the enforcement ladder.
 *
 * Runs against the real PGlite harness so the wiring gate, the projectId
 * derivation and the `sdk_capability_calls` audit trail are exercised for
 * real rather than stubbed. Every rung has a failing-path test with a typed
 * `reason`, and every path asserts an audit row was written — accepts AND
 * rejects.
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
  _resetWorkflowTriggerQuotaForTests,
  _resetWorkflowRateLimitForTests,
  MAX_WORKFLOW_INPUT_BYTES,
  type WorkflowsHandlerContext,
} from "../workflows-handler";
import {
  registerWorkflowRuntime,
  _resetWorkflowRuntimeForTests,
} from "../../runtime/workflow/runtime-registry";
import { createUser } from "../../db/queries/users";
import { addConversationExtensions } from "../../db/queries/conversation-extensions";
import {
  extensions, conversations, projects, conversationExtensions,
  sdkCapabilityCalls, messages, errorLogs, auditLog,
  workflowApprovals, workflowRuns,
} from "../../db/schema";
import { eq } from "drizzle-orm";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  JsonRpcRequest,
} from "../types";
import type { WorkflowDefinition, WorkflowRun } from "../../types";

let userId: string;
let extensionId: string;
let projectId: string;
let conversationId: string;

const EXT_NAME = "wf-trigger-ext";

/** Every run the fake executor was asked to start. */
let started: Array<{
  workflow: WorkflowDefinition;
  input: Record<string, unknown>;
  projectId?: string;
  userId?: string;
}>;

const SHIPPED: WorkflowDefinition = {
  name: `${EXT_NAME}:deploy`,
  description: "",
  steps: [{ name: "t", kind: "transform", output: { a: "b" } }],
};

/** A host workflow with the SAME bare name — the shadowing target. */
const HOST_WORKFLOW: WorkflowDefinition = {
  name: "deploy",
  description: "host",
  steps: [{ name: "t", kind: "transform", output: { host: "yes" } }],
};

function registerRuntime(workflows: WorkflowDefinition[] = [SHIPPED, HOST_WORKFLOW]) {
  registerWorkflowRuntime({
    workflowExecutor: {
      // Type-only: these doubles exercise the trigger path, which never
      // resumes. Throws rather than returning a value so an accidental
      // call fails loudly instead of silently passing.
      async resumeWorkflow() {
      throw new Error("resumeWorkflow is not exercised by this double");
      },
      async runWorkflow(workflow, input, proj, uid) {
        started.push({
          workflow,
          input,
          ...(proj !== undefined ? { projectId: proj } : {}),
          ...(uid !== undefined ? { userId: uid } : {}),
        });
        const run: WorkflowRun = {
          id: "run-1",
          workflowName: workflow.name,
          status: "success",
          startedAt: Date.now(),
          steps: [],
        };
        return run;
      },
    },
    getWorkflows: () => workflows,
  });
}

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

function granted(
  overrides: Partial<NonNullable<ExtensionPermissions["workflows"]>> = {},
): ExtensionPermissions {
  return {
    grantedAt: { workflows: Date.now() },
    workflows: { names: ["deploy"], maxRunsPerHour: 20, ...overrides },
  };
}

function ctx(overrides: Partial<WorkflowsHandlerContext> = {}): WorkflowsHandlerContext {
  return {
    extensionName: EXT_NAME,
    extensionId,
    userId,
    conversationId,
    grantedPermissions: granted(),
    manifest: manifest(),
    ...overrides,
  };
}

function req(params: Record<string, unknown> = {}): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/workflows",
    params: { v: 1, workflow: "deploy", ...params },
  };
}

async function auditRows() {
  return getTestDb().select().from(sdkCapabilityCalls);
}

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "wf-h@example.com", passwordHash: "h", name: "U",
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
    .values({ name: "wf-proj", path: "/tmp/wf" }).returning({ id: projects.id });
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
  _resetWorkflowTriggerQuotaForTests();
  // The token bucket is module-level and shared across every call in the
  // process — refill it so no test inherits a neighbour's drained bucket.
  _resetWorkflowRateLimitForTests(extensionId);
  _resetWorkflowRuntimeForTests();
  started = [];
  delete process.env.EZCORP_DISABLE_CAPABILITY_TOOLS;
  registerRuntime();
});

afterAll(async () => {
  restoreModuleMocks();
  _resetWorkflowRuntimeForTests();
  await closeTestDb();
});

describe("accept path", () => {
  test("starts the NAMESPACED workflow and reports it back", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error).toBeUndefined();
    expect(resp.result).toEqual({
      v: 1,
      workflow: `${EXT_NAME}:deploy`,
      started: true,
    });
    expect(started).toHaveLength(1);
    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:deploy`);
  });

  test("attributes the run to the provenance-resolved user, not the wire", async () => {
    await handleWorkflowsRpc(
      // A forged userId on the wire must be ignored entirely.
      req({ userId: "attacker", onBehalfOf: "attacker" }),
      ctx(),
    );

    expect(started[0]?.userId).toBe(userId);
  });

  test("derives projectId server-side from the calling conversation", async () => {
    await handleWorkflowsRpc(req({ projectId: "forged-project" }), ctx());

    expect(started[0]?.projectId).toBe(projectId);
  });

  test("threads the caller's input through verbatim", async () => {
    await handleWorkflowsRpc(req({ input: { ref: "abc", n: 3 } }), ctx());

    expect(started[0]?.input).toEqual({ ref: "abc", n: 3 });
  });

  test("an absent `input` becomes an empty object, not undefined", async () => {
    await handleWorkflowsRpc(req(), ctx());

    expect(started[0]?.input).toEqual({});
  });

  test("writes a success audit row naming the namespaced workflow", async () => {
    await handleWorkflowsRpc(req(), ctx());

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capability).toBe("workflows");
    expect(rows[0]?.action).toBe("run");
    expect(rows[0]?.success).toBe(true);
    expect(rows[0]?.resourceId).toBe(`${EXT_NAME}:deploy`);
    expect(rows[0]?.onBehalfOf).toBe(userId);
    expect(rows[0]?.extensionId).toBe(extensionId);
  });

  test("does NOT block on the run (returns before the graph finishes)", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((r) => { release = r; });
    registerWorkflowRuntime({
      workflowExecutor: {
        // Type-only: these doubles exercise the trigger path, which never
        // resumes. Throws rather than returning a value so an accidental
        // call fails loudly instead of silently passing.
        async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
        },
        async runWorkflow(workflow) {
          await blocked;
          return {
            id: "r", workflowName: workflow.name, status: "success",
            startedAt: 0, steps: [],
          } satisfies WorkflowRun;
        },
      },
      getWorkflows: () => [SHIPPED],
    });

    // Would hang forever if the handler awaited the run.
    const resp = await Promise.race([
      handleWorkflowsRpc(req(), ctx()),
      new Promise((_r, rej) => setTimeout(() => rej(new Error("handler blocked")), 2000)),
    ]);

    expect((resp as { result?: unknown }).result).toMatchObject({ started: true });
    release?.();
  });
});

describe("namespacing — an extension cannot reach the host's workflow", () => {
  test("`deploy` resolves the EXTENSION's asset, never the identically-named host one", async () => {
    await handleWorkflowsRpc(req(), ctx());

    expect(started[0]?.workflow.name).toBe(`${EXT_NAME}:deploy`);
    expect(started[0]?.workflow.description).not.toBe("host");
  });

  test("a wire name carrying the `:` separator is rejected outright", async () => {
    // The forge attempt: name a foreign namespace directly.
    const resp = await handleWorkflowsRpc(
      req({ workflow: "other-ext:deploy" }),
      ctx({ manifest: manifest(["other-ext:deploy"]), grantedPermissions: granted({ names: ["other-ext:deploy"] }) }),
    );

    expect(resp.error?.code).toBe(-32602);
    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOW_NAME_INVALID");
    expect(started).toHaveLength(0);
  });

  test("a granted-but-unshipped name is NOT_FOUND, not a host fallthrough", async () => {
    registerRuntime([HOST_WORKFLOW]); // extension ships nothing

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.code).toBe(-32602);
    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOW_NOT_FOUND");
    expect(started).toHaveLength(0);
  });

  test("resolves against the LIVE cache, so a reload is observed", async () => {
    let cache: WorkflowDefinition[] = [];
    registerWorkflowRuntime({
      workflowExecutor: {
        // Type-only: these doubles exercise the trigger path, which never
        // resumes. Throws rather than returning a value so an accidental
        // call fails loudly instead of silently passing.
        async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
        },
        async runWorkflow(workflow, input) {
          started.push({ workflow, input });
          return { id: "r", workflowName: workflow.name, status: "success", startedAt: 0, steps: [] };
        },
      },
      getWorkflows: () => cache,
    });

    const before = await handleWorkflowsRpc(req(), ctx());
    expect((before.error?.data as { reason: string }).reason).toBe("WORKFLOW_NOT_FOUND");

    cache = [SHIPPED];
    const after = await handleWorkflowsRpc(req(), ctx());
    expect(after.error).toBeUndefined();
  });
});

describe("enforcement ladder — rejections", () => {
  /** Pure reader — the typed `reason` the handler put on the error's `data`.
   *  Deliberately assertion-FREE so every test below states its own expected
   *  reason and code inline, at the call site, rather than hiding them behind
   *  a helper argument. */
  function reasonOf(resp: Awaited<ReturnType<typeof handleWorkflowsRpc>>): unknown {
    return (resp.error?.data as { reason?: unknown } | undefined)?.reason;
  }

  /** The half that IS shared: a rejection starts no run and writes exactly one
   *  failed audit row carrying the same typed reason. Identical for every rung,
   *  so asserting it once is the DRY part. */
  async function expectAuditedRejection(reason: string): Promise<void> {
    expect(started).toHaveLength(0);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(false);
    expect(rows[0]?.errorCode).toBe(reason);
    expect(rows[0]?.capability).toBe("workflows");
  }

  test("1. kill-switch disables the whole capability", async () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(reasonOf(resp)).toBe("WORKFLOWS_DISABLED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_DISABLED");
  });

  test("2. no grant at all", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx({ grantedPermissions: { grantedAt: {} } }));

    expect(reasonOf(resp)).toBe("WORKFLOWS_NOT_GRANTED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_NOT_GRANTED");
  });

  test("2. a structurally empty grant authorizes nothing", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx({ grantedPermissions: granted({ names: [] }) }));

    expect(reasonOf(resp)).toBe("WORKFLOWS_NOT_GRANTED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_NOT_GRANTED");
  });

  test("2. a non-positive rate ceiling authorizes nothing", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx({ grantedPermissions: granted({ maxRunsPerHour: 0 }) }));

    expect(reasonOf(resp)).toBe("WORKFLOWS_NOT_GRANTED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_NOT_GRANTED");
  });

  test("3. a missing / non-string workflow name", async () => {
    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 1, method: "ezcorp/workflows", params: { v: 1 } },
      ctx(),
    );

    expect(reasonOf(resp)).toBe("WORKFLOW_NAME_INVALID");
    expect(resp.error?.code).toBe(-32602);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOW_NAME_INVALID");
  });

  test("3. a path-traversal-shaped name", async () => {
    const resp = await handleWorkflowsRpc(req({ workflow: "../../etc/passwd" }), ctx());

    expect(reasonOf(resp)).toBe("WORKFLOW_NAME_INVALID");
    expect(resp.error?.code).toBe(-32602);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOW_NAME_INVALID");
  });

  test("4. a STALE grant naming a workflow the manifest no longer declares", async () => {
    // The exploit this rung exists for: the author narrowed the manifest but
    // the stored grant still lists the old name.
    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ manifest: manifest(["something-else"]) }),
    );

    expect(reasonOf(resp)).toBe("WORKFLOW_NOT_DECLARED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOW_NOT_DECLARED");
  });

  test("4. a manifest with no workflows block at all", async () => {
    const resp = await handleWorkflowsRpc(
      req(),
      ctx({ manifest: { ...manifest(), permissions: {} } as ExtensionManifestV2 }),
    );

    expect(reasonOf(resp)).toBe("WORKFLOW_NOT_DECLARED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOW_NOT_DECLARED");
  });

  test("5. declared in the manifest but NOT in the grant (admin denied it)", async () => {
    const resp = await handleWorkflowsRpc(
      req({ workflow: "other" }),
      ctx({ manifest: manifest(["deploy", "other"]) }),
    );

    expect(reasonOf(resp)).toBe("WORKFLOW_NOT_GRANTED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOW_NOT_GRANTED");
  });

  test("6. the PDP denies", async () => {
    const resp = await handleWorkflowsRpc(
      req(),
      ctx({
        engine: {
          async authorize() {
            return { decision: "deny", reason: "Missing capability" };
          },
        } as unknown as WorkflowsHandlerContext["engine"],
      }),
    );

    expect(reasonOf(resp)).toBe("WORKFLOWS_PERM_DENIED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_PERM_DENIED");
  });

  test("6. the PDP allows and names the PER-NAME capability", async () => {
    const seen: unknown[] = [];
    const resp = await handleWorkflowsRpc(
      req(),
      ctx({
      engine: {
        async authorize(_c: unknown, needed: unknown) {
          seen.push(needed);
          return { decision: "allow" };
        },
      } as unknown as WorkflowsHandlerContext["engine"],
      }),
    );

    expect(resp.error).toBeUndefined();
    expect(seen).toEqual([[{ kind: "ezcorp:workflows:run", value: "deploy" }]]);
  });

  test("7. an ownerless (cron/webhook) fire is REFUSED, never attributed", async () => {
    // The attribution decision: a run with no owner is unbilled, unaccountable
    // and — because SSE scoping is fail-closed on userId — invisible. We
    // refuse rather than invent an owner.
    const resp = await handleWorkflowsRpc(req(), ctx({ userId: "unknown" }));

    expect(resp.error?.code).toBe(-32106);
    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOWS_NO_OWNER");
    expect(started).toHaveLength(0);
  });

  test("7. an empty userId is refused the same way", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx({ userId: "" }));

    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOWS_NO_OWNER");
    expect(started).toHaveLength(0);
  });

  test("7. the ownerless refusal IS audited — to audit_log, not sdk_capability_calls", async () => {
    // `sdk_capability_calls.on_behalf_of` is NOT NULL + FK to users, so an
    // ownerless row cannot exist there and the insert would be swallowed.
    // Routing this rung to `audit_log` (nullable user_id) is what keeps the
    // one rejection class that most needs a trail from having none.
    await handleWorkflowsRpc(req(), ctx({ userId: "unknown" }));

    expect(await auditRows()).toHaveLength(0);
    const rows = await getTestDb().select().from(auditLog)
      .where(eq(auditLog.action, "ext:workflow-trigger-no-owner"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.target).toBe(extensionId);
    expect(rows[0]?.metadata).toMatchObject({ reason: "no-owner", newValue: "deploy" });
  });

  test("8. the extension is not wired to the calling conversation", async () => {
    await getTestDb().delete(conversationExtensions);

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(reasonOf(resp)).toBe("WORKFLOWS_NOT_WIRED");
    expect(resp.error?.code).toBe(-32001);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_NOT_WIRED");
  });

  test("8. a conversation-less (but owned) call skips the wiring gate", async () => {
    await getTestDb().delete(conversationExtensions);

    const resp = await handleWorkflowsRpc(req(), ctx({ conversationId: null }));

    expect(resp.error).toBeUndefined();
    expect(started).toHaveLength(1);
    // No conversation ⇒ no project coordinate is derived.
    expect(started[0]?.projectId).toBeUndefined();
  });

  test("10. a missing payload version", async () => {
    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 1, method: "ezcorp/workflows", params: { workflow: "deploy" } },
      ctx(),
    );

    expect(reasonOf(resp)).toBe("WORKFLOWS_BAD_PAYLOAD");
    expect(resp.error?.code).toBe(-32602);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_BAD_PAYLOAD");
  });

  test("10. a non-object `input`", async () => {
    const resp = await handleWorkflowsRpc(req({ input: ["not", "an", "object"] }), ctx());

    expect(reasonOf(resp)).toBe("WORKFLOWS_BAD_PAYLOAD");
    expect(resp.error?.code).toBe(-32602);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_BAD_PAYLOAD");
  });

  test("10. an oversized `input`", async () => {
    const big = { blob: "x".repeat(MAX_WORKFLOW_INPUT_BYTES + 100) };

    const resp = await handleWorkflowsRpc(req({ input: big }), ctx());

    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOWS_BAD_PAYLOAD");
    expect(resp.error?.message).toContain("too large");
    expect(started).toHaveLength(0);
  });

  test("9. the instantaneous token bucket sheds a burst", async () => {
    // `conversationId: null` removes the only `await` ahead of the bucket, so
    // every call in this `.map()` reaches `consumeTokens` inside one
    // synchronous tick — no wall-clock refill can smear the burst.
    const c = ctx({
      conversationId: null,
      grantedPermissions: granted({ maxRunsPerHour: 500 }),
    });

    const responses = await Promise.all(
      Array.from({ length: 60 }, () => handleWorkflowsRpc(req(), c)),
    );

    const shed = responses.filter(
      (r) => (r.error?.data as { reason?: string } | undefined)?.reason === "WORKFLOWS_RATE_LIMITED",
    );
    expect(shed.length).toBeGreaterThan(0);
    expect(shed[0]?.error?.code).toBe(-32029);
    // The bucket holds 50 tokens, so the accepted set is bounded — a burst
    // cannot start 60 workflow runs.
    expect(started.length).toBeLessThan(60);
  });

  test("11. the hourly quota is enforced and reports its numbers", async () => {
    const c = ctx({ grantedPermissions: granted({ maxRunsPerHour: 2 }) });

    expect((await handleWorkflowsRpc(req(), c)).error).toBeUndefined();
    expect((await handleWorkflowsRpc(req(), c)).error).toBeUndefined();
    const third = await handleWorkflowsRpc(req(), c);

    expect(third.error?.code).toBe(-32103);
    expect((third.error?.data as { reason: string }).reason).toBe("WORKFLOWS_QUOTA_EXCEEDED");
    expect(started).toHaveLength(2);
  });

  test("12. no registered runtime degrades to a typed soft-fail, never a crash", async () => {
    _resetWorkflowRuntimeForTests();

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(reasonOf(resp)).toBe("WORKFLOWS_RUNTIME_UNAVAILABLE");
    expect(resp.error?.code).toBe(-32603);
    expect(resp.result).toBeUndefined();
    await expectAuditedRejection("WORKFLOWS_RUNTIME_UNAVAILABLE");
  });

  test("13. an ASYNC run rejection is absorbed, not left unhandled", async () => {
    // `runWorkflow` terminalizes internally and resolves — a rejection would
    // be an executor bug. But the handler doesn't await the promise, so an
    // unhandled rejection could take the process down. It must be caught and
    // logged without changing the (already-sent) response.
    registerWorkflowRuntime({
      workflowExecutor: {
        // Type-only: these doubles exercise the trigger path, which never
        // resumes. Throws rather than returning a value so an accidental
        // call fails loudly instead of silently passing.
        async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
        },
        runWorkflow: () => Promise.reject(new Error("executor bug")),
      } as never,
      getWorkflows: () => [SHIPPED],
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const resp = await handleWorkflowsRpc(req(), ctx());
      expect(resp.error).toBeUndefined();
      expect(resp.result).toMatchObject({ started: true });
      // Let the rejection settle and the catch handler run.
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("13. a synchronous dispatch failure is reported, not thrown", async () => {
    registerWorkflowRuntime({
      workflowExecutor: {
        // Type-only: these doubles exercise the trigger path, which never
        // resumes. Throws rather than returning a value so an accidental
        // call fails loudly instead of silently passing.
        async resumeWorkflow() {
        throw new Error("resumeWorkflow is not exercised by this double");
        },
        runWorkflow() {
          throw new Error("executor exploded");
        },
      } as never,
      getWorkflows: () => [SHIPPED],
    });

    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.error?.code).toBe(-32603);
    expect((resp.error?.data as { reason: string }).reason).toBe("WORKFLOWS_DISPATCH_FAILED");
    expect(resp.error?.message).toContain("executor exploded");
  });
});

describe("audit", () => {
  test("a successful in-chat trigger inserts a capability-event pill", async () => {
    await handleWorkflowsRpc(req(), ctx());

    const pills = await getTestDb().select().from(messages);
    expect(pills).toHaveLength(1);
    expect(pills[0]?.role).toBe("capability-event");
    expect(String(pills[0]?.content)).toContain('"capability":"workflows"');
  });

  test("an audit failure NEVER turns a successful trigger into an RPC error", async () => {
    // `recordCapabilityCall` never throws by contract, so this defensive
    // catch is only reachable through the injected seam — but the guarantee
    // it encodes (an audit hiccup must not fail the capability) is the whole
    // reason the try/catch is there.
    const resp = await handleWorkflowsRpc(req(), ctx(), {
      recordCapabilityCall: async () => {
        throw new Error("audit table unreachable");
      },
    });

    expect(resp.error).toBeUndefined();
    expect(resp.result).toMatchObject({ started: true });
    expect(started).toHaveLength(1);
  });

  test("a REJECTED trigger is audited but does NOT spam the conversation", async () => {
    await handleWorkflowsRpc(req(), ctx({ manifest: manifest(["nope"]) }));

    expect(await getTestDb().select().from(messages)).toHaveLength(0);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(false);
  });
});

describe("op: approvals — the LLM-facing read", () => {
  beforeEach(async () => {
    // The outer beforeEach does not know about workflow rows, and every
    // test here asserts on the EXACT set returned — a leftover park from
    // a neighbour would make "reports nothing" pass or fail for reasons
    // that have nothing to do with the scoping under test.
    await getTestDb().delete(workflowApprovals);
    await getTestDb().delete(workflowRuns);
  });

  /** Park an approval on a run of `workflowName`, owned by `owner`. */
  async function park(opts: {
    workflowName: string;
    stepName?: string;
    owner?: string | null;
    prompt?: string;
    itemIds?: string[];
    requireItemConsent?: boolean;
  }): Promise<string> {
    const { insertWorkflowRun } = await import("../../db/queries/workflow-runs");
    const { parkWorkflowApproval } = await import("../../db/queries/workflow-approvals");
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: opts.workflowName,
      input: {},
      startedAt: new Date(),
      userId: opts.owner === undefined ? userId : opts.owner,
    });
    return parkWorkflowApproval({
      workflowRunId: runId,
      stepName: opts.stepName ?? "gate",
      prompt: opts.prompt ?? "Ship it?",
      choices: ["approve", "reject"],
      requireItemConsent: opts.requireItemConsent ?? false,
      itemIds: opts.itemIds ?? [],
    });
  }

  function readReq(): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: 9,
      method: "ezcorp/workflows",
      params: { v: 1, op: "approvals" },
    };
  }

  test("reports this extension's parked approval WITH the verbatim relay", async () => {
    // The relay is the whole reason the read exists: an LLM cannot be
    // handed the items without also being handed the instruction not to
    // decide on the user's behalf.
    const approvalId = await park({
      workflowName: `${EXT_NAME}:deploy`,
      requireItemConsent: true,
      itemIds: ["a.ts", "b.ts"],
      prompt: "Delete these?",
    });

    const resp = await handleWorkflowsRpc(readReq(), ctx());

    expect(resp.error).toBeUndefined();
    const body = resp.result as {
      v: number;
      approvals: Array<Record<string, unknown>>;
    };
    expect(body.v).toBe(1);
    expect(body.approvals).toHaveLength(1);
    const first = body.approvals[0]!;
    expect(first.approvalId).toBe(approvalId);
    expect(first.stepName).toBe("gate");
    expect(first.requireItemConsent).toBe(true);
    expect(first.itemIds).toEqual(["a.ts", "b.ts"]);

    const relay = first.relay as { stop: boolean; directive: string | null; text: string; items: string[] };
    expect(relay.stop).toBe(true);
    expect(relay.directive).toContain("VERBATIM");
    expect(relay.text.startsWith(relay.directive!)).toBe(true);
    // Verbatim means verbatim — the prompt and every item, unaltered and
    // in the order the run produced them.
    expect(relay.text).toContain("Delete these?");
    expect(relay.items).toEqual(["a.ts", "b.ts"]);
  });

  test("never reports another user's parked decision", async () => {
    // The prompt names what is about to be done and to what.
    const other = await createUser({
      email: "wf-other@example.com", passwordHash: "h", name: "O",
      role: "member", status: "active",
    });
    await park({ workflowName: `${EXT_NAME}:deploy`, owner: other.id, prompt: "Secret" });

    const body = (await handleWorkflowsRpc(readReq(), ctx())).result as {
      approvals: unknown[];
    };
    expect(body.approvals).toEqual([]);
  });

  test("never reports a workflow this extension was not granted", async () => {
    // The host workflow shares the bare name `deploy`; only the
    // namespaced one is this extension's.
    await park({ workflowName: "deploy", prompt: "Host workflow" });
    await park({ workflowName: "other-ext:deploy", prompt: "Someone else's" });

    const body = (await handleWorkflowsRpc(readReq(), ctx())).result as {
      approvals: unknown[];
    };
    expect(body.approvals).toEqual([]);
  });

  test("an UNOWNED run's approval is admin-only and is not reported", async () => {
    await park({ workflowName: `${EXT_NAME}:deploy`, owner: null });

    const body = (await handleWorkflowsRpc(readReq(), ctx())).result as {
      approvals: unknown[];
    };
    expect(body.approvals).toEqual([]);
  });

  test("clears the same wiring gate the trigger does", async () => {
    await getTestDb().delete(conversationExtensions);
    const resp = await handleWorkflowsRpc(readReq(), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NOT_WIRED" });
  });

  test("refuses an ownerless read — there is no owner whose decisions to list", async () => {
    const resp = await handleWorkflowsRpc(readReq(), ctx({ userId: "" }));
    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NO_OWNER" });
  });

  test("refuses without a workflows grant, like every other op", async () => {
    const resp = await handleWorkflowsRpc(
      readReq(),
      ctx({ grantedPermissions: { grantedAt: {} } as never }),
    );
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NOT_GRANTED" });
  });

  test("does NOT consume the hourly RUN quota", async () => {
    // A status poll that burned the run budget would take away the
    // capability it is reporting on. One run's worth of quota, then reads
    // until the cows come home, then the run still works.
    await park({ workflowName: `${EXT_NAME}:deploy` });
    for (let i = 0; i < 30; i++) {
      _resetWorkflowRateLimitForTests(extensionId);
      const resp = await handleWorkflowsRpc(readReq(), ctx({ grantedPermissions: granted({ maxRunsPerHour: 1 }) }));
      expect(resp.error).toBeUndefined();
    }
    _resetWorkflowRateLimitForTests(extensionId);
    const triggered = await handleWorkflowsRpc(req(), ctx({ grantedPermissions: granted({ maxRunsPerHour: 1 }) }));
    expect(triggered.error).toBeUndefined();
    expect(started).toHaveLength(1);
  });

  test("an unknown op is refused rather than silently treated as a run", async () => {
    const resp = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 3, method: "ezcorp/workflows", params: { v: 1, op: "delete" } },
      ctx(),
    );
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_OP" });
    expect(started).toHaveLength(0);
  });

  test("an ABSENT op still runs — every existing caller is untouched", async () => {
    const resp = await handleWorkflowsRpc(req(), ctx());
    expect(resp.result).toMatchObject({ started: true });
    expect(started).toHaveLength(1);
  });

  test("audits the read, like every other outcome", async () => {
    await park({ workflowName: `${EXT_NAME}:deploy` });
    await handleWorkflowsRpc(readReq(), ctx());
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(true);
  });

  test("is rate limited — a read is cheap, not free", async () => {
    let refused: unknown;
    for (let i = 0; i < 200; i++) {
      const resp = await handleWorkflowsRpc(readReq(), ctx());
      if (resp.error) { refused = resp.error.data; break; }
    }
    expect(refused).toMatchObject({ reason: "WORKFLOWS_RATE_LIMITED" });
  });
});
