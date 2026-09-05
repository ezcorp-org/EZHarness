import { afterAll, beforeEach, expect, test } from "bun:test";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease, ReleaseRuntimeDependencies } from "../extensions/release-process";
import { executionLimits } from "@ezcorp/extension-runner";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";
import type { CachedWorkflow } from "../runtime/workflow-scope";
import type { WorkflowDefinition } from "../types";

mockDbConnection();
const { loadReleaseWorkflowEntries: loadSealedWorkflowEntries, workflowReleaseIsCurrent, workflowReleaseCanAccess, filterAccessibleWorkflowEntries } = await import("../runtime/workflow-release-assets");
const { configureReleaseRuntime, getReleaseRuntime } = await import("../extensions/release-process");
const { users, projects, projectMembers, extensions } = await import("../db/schema");
beforeEach(async () => { await setupTestDb(); });
afterAll(closeTestDb);

async function loadReleaseWorkflowEntries(registry: Parameters<typeof loadSealedWorkflowEntries>[0], runtime = getReleaseRuntime()) {
  return loadSealedWorkflowEntries(registry, runtime, async installationId => {
    const snapshot = await runtime.resolve(installationId);
    return (await runtime.runner()).collectArtifacts(snapshot!.release.artifactDigest);
  });
}

async function fixture() {
  const files = { "deploy.workflow.yaml": "name: deploy\ndescription: sealed\nsteps:\n  - name: emit\n    kind: transform\n    output:\n      hello: world\n" };
  const snapshot: ActiveExtensionRelease = {
    installation: { id: "installation", ownerId: "owner", scope: "global", activeReleaseId: "release", generation: 1, acknowledgedGeneration: 1, enabled: true, status: "active", uninstalled: false, grants: [] },
    release: { id: "release", installationId: "installation", workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "c".repeat(64), imageDigest: "d".repeat(64), runnerProfile: "test", createdAt: new Date(0).toISOString(), evidence: { protocolVersion: 4, validatorVersion: "test", tests: [], discoveryDigest: "e".repeat(64) }, artifactDigest: await sha256(canonicalJson(files)), releaseDigest: "a".repeat(64), policyDigest: "b".repeat(64), manifest: { schemaVersion: 4, name: "sealed", version: "1.0.0", description: "sealed", author: { name: "Owner" }, entrypoint: "extension.ts", permissions: {}, tools: [] } },
    limits: executionLimits,
  };
  const runtime = { resolve: async () => snapshot, runner: async () => ({ collectArtifacts: async () => files }) } as unknown as ReleaseRuntimeDependencies;
  const registry = { getAllManifests: () => new Map([["installation", snapshot.release.manifest]]).entries() };
  configureReleaseRuntime(runtime);
  return { files, snapshot, runtime, registry };
}

async function claimedReleaseRun(entry: CachedWorkflow, userId: string | null = "owner", projectId: string | null = null) {
  const { insertWorkflowRun, suspendWorkflowRun, claimWorkflowRun } = await import("../db/queries/workflow-runs");
  const id = crypto.randomUUID();
  await insertWorkflowRun({ id, workflowName: entry.definition.name, input: {}, startedAt: new Date(), userId, projectId });
  await suspendWorkflowRun(id, { reason: "manual", cursor: { batchIndex: 0, completedSteps: [], prevStepName: null } });
  expect(await claimWorkflowRun({ workflowRunId: id, claimedBy: "release-test", now: new Date() })).toBe(true);
  return id;
}

test("shared resume checks the persisted principal and current release before dispatch", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values(["owner", "stranger"].map(id => ({ id, email: `${id}@test.invalid`, passwordHash: "h", name: id })));
  const [entry] = await loadReleaseWorkflowEntries(setup.registry);
  const { resumeClaimedRun } = await import("../runtime/workflow-executor");
  const { getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const calls: WorkflowDefinition[] = [];
  const executor = { resumeWorkflow: async (definition: WorkflowDefinition, row: { id: string }) => {
    calls.push(definition);
    return { id: row.id, workflowName: definition.name, status: "suspended" as const, startedAt: 0, steps: [] };
  } };
  const allowed = await claimedReleaseRun(entry!);
  expect((await resumeClaimedRun(executor, entry!.definition, allowed, "release-test", undefined, entry)).result).toBeUndefined();
  expect(calls).toEqual([entry!.definition]);
  for (const denial of ["stranger", "unowned", "unacknowledged", "disabled", "replacement", "identity"] as const) {
    setup.snapshot.installation.enabled = denial !== "disabled";
    setup.snapshot.installation.acknowledgedGeneration = denial === "unacknowledged" ? 0 : 1;
    setup.snapshot.installation.generation = denial === "replacement" ? 2 : 1;
    const id = await claimedReleaseRun(entry!, denial === "stranger" ? "stranger" : denial === "unowned" ? null : "owner");
    const definition = denial === "identity" ? structuredClone(entry!.definition) : entry!.definition;
    const result = await resumeClaimedRun(executor, definition, id, "release-test", undefined, entry);
    expect(result.result?.error).toMatchObject({ code: "not-resumable" });
    expect((await getWorkflowRunRow(id))?.status).toBe("suspended");
  }
  expect(calls).toHaveLength(1);
});

test("shared resume denies a lost project membership and does not substitute flat definitions", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values({ id: "owner", email: "owner@test.invalid", passwordHash: "h", name: "Owner" });
  await getTestDb().insert(projects).values({ id: "project", name: "Project", path: "/tmp/project" });
  await getTestDb().insert(projectMembers).values({ userId: "owner", projectId: "project", role: "member" });
  setup.snapshot.installation.scope = "project:project";
  const [entry] = await loadReleaseWorkflowEntries(setup.registry);
  const { resumeClaimedRun } = await import("../runtime/workflow-executor");
  const { workflowResumeEntry, registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
  const executor = { resumeWorkflow: async () => { throw new Error("Denied workflow must not run"); }, runWorkflow: async () => { throw new Error("Cannot start a new workflow"); } };
  const runtime = { getWorkflows: () => [{ ...entry!.definition, description: "replacement" }], getCachedWorkflows: () => [entry!], workflowExecutor: executor };
  expect(workflowResumeEntry(runtime, entry!.definition.name)).toBe(entry);
  expect(workflowResumeEntry(runtime, "missing")).toBeUndefined();
  registerWorkflowRuntime(runtime);
  try {
    const id = await claimedReleaseRun(entry!, "owner", "project");
    await getTestDb().delete(projectMembers).where(eq(projectMembers.userId, "owner"));
    expect((await resumeClaimedRun(executor, entry!.definition, id, "release-test")).result?.error).toMatchObject({ code: "not-resumable" });
    runtime.getCachedWorkflows = () => [];
    const missing = await claimedReleaseRun(entry!);
    expect((await resumeClaimedRun(executor, entry!.definition, missing, "release-test")).result?.error).toMatchObject({ code: "not-resumable" });
  } finally { _resetWorkflowRuntimeForTests(); }
  const unbound = await claimedReleaseRun(entry!);
  expect((await resumeClaimedRun(executor, entry!.definition, unbound, "release-test")).result?.error).toMatchObject({ code: "not-resumable" });
});

test("real restart resume pins the original release even when replacement graph bytes match", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values({ id: "owner", email: "owner@test.invalid", passwordHash: "h", name: "Owner" });
  const { WorkflowExecutor, WorkflowSuspendedError, resumeClaimedRun } = await import("../runtime/workflow-executor");
  const { AgentExecutor } = await import("../runtime/executor");
  const { EventBus } = await import("../runtime/events");
  const { loadAgentsStatic } = await import("../runtime/loader");
  const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
  const { claimWorkflowRun, getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const { workflowDefinitionHash, workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
  const { workflowRuns } = await import("../db/schema");
  for (const mode of ["same", "replacement", "legacy-null", "legacy-graph"] as const) {
    setup.snapshot.installation.generation = 1;
    setup.snapshot.installation.acknowledgedGeneration = 1;
    let entries = await loadReleaseWorkflowEntries(setup.registry);
    const bus = new EventBus<import("../types").AgentEvents>();
    const agents = new AgentExecutor(loadAgentsStatic([]), bus);
    const original = new WorkflowExecutor(agents, bus, { persist: true, stepSubstitute: () => { throw new WorkflowSuspendedError("emit", "manual"); } });
    registerWorkflowRuntime({ getWorkflows: () => entries.map(entry => entry.definition), getCachedWorkflows: () => entries, workflowExecutor: original });
    try {
      const started = await original.runWorkflow(entries[0]!.definition, {}, undefined, "owner");
      expect(started.status).toBe("suspended");
      const saved = await getWorkflowRunRow(started.id);
      expect(saved?.definitionHash).toBe(workflowExecutionHash(entries[0]!.definition, entries[0]!.extensionRelease));
      expect(saved?.definitionHash).not.toBe(workflowDefinitionHash(entries[0]!.definition));
      if (mode === "replacement") {
        setup.snapshot.installation.generation = 2;
        setup.snapshot.installation.acknowledgedGeneration = 2;
        entries = await loadReleaseWorkflowEntries(setup.registry);
      } else if (mode.startsWith("legacy-")) {
        await getTestDb().update(workflowRuns).set({ definitionHash: mode === "legacy-null" ? null : workflowDefinitionHash(entries[0]!.definition) }).where(eq(workflowRuns.id, started.id));
      }
      expect(await claimWorkflowRun({ workflowRunId: started.id, claimedBy: "restart", now: new Date() })).toBe(true);
      const restarted = new WorkflowExecutor(agents, bus, { persist: true });
      const result = await resumeClaimedRun(restarted, entries[0]!.definition, started.id, "restart", undefined, entries[0]);
      if (mode === "same") expect(result.status).toBe("success");
      else expect(result.result?.error).toMatchObject({ code: mode === "legacy-null" ? "not-resumable" : "definition-changed" });
    } finally { _resetWorkflowRuntimeForTests(); }
  }
});

test("timeout decisions defer when the original release fingerprint or authority is absent", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values({ id: "owner", email: "owner@test.invalid", passwordHash: "h", name: "Owner" });
  setup.files["deploy.workflow.yaml"] = "name: deploy\nsteps:\n  - name: gate\n    kind: approval\n    prompt: Continue?\n    choices: [approve]\n    onTimeout: abort\n";
  setup.snapshot.release.artifactDigest = await sha256(canonicalJson(setup.files));
  let entries = await loadReleaseWorkflowEntries(setup.registry);
  const { parkWorkflowApproval, getWorkflowApproval } = await import("../db/queries/workflow-approvals");
  const { releaseWorkflowRunClaim, getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
  const { workflowRuns } = await import("../db/schema");
  const { sweepExpiredWorkflowApprovals } = await import("../runtime/workflow-approval-timeout-sweep");
  const id = await claimedReleaseRun(entries[0]!);
  await releaseWorkflowRunClaim(id, "release-test");
  await getTestDb().update(workflowRuns).set({ definitionHash: workflowExecutionHash(entries[0]!.definition, entries[0]!.extensionRelease) }).where(eq(workflowRuns.id, id));
  await parkWorkflowApproval({ workflowRunId: id, stepName: "gate", prompt: "Continue?", choices: ["approve"], requireItemConsent: false, itemIds: [], expiresAt: new Date(0) });
  const runtime = { getWorkflows: () => entries.map(entry => entry.definition), getCachedWorkflows: () => entries, workflowExecutor: { runWorkflow: async () => { throw new Error("Cannot start"); }, resumeWorkflow: async () => { throw new Error("Cannot resume"); } } };
  setup.snapshot.installation.enabled = false;
  expect((await sweepExpiredWorkflowApprovals({ runtime, now: new Date() })).deferred).toBe(1);
  setup.snapshot.installation.enabled = true;
  setup.snapshot.installation.generation = 2;
  setup.snapshot.installation.acknowledgedGeneration = 2;
  entries = await loadReleaseWorkflowEntries(setup.registry);
  expect((await sweepExpiredWorkflowApprovals({ runtime, now: new Date() })).deferred).toBe(1);
  expect((await getWorkflowApproval(id, "gate"))?.status).toBe("pending");
  expect((await getWorkflowRunRow(id))?.status).toBe("suspended");
  setup.snapshot.installation.generation = 1;
  setup.snapshot.installation.acknowledgedGeneration = 1;
  entries = await loadReleaseWorkflowEntries(setup.registry);
  expect((await sweepExpiredWorkflowApprovals({ runtime, now: new Date() })).aborted).toBe(1);
});

test("direct execution rechecks release authority after durable reads and never runs revoked steps", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values({ id: "owner", email: "owner@test.invalid", passwordHash: "h", name: "Owner" });
  const [entry] = await loadReleaseWorkflowEntries(setup.registry);
  const { WorkflowExecutor, resumeArgsFromRow } = await import("../runtime/workflow-executor");
  const { AgentExecutor } = await import("../runtime/executor");
  const { EventBus } = await import("../runtime/events");
  const { loadAgentsStatic } = await import("../runtime/loader");
  const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
  const { getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
  const { workflowRuns } = await import("../db/schema");
  const bus = new EventBus<import("../types").AgentEvents>();
  const activeRuns = new Set<string>();
  const errors: string[] = [];
  bus.on("workflow:start", ({ workflowRun }) => activeRuns.add(workflowRun.id));
  bus.on("workflow:error", ({ workflowRun }) => {
    activeRuns.delete(workflowRun.id);
    errors.push(workflowRun.id);
  });
  let effects = 0;
  const executor = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, { persist: true, stepSubstitute: () => { effects++; return undefined; } });
  registerWorkflowRuntime({ getWorkflows: () => [entry!.definition], getCachedWorkflows: () => [entry!], workflowExecutor: executor });
  try {
    await expect(executor.runWorkflow(structuredClone(entry!.definition), {}, undefined, "owner")).rejects.toThrow("release authority");
    const failedInsertId = crypto.randomUUID();
    expect((await executor.runWorkflow(entry!.definition, {}, "missing-project", "owner", undefined, { runId: failedInsertId })).result?.error).toMatchObject({ code: "run-persistence-failed" });
    expect(errors).toEqual([failedInsertId]);
    expect(await getWorkflowRunRow(failedInsertId)).toBeUndefined();
    expect(activeRuns.size).toBe(0);
    let reads = 0;
    setup.runtime.resolve = async () => {
      if (++reads === 3) setup.snapshot.installation.enabled = false;
      return setup.snapshot;
    };
    const revokedRunId = crypto.randomUUID();
    expect((await executor.runWorkflow(entry!.definition, {}, undefined, "owner", undefined, { runId: revokedRunId })).status).toBe("error");
    expect((await getWorkflowRunRow(revokedRunId))?.status).toBe("error");
    expect(errors).toEqual([failedInsertId, revokedRunId]);
    expect(activeRuns.size).toBe(0);
    const id = await claimedReleaseRun(entry!);
    await getTestDb().update(workflowRuns).set({ definitionHash: workflowExecutionHash(entry!.definition, entry!.extensionRelease) }).where(eq(workflowRuns.id, id));
    const row = await getWorkflowRunRow(id);
    expect((await executor.resumeWorkflow(entry!.definition, resumeArgsFromRow(row!), undefined, { resumedBy: "release-test", entry })).result?.error).toMatchObject({ code: "not-resumable" });
    setup.snapshot.installation.enabled = true;
    reads = 0;
    expect((await executor.resumeWorkflow(entry!.definition, resumeArgsFromRow(row!), undefined, { resumedBy: "release-test", entry })).result?.error).toMatchObject({ code: "not-resumable" });
    expect(effects).toBe(0);
    registerWorkflowRuntime({ getWorkflows: () => [entry!.definition], getCachedWorkflows: () => [{ ...entry!, source: "yaml", extensionRelease: undefined }], workflowExecutor: executor });
    await expect(executor.runWorkflow(entry!.definition, {}, undefined, "owner")).rejects.toThrow("release authority");
    for (const source of ["yaml", "db"] as const) {
      const hostDefinition = { ...entry!.definition, name: "host-workflow" };
      registerWorkflowRuntime({ getWorkflows: () => [hostDefinition], getCachedWorkflows: () => [{ ...entry!, definition: hostDefinition, source, extensionRelease: undefined }], workflowExecutor: executor });
      expect((await executor.runWorkflow(structuredClone(hostDefinition), {}, undefined, "owner")).status).toBe("success");
    }
  } finally { _resetWorkflowRuntimeForTests(); }
});

test("loads sealed workflow assets without an install path and retains private ownership", async () => {
  const { registry, runtime } = await fixture();
  const entries = await loadReleaseWorkflowEntries(registry, runtime);
  expect(await filterAccessibleWorkflowEntries(entries, "stranger")).toEqual([]);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ source: "extension", userId: "owner", visibility: "private", projectId: null, definition: { name: "sealed:deploy", description: "sealed" } });
  expect(entries[0]!.extensionRelease?.installationId).toBe("installation");
});

test("rejects corrupt immutable artifacts and binary workflow text", async () => {
  const setup = await fixture();
  setup.files["deploy.workflow.yaml"] += "\ndescription: tampered";
  await expect(loadReleaseWorkflowEntries(setup.registry, setup.runtime)).rejects.toThrow("digest mismatch");
  const binary = { "deploy.workflow.yaml": { encoding: "base64", data: "YQ==", executable: false } };
  setup.snapshot.release.artifactDigest = await sha256(canonicalJson(binary));
  setup.runtime.runner = async () => ({ collectArtifacts: async () => binary }) as never;
  await expect(loadReleaseWorkflowEntries(setup.registry, setup.runtime)).rejects.toThrow("must be text");
});

test("stages but refuses unacknowledged, replaced, revoked and removed generations", async () => {
  const setup = await fixture();
  setup.snapshot.installation.acknowledgedGeneration = 0;
  const [entry] = await loadReleaseWorkflowEntries(setup.registry, setup.runtime);
  expect(entry).toBeDefined();
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(false);
  setup.snapshot.installation.acknowledgedGeneration = 1;
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(true);
  setup.snapshot.installation.generation = 2;
  setup.snapshot.installation.acknowledgedGeneration = 2;
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(false);
  setup.snapshot.installation.generation = 1;
  setup.snapshot.installation.acknowledgedGeneration = 1;
  setup.snapshot.installation.enabled = false;
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(false);
  expect(await loadReleaseWorkflowEntries(setup.registry, setup.runtime)).toEqual([]);
  setup.snapshot.installation.enabled = true;
  setup.snapshot.installation.uninstalled = true;
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(false);
  setup.snapshot.installation.uninstalled = false;
  setup.snapshot.release.id = "replacement";
  setup.snapshot.installation.activeReleaseId = "replacement";
  expect(await workflowReleaseIsCurrent(entry!, setup.runtime)).toBe(false);
});

test("actual SQL owner, user suspension and project membership checks bound private assets", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values(["owner", "stranger", "admin"].map(id => ({ id, email: `${id}@test.invalid`, passwordHash: "h", name: id, role: id === "admin" ? "admin" as const : "member" as const })));
  let [entry] = await loadReleaseWorkflowEntries(setup.registry, setup.runtime);
  await getTestDb().insert(extensions).values({ id: "installation", name: "sealed", version: "1.0.0", description: "sealed", manifest: setup.snapshot.release.manifest, source: "release-v4", enabled: true });
  const { canRunWorkflow } = await import("../runtime/workflow-authz");
  expect(await canRunWorkflow(entry!, { id: "owner", role: "member" })).toEqual({ allowed: true });
  expect((await canRunWorkflow(entry!, { id: "stranger", role: "member" })).allowed).toBe(false);
  expect(await workflowReleaseCanAccess(entry!, "owner")).toBe(true);
  expect(await workflowReleaseCanAccess(entry!, "stranger")).toBe(false);
  expect(await workflowReleaseCanAccess(entry!, "admin")).toBe(true);
  expect(await workflowReleaseCanAccess(entry!, null)).toBe(false);
  await getTestDb().update(users).set({ status: "inactive" }).where(eq(users.id, "owner"));
  expect(await workflowReleaseCanAccess(entry!, "admin")).toBe(false);
  await getTestDb().update(users).set({ status: "active" }).where(eq(users.id, "owner"));
  await getTestDb().insert(projects).values({ id: "project", name: "Project", path: "/tmp/workflow-project" });
  await getTestDb().insert(projectMembers).values({ projectId: "project", userId: "owner", role: "owner" });
  setup.snapshot.installation.scope = "project:project";
  [entry] = await loadReleaseWorkflowEntries(setup.registry, setup.runtime);
  expect(await workflowReleaseCanAccess(entry!, "owner", "project")).toBe(true);
  expect(await workflowReleaseCanAccess(entry!, "owner", "elsewhere")).toBe(false);
  await getTestDb().delete(projectMembers).where(eq(projectMembers.userId, "owner"));
  expect(await workflowReleaseCanAccess(entry!, "owner", "project")).toBe(false);
  expect(await workflowReleaseCanAccess(entry!, "admin", "project")).toBe(false);
});

test("discovery refuses stale manifests, absent pointers and changes during artifact reads", async () => {
  const setup = await fixture();
  const original = structuredClone(setup.snapshot);
  const legacy = { getAllManifests: () => new Map([["legacy", { ...original.release.manifest, schemaVersion: 2 }]]).entries() };
  expect(await loadReleaseWorkflowEntries(legacy as never, setup.runtime)).toEqual([]);
  const stale = { getAllManifests: () => new Map([["installation", { ...original.release.manifest, version: "2.0.0" }]]).entries() };
  expect(await loadReleaseWorkflowEntries(stale, setup.runtime)).toEqual([]);
  setup.runtime.resolve = async () => null;
  expect(await loadReleaseWorkflowEntries(setup.registry, setup.runtime)).toEqual([]);
  let reads = 0;
  setup.runtime.resolve = async () => ++reads === 1 ? original : { ...original, installation: { ...original.installation, generation: 2 } };
  await expect(loadReleaseWorkflowEntries(setup.registry, setup.runtime)).rejects.toThrow("changed during discovery");
});

test("only root text workflow assets enter the private catalog", async () => {
  const setup = await fixture();
  const files = { ...setup.files, "extension.ts": "throw new Error('never execute');", "nested/no.workflow.yaml": setup.files["deploy.workflow.yaml"] };
  setup.snapshot.release.artifactDigest = await sha256(canonicalJson(files));
  setup.runtime.runner = async () => ({ collectArtifacts: async () => files }) as never;
  const entries = await loadReleaseWorkflowEntries(setup.registry);
  expect(entries.map(entry => entry.definition.name)).toEqual(["sealed:deploy"]);
  expect(await workflowReleaseIsCurrent({ ...entries[0]!, source: "yaml", extensionRelease: undefined })).toBe(true);
  expect(await workflowReleaseIsCurrent({ ...entries[0]!, extensionRelease: undefined })).toBe(false);
  expect(await workflowReleaseCanAccess({ ...entries[0]!, source: "yaml", extensionRelease: undefined }, null)).toBe(true);
  expect(await filterAccessibleWorkflowEntries([{ ...entries[0]!, source: "yaml", extensionRelease: undefined }], null)).toHaveLength(1);
  expect(await workflowReleaseCanAccess({ ...entries[0]!, extensionRelease: undefined }, "owner")).toBe(false);
  setup.snapshot.installation.grants = ["changed"];
  expect(await workflowReleaseIsCurrent(entries[0]!)).toBe(false);
});

test("real prompt expansion does not disclose private or unacknowledged extension workflow metadata", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values(["owner", "stranger"].map(id => ({ id, email: `${id}@test.invalid`, passwordHash: "h", name: id })));
  const entries = await loadReleaseWorkflowEntries(setup.registry, setup.runtime);
  const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
  const { buildPromptInput } = await import("../runtime/stream-chat/build-prompt");
  registerWorkflowRuntime({ getWorkflows: () => entries.map(entry => ({ ...entry.definition, description: "UNAPPROVED REPLACEMENT SECRET" })), getCachedWorkflows: () => entries, workflowExecutor: { runWorkflow: async () => { throw new Error("A mention cannot run a workflow"); }, resumeWorkflow: async () => { throw new Error("A mention cannot resume a workflow"); } } });
  try {
    const visible = await buildPromptInput("![workflow:sealed:deploy]", { ownerId: "owner" });
    expect(visible.text).toContain("**Workflow: sealed:deploy**");
    expect(visible.text).not.toContain("UNAPPROVED REPLACEMENT SECRET");
    const denied = await buildPromptInput("![workflow:sealed:deploy]", { ownerId: "stranger" });
    expect(denied.text).not.toContain("description:");
    expect(denied.text).toBe("![workflow:sealed:deploy]");
    setup.snapshot.installation.acknowledgedGeneration = 0;
    expect((await buildPromptInput("![workflow:sealed:deploy]", { ownerId: "owner" })).text).toBe("![workflow:sealed:deploy]");
  } finally { _resetWorkflowRuntimeForTests(); }
});

test("nested dispatch and late authority reads refuse a revoked release", async () => {
  const setup = await fixture();
  await getTestDb().insert(users).values({ id: "owner", email: "owner@test.invalid", passwordHash: "h", name: "Owner" });
  const entries = await loadReleaseWorkflowEntries(setup.registry, setup.runtime);
  const { makeNestedWorkflowResolver } = await import("../runtime/nested-workflow-resolver");
  const resolve = makeNestedWorkflowResolver(() => entries);
  expect(await resolve("sealed:deploy", { userId: "owner" })).toEqual(entries[0]!.definition);
  expect(await resolve("sealed:deploy", { userId: "stranger" })).toBeUndefined();
  setup.snapshot.installation.enabled = false;
  expect(await resolve("sealed:deploy", { userId: "owner" })).toBeUndefined();
  setup.snapshot.installation.enabled = true;
  let reads = 0;
  setup.runtime.resolve = async () => {
    if (++reads === 2) setup.snapshot.installation.enabled = false;
    return setup.snapshot;
  };
  expect(await workflowReleaseCanAccess(entries[0]!, "owner")).toBe(false);
  expect(reads).toBe(2);
});
