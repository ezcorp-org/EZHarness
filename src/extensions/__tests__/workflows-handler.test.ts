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
  isValidJobRef,
  MAX_JOB_REF_LEN,
  MAX_WORKFLOW_INPUT_BYTES,
  RUNS_PAGE_DEFAULT,
  RUNS_PAGE_MAX,
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
import {
  systemCachedWorkflow,
  type CachedWorkflow,
} from "../../runtime/workflow-scope";

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
  /** The trailing options bag, verbatim. `jobRef` rides here, and the
   *  double has to capture it or a test could not tell "forwarded" from
   *  "silently dropped". */
  opts?: Record<string, unknown>;
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
      async runWorkflow(workflow, input, proj, uid, _signal, opts) {
        started.push({
          workflow,
          input,
          ...(proj !== undefined ? { projectId: proj } : {}),
          ...(uid !== undefined ? { userId: uid } : {}),
          ...(opts !== undefined ? { opts: opts as Record<string, unknown> } : {}),
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

describe("op: runs — the ONLY correlation path from a trigger to its run", () => {
  // `run()` returns no run id, and the `workflow:*` bus events are
  // structurally undeliverable to an extension (the dispatcher drops any
  // payload without a top-level string `conversationId`, and `WorkflowRun`
  // has none). Without this read a trigger is fire-and-FORGET in the
  // literal sense — the extension can never learn what happened.
  beforeEach(async () => {
    await getTestDb().delete(workflowApprovals);
    await getTestDb().delete(workflowRuns);
  });

  /** Insert a run row, optionally already terminal. The status is written
   *  directly rather than through `finalizeWorkflowRunRow` so a test can
   *  seed ANY status (that helper only accepts the terminal subset). */
  async function seedRun(opts: {
    workflowName: string;
    owner?: string | null;
    status?: string;
    startedAt?: Date;
  }): Promise<string> {
    const { insertWorkflowRun } = await import("../../db/queries/workflow-runs");
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: opts.workflowName,
      input: {},
      startedAt: opts.startedAt ?? new Date(),
      userId: opts.owner === undefined ? userId : opts.owner,
    });
    if (opts.status !== undefined && opts.status !== "running") {
      await getTestDb()
        .update(workflowRuns)
        .set({ status: opts.status as never, finishedAt: new Date() })
        .where(eq(workflowRuns.id, runId));
    }
    return runId;
  }

  function runsReq(params: Record<string, unknown> = {}): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: 11,
      method: "ezcorp/workflows",
      params: { v: 1, op: "runs", ...params },
    };
  }

  /** The `runs` array off a successful response. */
  function runsOf(resp: Awaited<ReturnType<typeof handleWorkflowsRpc>>) {
    return (resp.result as { v: number; runs: Array<Record<string, unknown>> }).runs;
  }

  test("reports this extension's run with the id, status and timestamps", async () => {
    const runId = await seedRun({ workflowName: `${EXT_NAME}:deploy`, status: "success" });

    const resp = await handleWorkflowsRpc(runsReq(), ctx());

    expect(resp.error).toBeUndefined();
    expect((resp.result as { v: number }).v).toBe(1);
    const runs = runsOf(resp);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.workflowRunId).toBe(runId);
    expect(runs[0]!.workflowName).toBe(`${EXT_NAME}:deploy`);
    expect(runs[0]!.status).toBe("success");
    expect(typeof runs[0]!.startedAt).toBe("string");
    expect(runs[0]!.finishedAt).not.toBeNull();
    expect(runs[0]!.resumable).toBe(false);
  });

  test("carries NO `input` and NO `result` — unbounded, and input is the untrusted surface", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });

    const runs = runsOf(await handleWorkflowsRpc(runsReq(), ctx()));

    expect(runs[0]).not.toHaveProperty("input");
    expect(runs[0]).not.toHaveProperty("result");
  });

  test("orders newest-first", async () => {
    const old = await seedRun({
      workflowName: `${EXT_NAME}:deploy`,
      startedAt: new Date(Date.now() - 60_000),
    });
    const fresh = await seedRun({ workflowName: `${EXT_NAME}:deploy` });

    const runs = runsOf(await handleWorkflowsRpc(runsReq(), ctx()));

    expect(runs.map((r) => r.workflowRunId)).toEqual([fresh, old]);
  });

  test("reports an empty list when nothing has run — never an error", async () => {
    const resp = await handleWorkflowsRpc(runsReq(), ctx());
    expect(resp.error).toBeUndefined();
    expect(runsOf(resp)).toEqual([]);
  });

  // ── Scoping: the two structural filters ──────────────────────────────

  test("never reports another user's run", async () => {
    const other = await createUser({
      email: "wf-runs-other@example.com", passwordHash: "h", name: "O",
      role: "member", status: "active",
    });
    await seedRun({ workflowName: `${EXT_NAME}:deploy`, owner: other.id });

    expect(runsOf(await handleWorkflowsRpc(runsReq(), ctx()))).toEqual([]);
  });

  test("an UNOWNED run is admin-only and is not reported", async () => {
    // The extension holds no role; `isAdmin` is passed false unconditionally.
    await seedRun({ workflowName: `${EXT_NAME}:deploy`, owner: null });

    expect(runsOf(await handleWorkflowsRpc(runsReq(), ctx()))).toEqual([]);
  });

  test("never reports the HOST's identically-named workflow", async () => {
    // `deploy` exists both bare (the host's) and namespaced (ours). The
    // wire cannot express the bare one: the filter is built host-side from
    // the granted names.
    await seedRun({ workflowName: "deploy" });

    expect(runsOf(await handleWorkflowsRpc(runsReq(), ctx()))).toEqual([]);
  });

  test("never reports another extension's workflow", async () => {
    await seedRun({ workflowName: "other-ext:deploy" });

    expect(runsOf(await handleWorkflowsRpc(runsReq(), ctx()))).toEqual([]);
  });

  test("reports only the GRANTED names, not everything the manifest declares", async () => {
    // The admin granted `deploy` but not `other`; a run of `other` is out
    // of scope even though the manifest names it.
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    await seedRun({ workflowName: `${EXT_NAME}:other` });

    const runs = runsOf(
      await handleWorkflowsRpc(runsReq(), ctx({ manifest: manifest(["deploy", "other"]) })),
    );

    expect(runs.map((r) => r.workflowName)).toEqual([`${EXT_NAME}:deploy`]);
  });

  test("a MULTI-name grant reports every granted workflow", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    await seedRun({ workflowName: `${EXT_NAME}:other` });

    const runs = runsOf(
      await handleWorkflowsRpc(
        runsReq(),
        ctx({
          manifest: manifest(["deploy", "other"]),
          grantedPermissions: granted({ names: ["deploy", "other"] }),
        }),
      ),
    );

    expect(new Set(runs.map((r) => r.workflowName))).toEqual(
      new Set([`${EXT_NAME}:deploy`, `${EXT_NAME}:other`]),
    );
  });

  // ── Optional filters ────────────────────────────────────────────────

  test("`workflow` narrows to one of the granted names", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    await seedRun({ workflowName: `${EXT_NAME}:other` });
    const c = ctx({
      manifest: manifest(["deploy", "other"]),
      grantedPermissions: granted({ names: ["deploy", "other"] }),
    });

    const runs = runsOf(await handleWorkflowsRpc(runsReq({ workflow: "other" }), c));

    expect(runs.map((r) => r.workflowName)).toEqual([`${EXT_NAME}:other`]);
  });

  test("`workflow` NARROWING can never WIDEN — an ungranted name is refused", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:other` });

    const resp = await handleWorkflowsRpc(
      runsReq({ workflow: "other" }),
      ctx({ manifest: manifest(["deploy", "other"]) }),
    );

    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOW_NOT_GRANTED" });
  });

  test("a `workflow` carrying the `:` separator is refused, not namespaced twice", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ workflow: "other-ext:deploy" }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOW_NOT_GRANTED" });
  });

  test("a non-string `workflow` is refused", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ workflow: 42 }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOW_NOT_GRANTED" });
  });

  test("`status` filters, and the filter reaches the query", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy`, status: "success" });
    const errored = await seedRun({ workflowName: `${EXT_NAME}:deploy`, status: "error" });

    const runs = runsOf(await handleWorkflowsRpc(runsReq({ status: "error" }), ctx()));

    expect(runs.map((r) => r.workflowRunId)).toEqual([errored]);
  });

  test("an out-of-vocabulary `status` is REFUSED, not silently an empty page", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ status: "nonesuch" }), ctx());

    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("`skipped` is refused — it is a STEP state no run terminalizes into", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ status: "skipped" }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("a non-string `status` is refused", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ status: 7 }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("`limit` bounds the page", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });

    expect(runsOf(await handleWorkflowsRpc(runsReq({ limit: 2 }), ctx()))).toHaveLength(2);
  });

  test("a `limit` over the ceiling is refused rather than clamped", async () => {
    // Clamping would let a caller believe it asked for and received 500.
    const resp = await handleWorkflowsRpc(runsReq({ limit: RUNS_PAGE_MAX + 1 }), ctx());

    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_PAYLOAD" });
    expect(resp.error?.message).toContain(String(RUNS_PAGE_MAX));
  });

  test.each([0, -1, 1.5, "20", null])("a bad `limit` (%p) is refused", async (bad) => {
    const resp = await handleWorkflowsRpc(runsReq({ limit: bad }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_PAYLOAD" });
  });

  test("an absent `limit` defaults, and the default is the documented one", async () => {
    for (let i = 0; i < RUNS_PAGE_DEFAULT + 3; i++) {
      await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    }

    expect(runsOf(await handleWorkflowsRpc(runsReq(), ctx()))).toHaveLength(RUNS_PAGE_DEFAULT);
  });

  // ── The enforcement envelope ────────────────────────────────────────

  test("refuses an OWNERLESS (cron/webhook) read with -32106", async () => {
    // The result set is defined by who is asking; an ownerless read is not
    // a narrower read, it is a different question with no answer.
    const resp = await handleWorkflowsRpc(runsReq(), ctx({ userId: "unknown" }));

    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NO_OWNER" });
    expect(resp.result).toBeUndefined();
  });

  test("an empty userId is refused the same way", async () => {
    const resp = await handleWorkflowsRpc(runsReq(), ctx({ userId: "" }));
    expect(resp.error?.code).toBe(-32106);
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NO_OWNER" });
  });

  test("clears the same wiring gate the trigger does", async () => {
    await getTestDb().delete(conversationExtensions);

    const resp = await handleWorkflowsRpc(runsReq(), ctx());

    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NOT_WIRED" });
  });

  test("a conversation-less (but owned) read skips the wiring gate", async () => {
    await getTestDb().delete(conversationExtensions);
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });

    const resp = await handleWorkflowsRpc(runsReq(), ctx({ conversationId: null }));

    expect(resp.error).toBeUndefined();
    expect(runsOf(resp)).toHaveLength(1);
  });

  test("refuses without a workflows grant, like every other op", async () => {
    const resp = await handleWorkflowsRpc(
      runsReq(),
      ctx({ grantedPermissions: { grantedAt: {} } as never }),
    );
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_NOT_GRANTED" });
  });

  test("is refused by the kill-switch, like every other op", async () => {
    process.env.EZCORP_DISABLE_CAPABILITY_TOOLS = "1";
    const resp = await handleWorkflowsRpc(runsReq(), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_DISABLED" });
  });

  test("does NOT consume the hourly RUN quota", async () => {
    // A correlation poll that burned the run budget would take away the
    // capability it exists to report on — and this op is designed to be
    // polled, so it would do it fast.
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });
    const c = ctx({ grantedPermissions: granted({ maxRunsPerHour: 1 }) });

    for (let i = 0; i < 30; i++) {
      _resetWorkflowRateLimitForTests(extensionId);
      expect((await handleWorkflowsRpc(runsReq(), c)).error).toBeUndefined();
    }

    _resetWorkflowRateLimitForTests(extensionId);
    const triggered = await handleWorkflowsRpc(req(), c);
    expect(triggered.error).toBeUndefined();
    expect(started).toHaveLength(1);
  });

  test("is rate limited — a read is cheap, not free", async () => {
    let refused: unknown;
    for (let i = 0; i < 200; i++) {
      const resp = await handleWorkflowsRpc(runsReq(), ctx());
      if (resp.error) { refused = resp.error.data; break; }
    }
    expect(refused).toMatchObject({ reason: "WORKFLOWS_RATE_LIMITED" });
  });

  test("audits the read, like every other outcome", async () => {
    await seedRun({ workflowName: `${EXT_NAME}:deploy` });

    await handleWorkflowsRpc(runsReq(), ctx());

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.success).toBe(true);
    expect(rows[0]?.capability).toBe("workflows");
    expect(rows[0]?.after).toMatchObject({ op: "runs", count: 1 });
  });

  test("starts NO run — it is a read", async () => {
    await handleWorkflowsRpc(runsReq(), ctx());
    expect(started).toHaveLength(0);
  });

  test("an ABSENT op still runs — `runs` did not change the default", async () => {
    // The whole point of branching on `op` rather than adding a required
    // discriminator: every existing caller takes the identical path.
    const resp = await handleWorkflowsRpc(req(), ctx());

    expect(resp.result).toMatchObject({ v: 1, workflow: `${EXT_NAME}:deploy`, started: true });
    expect(started).toHaveLength(1);
  });

  test("an unknown op is still refused — `runs` did not open the union", async () => {
    const resp = await handleWorkflowsRpc(runsReq({ op: "delete" }), ctx());
    expect(resp.error?.data).toMatchObject({ reason: "WORKFLOWS_BAD_OP" });
  });
});

// ── `jobRef` — the durable half of the job -> run correlation ────────
//
// `run()` returns no run id on purpose (rung 13), and the `workflow:*`
// bus events cannot reach an extension at all. So the only way a caller
// can ever say "that run came from this job" is a handle it supplies
// going in and reads back out of `op: "runs"`. Without it the answer is
// a timestamp match, which is wrong the first time two jobs fire in the
// same second — and wrong in a way nobody notices.

describe("op: run — the jobRef correlation handle", () => {
  test("a valid handle is forwarded to the executor VERBATIM", async () => {
    const res = await handleWorkflowsRpc(req({ jobRef: "job-42_a.b:c" }), ctx());
    expect("result" in res).toBe(true);
    expect(started).toHaveLength(1);
    // The whole point. A handle the executor never receives is a handle
    // that never reaches `workflow_runs.job_ref`.
    expect(started[0]?.opts).toEqual({ jobRef: "job-42_a.b:c" });
  });

  test("no handle ⇒ the options bag is OMITTED, not `{jobRef: undefined}`", async () => {
    // `undefined` reaching the column writes the string "undefined" in the
    // wrong hands; the executor's `?? null` only helps if the key is absent.
    await handleWorkflowsRpc(req(), ctx());
    expect(started[0]?.opts).toBeUndefined();
  });

  test("the successful trigger's audit row carries the handle too", async () => {
    await handleWorkflowsRpc(req({ jobRef: "job-42" }), ctx());
    const rows = await auditRows();
    const ok = rows.find((r) => r.success === true);
    expect((ok?.after as { jobRef?: string })?.jobRef).toBe("job-42");
  });

  describe("shape is checked; nothing else about it is", () => {
    const bad: Array<[string, unknown]> = [
      ["a non-string", 42],
      ["an empty string", ""],
      ["a leading separator", "-job"],
      ["whitespace", "job 42"],
      ["a newline", "job\n42"],
      ["a path traversal", "../../etc/passwd"],
      ["markup", "<img src=x onerror=1>"],
      ["over the length cap", "j".repeat(MAX_JOB_REF_LEN + 1)],
    ];

    for (const [what, value] of bad) {
      test(`${what} is REJECTED, and nothing starts`, async () => {
        const res = await handleWorkflowsRpc(req({ jobRef: value }), ctx());
        expect("error" in res).toBe(true);
        expect((res as { error: { data: { reason: string } } }).error.data.reason).toBe(
          "WORKFLOWS_BAD_PAYLOAD",
        );
        // Rejected, never sanitized: a silently-rewritten handle
        // correlates to the wrong job, which is worse than none.
        expect(started).toEqual([]);
      });
    }

    test("exactly at the length cap is accepted", async () => {
      // Discrimination for the cap: off-by-one in the other direction
      // would refuse a legal handle.
      const res = await handleWorkflowsRpc(
        req({ jobRef: "j".repeat(MAX_JOB_REF_LEN) }),
        ctx(),
      );
      expect("result" in res).toBe(true);
    });

    test("a UUID — what the console actually sends — is accepted", async () => {
      const res = await handleWorkflowsRpc(
        req({ jobRef: "c5c41a16-ec9b-4b5e-82d6-04b28f7aeff4" }),
        ctx(),
      );
      expect("result" in res).toBe(true);
      expect(started[0]?.opts).toEqual({ jobRef: "c5c41a16-ec9b-4b5e-82d6-04b28f7aeff4" });
    });
  });

  test("isValidJobRef agrees with the handler", () => {
    expect(isValidJobRef("c5c41a16-ec9b-4b5e-82d6-04b28f7aeff4")).toBe(true);
    expect(isValidJobRef("A0")).toBe(true);
    expect(isValidJobRef("")).toBe(false);
    expect(isValidJobRef("_leading")).toBe(false);
    expect(isValidJobRef(null)).toBe(false);
    expect(isValidJobRef("x".repeat(MAX_JOB_REF_LEN + 1))).toBe(false);
  });
});

describe("op: runs — the handle comes back", () => {
  test("each row carries the jobRef the run was started with", async () => {
    const { insertWorkflowRun } = await import("../../db/queries/workflow-runs");
    await insertWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: `${EXT_NAME}:deploy`,
      userId,
      input: {},
      startedAt: new Date(),
      jobRef: "job-abc",
    });
    const res = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 9, method: "ezcorp/workflows", params: { v: 1, op: "runs" } },
      ctx(),
    );
    const runs = (res as { result: { runs: Array<{ jobRef: string | null }> } }).result.runs;
    expect(runs).toHaveLength(1);
    // Without this the extension gets a run list it cannot attribute —
    // the read exists precisely to close that gap.
    expect(runs[0]?.jobRef).toBe("job-abc");
  });

  test("a run started WITHOUT a handle reports null, not a guess", async () => {
    const { insertWorkflowRun } = await import("../../db/queries/workflow-runs");
    await insertWorkflowRun({
      id: crypto.randomUUID(),
      workflowName: `${EXT_NAME}:deploy`,
      userId,
      input: {},
      startedAt: new Date(),
    });
    const res = await handleWorkflowsRpc(
      { jsonrpc: "2.0", id: 9, method: "ezcorp/workflows", params: { v: 1, op: "runs" } },
      ctx(),
    );
    const runs = (res as { result: { runs: Array<{ jobRef: string | null }> } }).result.runs;
    expect(runs[0]?.jobRef).toBeNull();
  });
});

// ── Rung 12b — the SHARED run ladder ────────────────────────────────

describe("rung 12b — canRunWorkflow, the same predicate the REST route asks", () => {
  test("a DISABLED owning extension refuses the trigger", async () => {
    // The rule the rungs above cannot express. `reloadWorkflows()` fires
    // only on workflow CRUD, never on extension disable, so without this
    // live re-check a disabled extension's workflows stay runnable off the
    // stale merged cache until something writes a workflow or the process
    // restarts.
    await getTestDb()
      .update(extensions)
      .set({ enabled: false })
      .where(eq(extensions.id, extensionId));
    try {
      const res = await handleWorkflowsRpc(req(), ctx());
      expect("error" in res).toBe(true);
      expect((res as { error: { data: { reason: string } } }).error.data.reason).toBe(
        "WORKFLOWS_PERM_DENIED",
      );
      expect(started).toEqual([]);
      // Audited like every other refusal — a denial that leaves no trail
      // is the class that most needs one.
      const rows = await auditRows();
      expect(rows.some((r) => r.errorCode === "WORKFLOWS_PERM_DENIED")).toBe(true);
    } finally {
      await getTestDb()
        .update(extensions)
        .set({ enabled: true })
        .where(eq(extensions.id, extensionId));
    }
  });

  test("an ENABLED owning extension still runs — the rung is a bound, not a wall", async () => {
    // Discrimination for the test above: without it, a rung that denied
    // unconditionally would pass just as well.
    const res = await handleWorkflowsRpc(req(), ctx());
    expect("result" in res).toBe(true);
    expect(started).toHaveLength(1);
  });

  test("it is asked BELOW the ownerless bound — no run without an owner", async () => {
    const res = await handleWorkflowsRpc(req(), ctx({ userId: null }));
    expect("error" in res).toBe(true);
    expect((res as { error: { data: { reason: string } } }).error.data.reason).toBe(
      "WORKFLOWS_NO_OWNER",
    );
    expect(started).toEqual([]);
  });
});

describe("rung 12b — which cache entry gets authorized", () => {
  /** Re-register the runtime WITH the provenance reader production wires. */
  function registerWithCache(entries: CachedWorkflow[]) {
    registerWorkflowRuntime({
      workflowExecutor: {
        async resumeWorkflow() {
          throw new Error("resumeWorkflow is not exercised by this double");
        },
        async runWorkflow(workflow, input, proj, uid, _signal, opts) {
          started.push({
            workflow,
            input,
            ...(proj !== undefined ? { projectId: proj } : {}),
            ...(uid !== undefined ? { userId: uid } : {}),
            ...(opts !== undefined ? { opts: opts as Record<string, unknown> } : {}),
          });
          return {
            id: "run-1",
            workflowName: workflow.name,
            status: "success",
            startedAt: Date.now(),
            steps: [],
          } as WorkflowRun;
        },
      },
      getWorkflows: () => entries.map((e) => e.definition),
      getCachedWorkflows: () => entries,
    });
  }

  test("the REGISTERED entry is used when the runtime exposes one", async () => {
    // Production registers `getCachedWorkflows` (web/src/lib/server/context.ts),
    // so this — not the fallback — is the path that actually runs. An
    // extension-shipped workflow is a `system` entry, so it authorizes.
    registerWithCache([systemCachedWorkflow(SHIPPED, "extension")]);
    const res = await handleWorkflowsRpc(req(), ctx());
    expect("result" in res).toBe(true);
    expect(started).toHaveLength(1);
  });

  test("a PRIVATE entry owned by someone else is REFUSED", async () => {
    // The fallback constructs a `system` entry, which authorizes everyone.
    // If the real reader were ignored, a `workflow_definitions` row squatting
    // an extension-namespaced name would be runnable by any caller. This is
    // the case that proves the registered entry wins.
    registerWithCache([
      {
        definition: SHIPPED,
        source: "db",
        id: "row-1",
        projectId: null,
        userId: "somebody-else",
        visibility: "private",
        forkedFrom: null,
      },
    ]);
    const res = await handleWorkflowsRpc(req(), ctx());
    expect("error" in res).toBe(true);
    expect((res as { error: { data: { reason: string } } }).error.data.reason).toBe(
      "WORKFLOWS_PERM_DENIED",
    );
    expect(started).toEqual([]);
  });

  test("a cache that does not carry the name at all falls back and still runs", async () => {
    // Rung 12 already proved the name resolves, so a reader that answers
    // without it is a runtime that registered a narrower view — the
    // reconstructed `system` entry is the same value `buildWorkflowCache`
    // would have produced for an extension asset.
    registerWithCache([systemCachedWorkflow(HOST_WORKFLOW, "yaml")]);
    // `getWorkflows` must still resolve the namespaced name for rung 12.
    registerWorkflowRuntime({
      workflowExecutor: {
        async resumeWorkflow() {
          throw new Error("resumeWorkflow is not exercised by this double");
        },
        async runWorkflow(workflow, input, proj, uid, _signal, opts) {
          started.push({
            workflow,
            input,
            ...(proj !== undefined ? { projectId: proj } : {}),
            ...(uid !== undefined ? { userId: uid } : {}),
            ...(opts !== undefined ? { opts: opts as Record<string, unknown> } : {}),
          });
          return {
            id: "run-1",
            workflowName: workflow.name,
            status: "success",
            startedAt: Date.now(),
            steps: [],
          } as WorkflowRun;
        },
      },
      getWorkflows: () => [SHIPPED, HOST_WORKFLOW],
      getCachedWorkflows: () => [systemCachedWorkflow(HOST_WORKFLOW, "yaml")],
    });
    const res = await handleWorkflowsRpc(req(), ctx());
    expect("result" in res).toBe(true);
  });
});
