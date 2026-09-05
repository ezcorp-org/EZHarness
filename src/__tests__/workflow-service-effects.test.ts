import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";

mockDbConnection();
const { workflowServiceReleaseFixture } = await import("./helpers/workflow-service-release");
const { WorkflowExecutor } = await import("../runtime/workflow-executor");
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { loadAgentsStatic } = await import("../runtime/loader");
const { ToolExecutor } = await import("../extensions/tool-executor");
const { ReleaseProcess } = await import("../extensions/release-process");
const { ExtensionRegistry } = await import("../extensions/registry");
const permissionEngine = await import("../extensions/permission-engine");
const { workflowDelegations } = await import("../db/schema");
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
beforeEach(setupTestDb);
afterAll(closeTestDb);

test.each([
  { kind: "tool", state: "allowed" }, { kind: "agent", state: "allowed" },
  { kind: "tool", state: "wrong-service" }, { kind: "agent", state: "wrong-service" },
  { kind: "tool", state: "revoked" }, { kind: "agent", state: "revoked" },
] as const)("service workflow %j retains its real principal and fails closed", async ({ kind, state }) => {
  const { db, release } = await workflowServiceReleaseFixture({ invoke: async () => ({ content: [{ type: "text", text: "{}" }], isError: false }) });
  await db.update(workflowDelegations).set({ capabilitySet: [{ kind: "tool", value: "observe" }] }).where(eq(workflowDelegations.id, "delegation"));
  if (state === "revoked") await db.update(workflowDelegations).set({ revokedAt: new Date() }).where(eq(workflowDelegations.id, "delegation"));
  release.entry.definition.steps = kind === "tool" ? [{ name: "observe", kind: "tool", tool: "observe" }] : [{ name: "observe", kind: "agent", agent: "service-agent", input: { agentConfigId: "config" } }];
  const tool = { name: "observe", description: "Observe principal", inputSchema: { type: "object" as const }, outputSchema: { type: "object" as const } };
  release.snapshot.release.manifest.tools = [tool];
  const process = new ReleaseProcess("installation");
  const registry = {
    getRegisteredTool: () => ({ ...tool, originalName: "observe", extensionId: "installation" }),
    getManifest: () => release.snapshot.release.manifest,
    getGrantedPermissions: () => ({ grantedAt: {} }),
    getProcess: () => process,
    getToolsForAgent: async () => [tool],
  } as unknown as import("../extensions/registry").ExtensionRegistry;
  const bus = new EventBus<import("../types").AgentEvents>();
  const policy = permissionEngine.createPermissionEngine({ registry, bus, db: {} });
  const decisions = spyOn(policy, "authorize");
  const instance = spyOn(ExtensionRegistry, "getInstance").mockReturnValue(registry);
  const engine = spyOn(permissionEngine, "getPermissionEngine").mockReturnValue(policy);
  const agentExecutor = new AgentExecutor(loadAgentsStatic([{ name: "service-agent", description: "Service caller", capabilities: [], execute: async context => ({ success: true, output: await context.tools!.invoke("observe", {}) }) }]), bus, { persist: true });
  const executor = new WorkflowExecutor(agentExecutor, bus, { persist: true, toolRunnerFactory: () => new ToolExecutor(registry, policy) });
  registerWorkflowRuntime({ getWorkflows: () => [release.entry.definition], getCachedWorkflows: () => [release.entry], workflowExecutor: executor });
  try {
    const pending = executor.runWorkflow(release.entry.definition, { userId: "owner", runAsKind: "user" }, undefined, undefined, undefined, { runAsKind: "service", runAs: state === "wrong-service" ? "foreign" : "service", delegationId: "delegation" });
    if (state === "allowed") {
      const result = await pending;
      expect(result.result).toEqual(expect.objectContaining({ success: true }));
      expect(release.calls[0]?.context.principalId).toBe("service");
      expect(decisions.mock.calls.every(([context]) => context.userId === null)).toBe(true);
    } else {
      await expect(pending).rejects.toThrow("authority is no longer available");
      expect(release.calls).toEqual([]);
      expect(decisions.mock.calls).toEqual([]);
    }
  } finally { _resetWorkflowRuntimeForTests(); agentExecutor.destroy(); decisions.mockRestore(); engine.mockRestore(); instance.mockRestore(); }
});
