import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import type { AgentContext, AgentDefinition, FileProvider, ShellProvider } from "../types";

mockDbConnection();
const { workflowServiceReleaseFixture } = await import("./helpers/workflow-service-release");
const { createHostServiceInvocation, createServiceInvocation } = await import("../extensions/service-invocation");
const { insertWorkflowRun } = await import("../db/queries/workflow-runs");
const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
const { AgentExecutor } = await import("../runtime/executor");
const { EventBus } = await import("../runtime/events");
const { loadAgentsStatic } = await import("../runtime/loader");
const helpers = await import("../runtime/executor-helpers");
const { upsertSetting } = await import("../db/queries/settings");
const { workflowDelegations, workflowRuns } = await import("../db/schema");

beforeEach(setupTestDb);
afterAll(closeTestDb);

async function service() {
  const { release, authority } = await workflowServiceReleaseFixture();
  await insertWorkflowRun({ id: "service-run", workflowName: release.entry.definition.name, definitionHash: workflowExecutionHash(release.entry.definition, release.entry.extensionRelease), startedAt: new Date(), input: {}, userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation" });
  return createServiceInvocation(release.entry, authority, "service-run");
}

async function hostService() {
  const { db, authority } = await workflowServiceReleaseFixture();
  const definition = { name: "legacy-host", description: "Host workflow", steps: [] };
  const entry: import("../runtime/workflow-scope").CachedWorkflow = { definition, source: "yaml", visibility: "system", id: null, userId: null, projectId: null, forkedFrom: null };
  await insertWorkflowRun({ id: "service-run", workflowName: definition.name, definitionHash: workflowExecutionHash(definition), startedAt: new Date(), input: {}, userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation" });
  await db.update(workflowDelegations).set({ workflowName: definition.name, extensionReleaseBinding: null }).where(eq(workflowDelegations.id, "delegation"));
  await db.update(workflowRuns).set({ workflowName: definition.name, definitionHash: workflowExecutionHash(definition) }).where(eq(workflowRuns.id, "service-run"));
  return createHostServiceInvocation(entry, authority, "service-run");
}

const serviceKinds = [["sealed", service], ["host", hostService]] as const;

const calls: Array<[string, (context: AgentContext) => Promise<unknown>]> = [
  ["file.read", context => context.file.read("/host/private")],
  ["file.write", context => context.file.write("/host/private", "overwrite")],
  ["file.exists", context => context.file.exists("/host/private")],
  ["shell", context => context.shell.run("printf host-effect")],
  ["llm.complete", context => context.llm.complete([])],
  ["llm.stream", async context => { for await (const event of context.llm.stream([])) return event; return undefined; }],
];

test.each(serviceKinds.flatMap(([kind, factory]) => calls.map(([name, call]) => [kind, name, factory, call] as const)))("actual %s service AgentExecutor denies direct %s before host adapter access", async (_kind, _name, factory, call) => {
  const proof = await factory();
  let effects = 0;
  const file: FileProvider = { read: async () => { effects++; return "host-secret"; }, write: async () => { effects++; }, exists: async () => { effects++; return true; } };
  const shell: ShellProvider = { run: async () => { effects++; return { stdout: "host-effect", stderr: "", exitCode: 0 }; } };
  const llm = spyOn(helpers, "createPiLlmAdapter").mockReturnValue({ complete: async () => { effects++; return { text: "host-provider", usage: { inputTokens: 1, outputTokens: 1 } }; }, async *stream() { effects++; yield { type: "token", text: "host-provider" }; } });
  const agent: AgentDefinition = { name: "direct", description: "Direct adapter caller", capabilities: ["file", "shell", "llm"], execute: async context => ({ success: true, output: await call(context) }) };
  const executor = new AgentExecutor(loadAgentsStatic([agent]), new EventBus(), { file, shell });
  try {
    const run = await executor.runAgent("direct", {}, undefined, undefined, undefined, { serviceInvocation: proof });
    expect(run.status).toBe("error");
    expect(run.result?.error).toContain("Use an approved extension tool");
    expect(effects).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  } finally { executor.destroy(); proof.close(); llm.mockRestore(); }
});

test.each(serviceKinds)("%s service agents receive explicit input, never ambient account defaults", async (_kind, factory) => {
  const proof = await factory();
  await upsertSetting("providerCredential", "host-secret");
  const executor = new AgentExecutor(loadAgentsStatic([{ name: "inspect", description: "Inspect input", capabilities: [], execute: async context => ({ success: true, output: context.input }) }]), new EventBus(), { persist: true });
  try {
    const run = await executor.runAgent("inspect", { supplied: "explicit" }, undefined, undefined, undefined, { serviceInvocation: proof });
    expect(run.result?.output).toEqual({ supplied: "explicit" });
  } finally { executor.destroy(); proof.close(); }
});

test("service adapter authority rejects forged, human, project-mismatched and closed proofs", async () => {
  const proof = await service();
  let executions = 0;
  const executor = new AgentExecutor(loadAgentsStatic([{ name: "inspect", description: "Inspect", capabilities: [], execute: async () => { executions++; return { success: true, output: null }; } }]), new EventBus());
  try {
    await expect(executor.runAgent("inspect", {}, undefined, undefined, undefined, { serviceInvocation: { ...proof } })).rejects.toThrow();
    await expect(executor.runAgent("inspect", {}, undefined, "owner", undefined, { serviceInvocation: proof })).rejects.toThrow();
    await expect(executor.runAgent("inspect", {}, "foreign", undefined, undefined, { serviceInvocation: proof })).rejects.toThrow();
    proof.close();
    await expect(executor.runAgent("inspect", {}, undefined, undefined, undefined, { serviceInvocation: proof })).rejects.toThrow();
    expect(executions).toBe(0);
  } finally { executor.destroy(); }
});

test("ordinary user agents retain their direct adapters and account defaults", async () => {
  await upsertSetting("ordinaryDefault", "retained");
  const file: FileProvider = { read: async () => "user-file", write: async () => undefined, exists: async () => true };
  const executor = new AgentExecutor(loadAgentsStatic([{ name: "ordinary", description: "User adapter", capabilities: ["file"], execute: async context => ({ success: true, output: { input: context.input, file: await context.file.read("/user") } }) }]), new EventBus(), { persist: true, file });
  try {
    const run = await executor.runAgent("ordinary", { explicit: true });
    expect(run.status).toBe("success");
    expect(run.result?.output).toEqual({ input: { ordinaryDefault: "retained", explicit: true }, file: "user-file" });
  } finally { executor.destroy(); }
});

test.each(serviceKinds)("nested %s service agents retain the same proof and cannot regain host adapters", async (_kind, factory) => {
  const proof = await factory();
  let hostReads = 0;
  const file: FileProvider = { read: async () => { hostReads++; return "host-secret"; }, write: async () => undefined, exists: async () => true };
  const executor = new AgentExecutor(loadAgentsStatic([
    { name: "parent", description: "Parent", capabilities: ["agent"], execute: context => context.run("child", { explicit: "child" }) },
    { name: "child", description: "Child", capabilities: ["file"], execute: async context => {
      expect(context.input).toEqual({ explicit: "child" });
      return { success: true, output: await context.file.read("/host/private") };
    } },
  ]), new EventBus(), { file });
  try {
    const run = await executor.runAgent("parent", {}, undefined, undefined, undefined, { serviceInvocation: proof });
    expect(run.result?.success).toBe(false);
    expect(run.result?.error).toContain("Use an approved extension tool");
    expect(hostReads).toBe(0);
  } finally { executor.destroy(); proof.close(); }
});
