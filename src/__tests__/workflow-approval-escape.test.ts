/**
 * Regressions for three ways a workflow tool step COULD still hang on a
 * permission prompt, all found by attacking the original guard.
 *
 * The first guard matched only on `conversationId === <this run's scope
 * key>`. Every case below opens a gate on some OTHER key, which that
 * guard did not claim, so the promise parked and the run awaited it
 * forever. Each test drives a real `WorkflowExecutor` and fails by
 * TIMING OUT the race if the guard regresses — an assertion on the
 * status alone would just hang the suite instead of failing it.
 */
import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgentsStatic } from "../runtime/loader";
import { WorkflowExecutor, workflowScopeKey } from "../runtime/workflow-executor";
import {
  createExtensionPermissionGate,
  getPendingApproval,
  NON_INTERACTIVE_KEY_PREFIX,
  resolvePermission,
} from "../runtime/tools/permissions";
import type { AgentEvents, WorkflowDefinition } from "../types";
import type { ToolCallResult } from "../extensions/types";
import type { WorkflowToolRunner } from "../runtime/workflow-tool-runner";

const HANG_BUDGET_MS = 1500;

function ok(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: false };
}

const singleToolStep: WorkflowDefinition = {
  name: "wf",
  description: "",
  steps: [{ name: "call", kind: "tool", tool: "ext__t" }],
};

/** Run the workflow, failing loudly rather than hanging if the guard breaks. */
async function runBounded(runner: WorkflowToolRunner): Promise<{ status: string; error: unknown }> {
  const bus = new EventBus<AgentEvents>();
  const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
  const wf = new WorkflowExecutor(agentExec, bus, { toolRunnerFactory: () => runner });
  const outcome = await Promise.race([
    wf.runWorkflow(singleToolStep, {}, undefined, "u1"),
    new Promise<never>((_r, rej) =>
      setTimeout(() => rej(new Error("runWorkflow HUNG on a permission gate")), HANG_BUDGET_MS),
    ),
  ]);
  return { status: outcome.status, error: outcome.result?.error };
}

function gateOpeningRunner(conversationIdFor: (dispatchKey: string) => string) {
  const runner: WorkflowToolRunner = {
    setCurrentUserId() {},
    setCurrentConversationId() {},
    async executeToolCall(_tool, _input, conversationId) {
      await createExtensionPermissionGate({
        promptId: `p-${crypto.randomUUID()}`,
        conversationId: conversationIdFor(conversationId),
        userId: "u1",
        extensionId: "extension-author",
        toolName: "create_extension",
        capabilityKind: "fs.write",
      });
      return ok("unreachable — the gate must never resolve here");
    },
  };
  return runner;
}

describe("escape 1: a gate opened on a FOREIGN conversation id", () => {
  test("is refused by the ambient scope, not awaited", async () => {
    // A nested dispatch that resolved some unrelated real conversation
    // id. Key matching alone did not claim this, so the run hung.
    const foreign = `conv-${crypto.randomUUID()}`;
    const { status, error } = await runBounded(gateOpeningRunner(() => foreign));
    expect(status).toBe("awaiting_approval");
    expect(String((error as { message?: string })?.message)).toContain(
      "requires interactive approval",
    );
  });

  test("leaves nothing parked in pendingApprovals", async () => {
    const foreign = `conv-${crypto.randomUUID()}`;
    const promptId = `p-${crypto.randomUUID()}`;
    const runner: WorkflowToolRunner = {
      setCurrentUserId() {},
      setCurrentConversationId() {},
      async executeToolCall() {
        await createExtensionPermissionGate({
          promptId,
          conversationId: foreign,
          userId: "u1",
          extensionId: "ext",
          toolName: "t",
          capabilityKind: "fs.write",
        });
        return ok("unreachable");
      },
    };
    await runBounded(runner);
    // A refused gate is never parked, so there is nothing to leak. The
    // old guard parked it under `foreign` and teardown (which swept only
    // the run's own key) left it there for the life of the process.
    expect(getPendingApproval(promptId)).toBe(false);
  });
});

describe("escape 2: the `cross-ext-<reqId>` synthetic fallback", () => {
  test("is refused rather than awaited", async () => {
    // `handlePiInvoke` uses `host.currentConversationId ?? cross-ext-<id>`.
    // The synthetic branch produces a key no scope claims.
    const { status } = await runBounded(
      gateOpeningRunner(() => `cross-ext-${crypto.randomUUID()}`),
    );
    expect(status).toBe("awaiting_approval");
  });

  test("the executor pins its conversation id so the fallback cannot fire", async () => {
    const pinned: string[] = [];
    const runner: WorkflowToolRunner = {
      setCurrentUserId() {},
      setCurrentConversationId(id: string) {
        pinned.push(id);
      },
      async executeToolCall() {
        return ok("fine");
      },
    };
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const wf = new WorkflowExecutor(agentExec, bus, { toolRunnerFactory: () => runner });
    const run = await wf.runWorkflow(singleToolStep, {}, undefined, "u1");
    // Pinned BEFORE the first dispatch, so a reverse-RPC arriving at any
    // point resolves the scope key instead of minting a synthetic.
    expect(pinned).toEqual([workflowScopeKey(run.id)]);
  });
});

describe("escape 3: a STALE scope key from a run that already ended", () => {
  test("a `workflow-run:` id is unanswerable by construction and always refused", async () => {
    // Cross-run race: run B rebinds a shared subprocess's reverse-RPC
    // handler, then finishes and deregisters its scope. Run A's nested
    // call now resolves B's dead key — claimed by no live scope.
    const deadKey = `${NON_INTERACTIVE_KEY_PREFIX}${crypto.randomUUID()}`;
    const { status } = await runBounded(gateOpeningRunner(() => deadKey));
    expect(status).toBe("awaiting_approval");
  });

  test("refuses a stale workflow key even with no workflow running at all", async () => {
    const deadKey = `${NON_INTERACTIVE_KEY_PREFIX}${crypto.randomUUID()}`;
    const promptId = `p-${crypto.randomUUID()}`;
    await expect(
      createExtensionPermissionGate({
        promptId,
        conversationId: deadKey,
        userId: "u1",
        extensionId: "ext",
        toolName: "t",
        capabilityKind: "shell",
      }),
    ).rejects.toThrow(/requires interactive approval/);
    expect(getPendingApproval(promptId)).toBe(false);
  });

  test("a REAL conversation id outside any scope still parks normally", async () => {
    // The guard must not over-reach: an ordinary chat gate is unaffected.
    const promptId = `p-${crypto.randomUUID()}`;
    const gate = createExtensionPermissionGate({
      promptId,
      conversationId: `conv-${crypto.randomUUID()}`,
      userId: "u1",
      extensionId: "ext",
      toolName: "t",
      capabilityKind: "shell",
    });
    expect(getPendingApproval(promptId)).toBe(true);
    resolvePermission(promptId, true, "session");
    expect(await gate).toEqual({ allowed: true, scope: "session" });
  });
});

describe("the ambient scope does not outlive its run", () => {
  test("a chat gate opened AFTER the workflow finishes still parks", async () => {
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const wf = new WorkflowExecutor(agentExec, bus, {
      toolRunnerFactory: () => ({
        setCurrentUserId() {},
        setCurrentConversationId() {},
        async executeToolCall() {
          return ok("fine");
        },
      }),
    });
    await wf.runWorkflow(singleToolStep, {}, undefined, "u1");

    const promptId = `p-${crypto.randomUUID()}`;
    const gate = createExtensionPermissionGate({
      promptId,
      conversationId: `conv-${crypto.randomUUID()}`,
      userId: "u1",
      extensionId: "ext",
      toolName: "t",
      capabilityKind: "shell",
    });
    expect(getPendingApproval(promptId)).toBe(true);
    resolvePermission(promptId, false);
    expect(await gate).toEqual({ allowed: false });
  });
});

describe("scope teardown when runWorkflow throws before its try block", () => {
  test("a malformed definition does not leak the scope registration", async () => {
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const wf = new WorkflowExecutor(agentExec, bus, {
      toolRunnerFactory: () => ({
        setCurrentUserId() {},
        setCurrentConversationId() {},
        async executeToolCall() {
          return ok("x");
        },
      }),
    });
    // No `steps` — `runWorkflow` does no validation of its own, and the
    // dereference used to throw AFTER the scope was registered but
    // BEFORE the try/finally that deregisters it.
    const bad = { name: "bad", description: "" } as unknown as WorkflowDefinition;
    const run = await wf.runWorkflow(bad, {});

    // It now terminalizes as a normal failed run instead of rejecting...
    expect(run.status).toBe("error");
    // ...and no scope was left behind: an ordinary gate on a fresh key
    // still parks (a leaked ambient scope would refuse it instead).
    const promptId = `p-${crypto.randomUUID()}`;
    const gate = createExtensionPermissionGate({
      promptId,
      conversationId: `conv-${crypto.randomUUID()}`,
      userId: "u1",
      extensionId: "ext",
      toolName: "t",
      capabilityKind: "shell",
    });
    expect(getPendingApproval(promptId)).toBe(true);
    resolvePermission(promptId, false);
    expect(await gate).toEqual({ allowed: false });
  });
});
