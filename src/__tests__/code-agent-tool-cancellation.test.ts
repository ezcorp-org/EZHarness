import { expect, spyOn, test } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import * as permissionEngine from "../extensions/permission-engine";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { AgentEvents } from "../types";
import type { InvocationGuard } from "../extensions/runtime-locks";

test("code-agent tools receive the same run signal and stop when the run is cancelled", async () => {
  const registry = ExtensionRegistry.getInstance();
  const tools = spyOn(registry, "getToolsForAgent").mockResolvedValue([{ name: "wait", description: "Wait", inputSchema: { type: "object" } }] as never);
  const policy = spyOn(permissionEngine, "getPermissionEngine").mockReturnValue(createStubPermissionEngine());
  let toolSignal: AbortSignal | undefined;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const context = spyOn(ToolExecutor.prototype, "createToolsContext").mockImplementation((_conversationId, _messageId, options?: { signal?: AbortSignal }) => {
    toolSignal = options?.signal;
    return { invoke: async () => new Promise<never>((_resolve, reject) => {
      entered();
      toolSignal!.addEventListener("abort", () => reject(toolSignal!.reason), { once: true });
    }) };
  });
  const bus = new EventBus<AgentEvents>();
  let runId = "";
  bus.on("run:start", event => { runId = event.runId; });
  const executor = new AgentExecutor(loadAgentsStatic([{ name: "code", description: "Code tool caller", capabilities: [], execute: async agent => {
    expect(agent.tools).toBeDefined();
    expect(toolSignal).toBe(agent.signal);
    await agent.tools!.invoke("wait", {});
    return { success: true, output: "Unexpected completion" };
  } }]), bus);
  try {
    const pending = executor.runAgent("code", { agentConfigId: "config" });
    await started;
    expect(executor.cancelRun(runId)).toBe(true);
    expect((await pending).status).toBe("cancelled");
    expect(toolSignal?.aborted).toBe(true);
    expect(context).toHaveBeenCalledTimes(1);
  } finally { executor.destroy(); context.mockRestore(); policy.mockRestore(); tools.mockRestore(); }
});

test("code-agent tools retain the exact upstream authority guard without accepting input authority", async () => {
  const registry = ExtensionRegistry.getInstance();
  const tools = spyOn(registry, "getToolsForAgent").mockResolvedValue([{ name: "write", description: "Write", inputSchema: { type: "object" } }] as never);
  const policy = spyOn(permissionEngine, "getPermissionEngine").mockReturnValue(createStubPermissionEngine());
  let revoked = false;
  let effects = 0;
  let received: InvocationGuard | undefined;
  const guard: InvocationGuard = async () => { if (revoked) throw new Error("release revoked"); };
  const context = spyOn(ToolExecutor.prototype, "createToolsContext").mockImplementation((_conversationId, _messageId, options) => {
    received = options?.invocationGuard;
    return { invoke: async () => { await options?.invocationGuard?.(); effects++; return "written"; } };
  });
  const executor = new AgentExecutor(loadAgentsStatic([{ name: "code", description: "Guarded", capabilities: [], execute: async agent => {
    await agent.tools!.invoke("write", {});
    revoked = true;
    await agent.tools!.invoke("write", {});
    return { success: true, output: "Unexpected completion" };
  } }]), new EventBus<AgentEvents>());
  try {
    const run = await executor.runAgent("code", { agentConfigId: "config", invocationGuard: "attacker-controlled" }, undefined, undefined, undefined, { invocationGuard: guard });
    expect(received).toBe(guard);
    expect(effects).toBe(1);
    expect(run.status).toBe("error");
    expect(run.result?.error).toBe("release revoked");
  } finally { executor.destroy(); context.mockRestore(); policy.mockRestore(); tools.mockRestore(); }
});

test("code-agent file, shell and nested effects recheck the parent release", async () => {
  for (const effect of ["file", "shell", "nested"] as const) {
    let revoked = false;
    const effects: string[] = [];
    const executor = new AgentExecutor(loadAgentsStatic([
      { name: "parent", description: "Parent", capabilities: [], execute: async agent => {
        revoked = true;
        if (effect === "file") await agent.file.write("out", "data");
        if (effect === "shell") await agent.shell.run("command");
        if (effect === "nested") await agent.run("child", {});
        return { success: true, output: null };
      } },
      { name: "child", description: "Child", capabilities: [], execute: async () => { effects.push("child"); return { success: true, output: null }; } },
    ]), new EventBus<AgentEvents>(), {
      shell: { run: async () => { effects.push("shell"); return { stdout: "", stderr: "", exitCode: 0 }; } },
      file: { read: async () => "", exists: async () => false, write: async () => { effects.push("file"); } },
    });
    try {
      const run = await executor.runAgent("parent", {}, undefined, undefined, undefined, { invocationGuard: async () => { if (revoked) throw new Error("release revoked"); } });
      expect(run.status).toBe("error");
      expect(run.result?.error).toBe("release revoked");
      expect(effects).toEqual([]);
    } finally { executor.destroy(); }
  }
});
