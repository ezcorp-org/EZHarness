import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();
const { users, projects, projectMembers, serviceAccounts, workflowDelegations, workflowRuns } = await import("../db/schema");
const { workflowReleaseCanExecute, workflowDelegationReleaseBinding } = await import("../runtime/workflow-release-assets");
const { workflowServiceReleaseFixture: fixture } = await import("./helpers/workflow-service-release");
const { workflowDelegationReleaseAllows } = await import("../runtime/workflow-scope");
const { makeNestedWorkflowResolver } = await import("../runtime/nested-workflow-resolver");
const { workflowExecutionHash } = await import("../runtime/workflow-definition-hash");
const { registerWorkflowRuntime, _resetWorkflowRuntimeForTests } = await import("../runtime/workflow/runtime-registry");
beforeEach(setupTestDb);
afterAll(closeTestDb);

test("service runs use exact persisted human consent without human impersonation", async () => {
  const { release, authority } = await fixture();
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(true);
  for (const change of [{ userId: "owner" }, { runAs: "other" }, { delegationId: null }, { delegationId: "missing" }, { projectId: "other" }]) {
    expect(await workflowReleaseCanExecute(release.entry, { ...authority, ...change })).toBe(false);
  }
});

test("old consent and replaced releases require explicit re-consent even with the same graph", async () => {
  const { db, release, authority } = await fixture();
  await db.update(workflowDelegations).set({ extensionReleaseBinding: null }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(workflowDelegations).set({ extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry) }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(true);
  release.snapshot.installation.generation++;
  release.snapshot.installation.acknowledgedGeneration++;
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
});

test("revocation, disabled service, changed owner and inactive consenter deny execution", async () => {
  const { db, release, authority } = await fixture();
  await db.update(serviceAccounts).set({ enabled: false }).where(eq(serviceAccounts.id, "service"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(serviceAccounts).set({ enabled: true }).where(eq(serviceAccounts.id, "service"));
  await db.update(workflowDelegations).set({ revokedAt: new Date() }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(workflowDelegations).set({ revokedAt: null, consentedByUserId: "admin" }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(workflowDelegations).set({ consentedByUserId: "owner" }).where(eq(workflowDelegations.id, "delegation"));
  await db.update(users).set({ status: "inactive" }).where(eq(users.id, "owner"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(users).set({ status: "active" }).where(eq(users.id, "owner"));
  release.snapshot.installation.ownerId = "admin";
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
});

test("the effect transaction reads live service and delegation without another database connection", async () => {
  const { db, release, authority } = await fixture();
  await db.transaction(async transaction => {
    expect(await workflowReleaseCanExecute(release.entry, authority, transaction)).toBe(true);
    await transaction.update(serviceAccounts).set({ enabled: false }).where(eq(serviceAccounts.id, "service"));
    expect(await workflowReleaseCanExecute(release.entry, authority, transaction)).toBe(false);
  });
});

test("consented closure accepts only canonical exact release names", async () => {
  const { release } = await fixture();
  const child = { ...release.entry, definition: { ...release.entry.definition, name: "sealed:child" } };
  const binding = workflowDelegationReleaseBinding(release.entry, [release.entry.definition.name, child.definition.name]);
  expect(workflowDelegationReleaseAllows(child, binding)).toBe(true);
  expect(workflowDelegationReleaseAllows(child, workflowDelegationReleaseBinding(release.entry))).toBe(false);
  for (const invalid of [null, "", "{", "x".repeat(65537), "null", "{}", JSON.stringify({ version: 1, release: child.extensionRelease, workflows: [1] }), JSON.stringify({ version: 2, release: child.extensionRelease, workflows: [child.definition.name] })]) {
    expect(workflowDelegationReleaseAllows(child, invalid)).toBe(false);
  }
  expect(workflowDelegationReleaseAllows({ ...child, source: "db" }, binding)).toBe(false);
  expect(workflowDelegationReleaseAllows({ ...child, extensionRelease: undefined }, binding)).toBe(false);
  expect(workflowDelegationReleaseBinding({ ...child, extensionRelease: undefined })).toBeNull();
});

test("nested service lookup uses the persisted consented closure rather than a human identity", async () => {
  const { db, release, authority } = await fixture();
  const child = { ...release.entry, definition: { ...release.entry.definition, name: "sealed:child" } };
  const unrelated = { ...child, definition: { ...child.definition, name: "sealed:unrelated" } };
  const resolver = makeNestedWorkflowResolver(() => [release.entry, child, unrelated]);
  expect(await resolver(child.definition.name, { authority })).toBeUndefined();
  await db.update(workflowDelegations).set({ extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry, [release.entry.definition.name, child.definition.name]) }).where(eq(workflowDelegations.id, "delegation"));
  expect(await resolver(child.definition.name, { authority })).toBe(child.definition);
  expect(await resolver(unrelated.definition.name, { authority })).toBeUndefined();
  expect(await resolver(child.definition.name, {})).toBeUndefined();
  await db.update(workflowDelegations).set({ enabled: false }).where(eq(workflowDelegations.id, "delegation"));
  expect(await resolver(child.definition.name, { authority })).toBeUndefined();
});

test("a project service requires current consenting owner membership even for a global release", async () => {
  const { db, release, authority } = await fixture();
  await db.insert(projects).values({ id: "project", name: "Project", path: "/project" });
  await db.update(serviceAccounts).set({ projectId: "project" }).where(eq(serviceAccounts.id, "service"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(workflowDelegations).set({ projectId: "project" }).where(eq(workflowDelegations.id, "delegation"));
  const scoped = { ...authority, projectId: "project" };
  expect(await workflowReleaseCanExecute(release.entry, scoped)).toBe(false);
  await db.insert(projectMembers).values({ userId: "owner", projectId: "project", role: "member" });
  expect(await workflowReleaseCanExecute(release.entry, scoped)).toBe(true);
  await db.delete(projectMembers).where(eq(projectMembers.userId, "owner"));
  expect(await workflowReleaseCanExecute(release.entry, scoped)).toBe(false);
  expect(await workflowReleaseCanExecute(release.entry, { userId: "owner", projectId: "project" })).toBe(false);
  await db.insert(projectMembers).values({ userId: "owner", projectId: "project", role: "member" });
  expect(await workflowReleaseCanExecute(release.entry, { userId: "owner", projectId: "project" })).toBe(true);
});

test("human delegations require a live exact release consent and cannot widen its closure", async () => {
  const { db, release } = await fixture();
  await db.update(workflowDelegations).set({ ownerKind: "user", ownerUserId: "owner", ownerServiceAccountId: null }).where(eq(workflowDelegations.id, "delegation"));
  const authority = { userId: "owner", runAsKind: "user", runAs: "owner", delegationId: "delegation" };
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(true);
  const child = { ...release.entry, definition: { ...release.entry.definition, name: "sealed:unconsented" } };
  expect(await workflowReleaseCanExecute(child, authority)).toBe(false);
  await db.update(workflowDelegations).set({ extensionReleaseBinding: null }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
  await db.update(workflowDelegations).set({ extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry) }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(true);
  await db.update(workflowDelegations).set({ revokedAt: new Date() }).where(eq(workflowDelegations.id, "delegation"));
  expect(await workflowReleaseCanExecute(release.entry, authority)).toBe(false);
});

async function nestedFixture() {
  const setup = await fixture();
  const { db, release, authority } = setup;
  const child = { ...release.entry, definition: { ...release.entry.definition, name: "sealed:child", steps: [{ name: "result", kind: "transform" as const, output: { finished: "yes" } }] } };
  release.entry.definition.steps = [{ name: "child", kind: "workflow", workflow: child.definition.name, input: {} }];
  await db.update(workflowDelegations).set({ extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry, [release.entry.definition.name, child.definition.name]) }).where(eq(workflowDelegations.id, "delegation"));
  const { WorkflowExecutor } = await import("../runtime/workflow-executor");
  const { AgentExecutor } = await import("../runtime/executor");
  const { EventBus } = await import("../runtime/events");
  const { loadAgentsStatic } = await import("../runtime/loader");
  const bus = new EventBus<import("../types").AgentEvents>();
  const executor = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, { persist: true });
  const register = () => registerWorkflowRuntime({ getCachedWorkflows: () => [release.entry, child], getWorkflows: () => [release.entry.definition, child.definition], workflowExecutor: executor });
  register();
  await db.insert(workflowRuns).values({ id: "parent", workflowName: release.entry.definition.name, status: "suspended", startedAt: new Date(), input: {}, definitionHash: workflowExecutionHash(release.entry.definition, release.entry.extensionRelease), userId: null, delegationId: authority.delegationId, runAsKind: "service", runAs: authority.runAs });
  return { ...setup, child, executor, register, childAuthority: { ...authority, parentRunId: "parent" } };
}

test("persisted child resumes after registry restart only while its exact parent authority remains valid", async () => {
  const { db, child, executor, register, childAuthority, release } = await nestedFixture();
  const { getWorkflowRunRow } = await import("../db/queries/workflow-runs");
  const { resumeArgsFromRow } = await import("../runtime/workflow-executor");
  await db.insert(workflowRuns).values({ id: "child", workflowName: child.definition.name, status: "suspended", startedAt: new Date(), input: {}, definitionHash: workflowExecutionHash(child.definition, child.extensionRelease), parentRunId: "parent", userId: null, delegationId: childAuthority.delegationId, runAsKind: "service", runAs: childAuthority.runAs });
  _resetWorkflowRuntimeForTests();
  expect(await workflowReleaseCanExecute(child, childAuthority)).toBe(false);
  register();
  const row = await getWorkflowRunRow("child");
  const resumed = await executor.resumeWorkflow(child.definition, resumeArgsFromRow(row!), undefined, { entry: child });
  expect(resumed.result?.error).toBeUndefined();
  expect(resumed.status).toBe("success");
  expect((await getWorkflowRunRow("child"))?.userId).toBeNull();
  release.snapshot.installation.enabled = false;
  expect(await workflowReleaseCanExecute(child, childAuthority)).toBe(false);
  _resetWorkflowRuntimeForTests();
});

test("persisted ancestry rejects scope, principal, hash, missing, cyclic and terminal parents", async () => {
  const { db, child, childAuthority, release } = await nestedFixture();
  expect(await db.transaction(transaction => workflowReleaseCanExecute(child, childAuthority, transaction))).toBe(true);
  expect(await workflowReleaseCanExecute(child, { ...childAuthority, parentRunId: "missing" })).toBe(false);
  const patches = [{ status: "cancelled" }, { definitionHash: "changed" }, { parentRunId: "parent" }, { userId: "owner" }, { runAs: "different" }, { delegationId: null }];
  for (const patch of patches) {
    await db.update(workflowRuns).set(patch).where(eq(workflowRuns.id, "parent"));
    expect(await workflowReleaseCanExecute(child, childAuthority)).toBe(false);
    await db.update(workflowRuns).set({ status: "suspended", definitionHash: workflowExecutionHash(release.entry.definition, release.entry.extensionRelease), parentRunId: null, userId: null, runAs: childAuthority.runAs, delegationId: childAuthority.delegationId }).where(eq(workflowRuns.id, "parent"));
  }
  _resetWorkflowRuntimeForTests();
});
