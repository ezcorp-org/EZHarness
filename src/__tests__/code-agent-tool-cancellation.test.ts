import { expect, spyOn, test } from "bun:test";
import { AgentExecutor } from "../runtime/executor";
import { EventBus } from "../runtime/events";
import { loadAgentsStatic } from "../runtime/loader";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import * as permissionEngine from "../extensions/permission-engine";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { AgentEvents } from "../types";

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
