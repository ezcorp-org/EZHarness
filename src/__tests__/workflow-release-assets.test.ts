import { afterAll, beforeEach, expect, test } from "bun:test";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
import type { ActiveExtensionRelease, ReleaseRuntimeDependencies } from "../extensions/release-process";
import { executionLimits } from "@ezcorp/extension-runner";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { eq } from "drizzle-orm";

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
