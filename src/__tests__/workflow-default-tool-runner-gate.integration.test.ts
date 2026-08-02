/**
 * Regression: the WorkflowExecutor's DEFAULT tool-runner factory must
 * forward the per-run pending-permission gate.
 *
 * `WorkflowToolRunnerFactory` declares `(pendingPermissions?) => …`, but a
 * zero-argument arrow satisfies it — TypeScript lets a function ignore
 * parameters — so a default of `() => createWorkflowToolRunner(this.bus)`
 * type-checks while silently dropping the gate. Production takes exactly
 * that default (`web/src/lib/server/context.ts` and `src/cli.ts` construct
 * with only `{ persist: true }`), so `setPendingPermissionGate` was never
 * called on a real workflow run: an INTERACTIVE run's consent card was
 * invisible to the run watchdog, which reads `host.pendingPermissions` and
 * nothing else, and the surrounding turn was killed at the `callTimeoutMs`
 * ceiling before the user could answer — the "stuck chat" defect.
 *
 * Injecting a fake factory (workflow-tool-step.test.ts) cannot see this,
 * because the fake replaces the very code under test. This file therefore
 * uses NO `toolRunnerFactory` and drives the real `createWorkflowToolRunner`
 * → real `ToolExecutor` → real PDP-prompt branch, asserting the gate is
 * REACHED: `register(promptId)` fires before the gate suspends and
 * `deregister(promptId)` fires on the way out.
 */
import { afterAll, describe, expect, test, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// The tool path funnels analytics rows through these; stub them so the
// test needs no DB. Same narrow pair as
// `extension-sensitive-cap-pending-permission.integration.test.ts`.
mock.module("../db/queries/tool-calls", () => ({
  persistToolCall: async () => {},
  listToolCallOutputsForMessages: async () => [],
  getToolCallConversationById: async () => null,
}));
mock.module("../db/connection", () => ({
  getDb: () => ({
    update: () => ({ set: () => ({ where: async () => {} }) }),
    // The observability sink writes a row on the tool-error path; without
    // this it logs a loud (harmless) failure that would bury a real one.
    insert: () => ({ values: () => ({ returning: async () => [{ id: "obs-1" }] }) }),
  }),
}));

const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { loadAgentsStatic } = await import("../runtime/loader");
const { ExtensionRegistry } = await import("../extensions/registry");
const { _setPermissionEngineForTests, _resetPermissionEngineForTests } = await import(
  "../extensions/permission-engine"
);
// NOT mocked — the SUT and the test share this module's `pendingApprovals`
// singleton, so the test can answer the very gate the run parked on.
const { resolvePermission, getPendingApproval } = await import("../runtime/tools/permissions");

import type { PermissionEngine } from "../extensions/permission-engine";
import type { ExtensionRegistry as ExtensionRegistryType } from "../extensions/registry";
import type { AgentEvents, WorkflowDefinition } from "../types";

const TOOL = "ext-1__create_extension";

const SINGLE_TOOL_STEP: WorkflowDefinition = {
  name: "wf-gate",
  description: "",
  steps: [{ name: "call", kind: "tool", tool: TOOL }],
};

/** PDP that always returns a fresh `prompt` for a sensitive `fs.write`
 *  cap — the exact decision shape `create_extension` produces. */
function makePromptEngine(): { engine: PermissionEngine; lastPromptId: () => string } {
  let last = "";
  const engine = {
    async authorize() {
      last = `prompt-${crypto.randomUUID()}`;
      return {
        decision: "prompt" as const,
        promptId: last,
        auditId: "audit-x",
        sensitive: { kind: "fs.write", value: "/p" },
      };
    },
    async resolvePrompt() {},
    _resetCacheForTests() {},
  } as unknown as PermissionEngine;
  return { engine, lastPromptId: () => last };
}

/** Registry the real `createWorkflowToolRunner` will pick up via
 *  `ExtensionRegistry.getInstance()`. `getProcess` throws so no subprocess
 *  is ever spawned; the prompt branch is reached long before it. */
function stubRegistry(): ExtensionRegistryType {
  return {
    getRegisteredTool: () => ({
      extensionId: "ext-1",
      originalName: "create_extension",
      inputSchema: { type: "object", properties: {} },
    }),
    getManifest: () => ({ tools: [{ name: "create_extension" }] }),
    getProcess: async () => {
      throw new Error("no subprocess in this test");
    },
  } as unknown as ExtensionRegistryType;
}

/** Spin the microtask queue until `pred` holds or the budget runs out.
 *  Bounded so a REGRESSION fails the assertion instead of hanging the
 *  suite (the whole point of the discrimination check). */
async function until(pred: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns && !pred(); i++) {
    await new Promise<void>((r) => queueMicrotask(r));
  }
}

describe("WorkflowExecutor default tool-runner factory ↔ pending-permission gate", () => {
  test("an INTERACTIVE run's gate reaches the real ToolExecutor's prompt branch", async () => {
    _resetPermissionEngineForTests();
    const { engine, lastPromptId } = makePromptEngine();
    _setPermissionEngineForTests(engine);
    const getInstance = ExtensionRegistry.getInstance;
    ExtensionRegistry.getInstance = (() => stubRegistry()) as typeof getInstance;

    const registered: string[] = [];
    const deregistered: string[] = [];

    try {
      const bus = new EventBus<AgentEvents>();
      const executor = new AgentExecutor(loadAgentsStatic([]), bus);
      // No `toolRunnerFactory` — THE POINT. This is the production
      // construction shape (`{ persist: … }` only).
      const wf = new WorkflowExecutor(executor, bus);

      const runPromise = wf.runWorkflow(SINGLE_TOOL_STEP, {}, undefined, "u1", undefined, {
        conversationId: `conv-${crypto.randomUUID()}`,
        pendingPermissions: {
          register: (key) => {
            registered.push(key);
          },
          deregister: (key) => {
            deregistered.push(key);
          },
        },
      });

      // The gate parks (interactive: no non-interactive scope refuses it),
      // so wait for the prompt to be live rather than awaiting the run.
      await until(() => lastPromptId() !== "" && getPendingApproval(lastPromptId()) !== undefined);
      const promptId = lastPromptId();
      expect(promptId).not.toBe("");

      // THE CLAIM: register() ran BEFORE the gate suspended, keyed by the
      // PDP's own promptId — so the watchdog can see this wait.
      expect(registered).toEqual([promptId]);
      expect(deregistered).toEqual([]);

      // Answering the card is what proves a human was actually reachable
      // on this path; a decline is a failure, so the run terminalizes
      // `error` rather than `awaiting_approval`.
      resolvePermission(promptId, false);
      const run = await runPromise;

      expect(deregistered).toEqual([promptId]);
      expect(run.status).toBe("error");
    } finally {
      ExtensionRegistry.getInstance = getInstance;
      _resetPermissionEngineForTests();
    }
  });
});
