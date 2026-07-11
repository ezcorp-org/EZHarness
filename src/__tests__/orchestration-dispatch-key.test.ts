/**
 * Regression test for the pre-existing dispatch-key P0 (found during the
 * Phase B2 hardening loop): orchestration wires its AgentTools with the BARE
 * `originalName` (so subscribe-bridge event-suppression, auto-spin-up, the
 * ORCHESTRATION_TOOLS filter, and the orchestrator prompt all key on the
 * bare name), but the registry's `toolMap` is keyed by the NAMESPACED name
 * (`<ext>__<tool>`). Before the fix, `extensionToAgentTool`'s execute closure
 * called `executeToolCall(bareName)` → `getRegisteredTool(bareName)` → null →
 * "Unknown tool: invoke_agent". Every prior test masked this: orchestration-e2e
 * STUBBED getRegisteredTool to resolve the bare name; the integration test
 * talks JSON-RPC straight to the subprocess; unit tests call the ext handler
 * function directly. This test drives the REAL ExtensionRegistry keying (no
 * stubbed getRegisteredTool) and mocks only the subprocess boundary
 * (registry.getProcess / proc.callTool).
 */

import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// DB out of scope — swallow recordToolCall inserts + failure bookkeeping so the
// real ToolExecutor + registry never touch a live DB.
mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => {} }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  }),
}));
mock.module("../db/queries/extensions", () => ({
  listExtensions: async () => [],
  disableExtension: async () => {},
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

import type { RegisteredTool } from "../extensions/registry";
import type { ToolCallResult } from "../extensions/types";
const { ExtensionRegistry } = await import("../extensions/registry");
const { ToolExecutor, extensionToAgentTool, _resetToolCallsCounterForTests } = await import(
  "../extensions/tool-executor"
);
const { createStubPermissionEngine } = await import("./helpers/permission-engine-stub");

afterEach(() => {
  restoreModuleMocks();
});

const NS_NAME = "orchestration__invoke_agent";
const BARE_NAME = "invoke_agent";
const EXT_ID = "orch-ext-probe";

function seedRegistry(opts: { originalName?: string; bundled?: boolean } = {}): {
  registry: InstanceType<typeof ExtensionRegistry>;
  callToolNames: string[];
  callToolOptions: Array<{ skipTimeout?: boolean } | undefined>;
} {
  const originalName = opts.originalName ?? BARE_NAME;
  const nsName = `orchestration__${originalName}`;
  const registry = ExtensionRegistry.getInstance();
  // The REAL reload keys toolMap by the namespaced name (registry.ts:408).
  registry.registerToolForTest(nsName, {
    name: nsName,
    originalName,
    extensionId: EXT_ID,
    extensionName: "orchestration",
    description: "Invoke a sub-agent.",
    inputSchema: { type: "object" },
  } as RegisteredTool);
  registry.setManifestForTest(EXT_ID, {
    schemaVersion: 2,
    name: "orchestration",
    version: "1.0.0",
    description: "o",
    author: { name: "t" },
    entrypoint: "./index.ts",
    tools: [{ name: originalName, description: "", inputSchema: { type: "object" } }],
    permissions: {},
  } as never);
  registry.setGrantedPermsForTest(EXT_ID, { grantedAt: {} });
  // isBundled is set at reload; drive it explicitly for the skipTimeout gate.
  spyOn(registry, "isBundled").mockImplementation((id: string) => opts.bundled === true && id === EXT_ID);

  // Mock ONLY the subprocess boundary: a fake process that records the tool
  // name + the per-call options ({ skipTimeout }) it was dispatched with.
  const callToolNames: string[] = [];
  const callToolOptions: Array<{ skipTimeout?: boolean } | undefined> = [];
  const fakeProc = {
    callTool: async (
      name: string,
      _args: Record<string, unknown>,
      _meta?: Record<string, unknown>,
      options?: { skipTimeout?: boolean },
    ): Promise<ToolCallResult> => {
      callToolNames.push(name);
      callToolOptions.push(options);
      return { content: [{ type: "text", text: "sub-agent result" }], isError: false };
    },
    setRequestHandler: () => {},
    isRunning: true,
    kill: () => {},
  };
  spyOn(registry, "getProcess").mockResolvedValue(fakeProc as never);
  return { registry, callToolNames, callToolOptions };
}

describe("orchestration dispatch-key (real registry keying)", () => {
  beforeEach(() => {
    _resetToolCallsCounterForTests();
    ExtensionRegistry.resetInstance();
  });
  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("real registry keys toolMap by the NAMESPACED name; the bare name does NOT resolve", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest(NS_NAME, {
      name: NS_NAME, originalName: BARE_NAME, extensionId: EXT_ID,
      extensionName: "orchestration", description: "", inputSchema: {},
    } as RegisteredTool);
    expect(registry.getRegisteredTool(NS_NAME)).not.toBeNull();
    expect(registry.getRegisteredTool(BARE_NAME)).toBeNull();
  });

  test("bare AgentTool name + namespaced dispatchName → resolves, dispatches with originalName (NOT 'Unknown tool')", async () => {
    const { registry, callToolNames } = seedRegistry();
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));

    // Exactly how wireOrchestrationToolsForTurn wires it post-fix: LLM-visible
    // name is bare, dispatchName is the namespaced registry key.
    const agentTool = extensionToAgentTool(
      { name: BARE_NAME, description: "", inputSchema: {}, dispatchName: NS_NAME },
      exec, "conv-1", "msg-1",
    );
    const result = await agentTool.execute("call-1", { agentConfigId: "a1", task: "t" }, new AbortController().signal);

    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).not.toContain("Unknown tool");
    expect(text).toBe("sub-agent result");
    expect((result.details as { isError?: boolean }).isError).toBe(false);
    // Subprocess is dispatched with the ORIGINAL (bare) tool name — the
    // subprocess registers its handlers under bare names.
    expect(callToolNames).toEqual([BARE_NAME]);
  });

  test("NEGATIVE control: bare name WITHOUT dispatchName → 'Unknown tool' (reproduces the pre-fix bug)", async () => {
    const { registry, callToolNames } = seedRegistry();
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));

    // The pre-fix wiring: bare name, no dispatchName → executeToolCall(bare) →
    // getRegisteredTool(bare) → null.
    const agentTool = extensionToAgentTool(
      { name: BARE_NAME, description: "", inputSchema: {} },
      exec, "conv-1", "msg-1",
    );
    const result = await agentTool.execute("call-1", {}, new AbortController().signal);

    const text = (result.content?.[0] as { text?: string })?.text ?? "";
    expect(text).toContain("Unknown tool");
    expect(text).toContain(BARE_NAME);
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    // Never reached the subprocess.
    expect(callToolNames).toEqual([]);
  });
});

// ── F2: long-blocking subprocess skipTimeout (host-controlled) ─────
//
// A blocking invoke_agent/collect exceeding the subprocess's 30s callTimeoutMs
// kills the SHARED subprocess (dropping every backgroundSpawn + in-flight
// invoke). The fix: dispatch these tools with `{ skipTimeout: true }` — but ONLY
// for BUNDLED extensions, so a third-party manifest can't self-grant supervision
// evasion.

describe("long-blocking subprocess skipTimeout (F2)", () => {
  function wire(exec: InstanceType<typeof ToolExecutor>, originalName: string) {
    return extensionToAgentTool(
      {
        name: originalName,
        description: "",
        inputSchema: {},
        dispatchName: `orchestration__${originalName}`,
      },
      exec, "conv-1", "msg-1",
    );
  }

  test("bundled invoke_agent → dispatched with { skipTimeout: true }", async () => {
    const { registry, callToolOptions } = seedRegistry({ originalName: "invoke_agent", bundled: true });
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
    await wire(exec, "invoke_agent").execute("c1", { agentConfigId: "a1", task: "t" }, new AbortController().signal);
    expect(callToolOptions[0]?.skipTimeout).toBe(true);
  });

  test("bundled collect_agent_result → dispatched with { skipTimeout: true }", async () => {
    const { registry, callToolOptions } = seedRegistry({ originalName: "collect_agent_result", bundled: true });
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
    await wire(exec, "collect_agent_result").execute("c1", { assignmentId: "a1" }, new AbortController().signal);
    expect(callToolOptions[0]?.skipTimeout).toBe(true);
  });

  test("SELF-GRANT PROTECTION: a NON-bundled ext with the same tool name does NOT get skipTimeout", async () => {
    const { registry, callToolOptions } = seedRegistry({ originalName: "invoke_agent", bundled: false });
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
    await wire(exec, "invoke_agent").execute("c1", {}, new AbortController().signal);
    // Normal 3-arg dispatch → no options object → subject to the 30s kill.
    expect(callToolOptions[0]).toBeUndefined();
  });

  test("a BUNDLED tool NOT in the long-blocking set → no skipTimeout", async () => {
    const { registry, callToolOptions } = seedRegistry({ originalName: "some_other_tool", bundled: true });
    const exec = new ToolExecutor(registry, createStubPermissionEngine("allow-all"));
    await wire(exec, "some_other_tool").execute("c1", {}, new AbortController().signal);
    expect(callToolOptions[0]).toBeUndefined();
  });
});
