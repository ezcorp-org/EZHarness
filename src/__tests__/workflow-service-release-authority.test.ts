import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { workflowReleaseFixture } from "./helpers/workflow-release";

mockDbConnection();
const { users, projects, projectMembers, extensions, serviceAccounts, workflowDelegations } = await import("../db/schema");
const { workflowReleaseCanExecute, workflowDelegationReleaseBinding } = await import("../runtime/workflow-release-assets");
const { up } = await import("../db/migrations/add-workflow-delegation-release");
const { workflowDelegationReleaseAllows } = await import("../runtime/workflow-scope");
const { makeNestedWorkflowResolver } = await import("../runtime/nested-workflow-resolver");
beforeEach(setupTestDb);
afterAll(closeTestDb);

async function fixture() {
  const db = getTestDb();
  await up(db);
  await up(db);
  await db.insert(users).values([{ id: "owner", email: "owner@test.invalid", name: "Owner", passwordHash: "hash" }, { id: "admin", email: "admin@test.invalid", name: "Admin", passwordHash: "hash", role: "admin" }]);
  const release = workflowReleaseFixture({ name: "sealed:task", description: "Sealed task", steps: [] }, "owner", "installation");
  await db.insert(extensions).values({ id: "installation", name: "sealed", version: "1.0.0", description: "Sealed", source: "test", enabled: true, manifest: release.snapshot.release.manifest });
  await db.insert(serviceAccounts).values({ id: "service", name: "Service", createdByUserId: "admin", scopes: [], maxTokensPerDay: 1000 });
  await db.insert(workflowDelegations).values({ id: "delegation", extensionId: "installation", jobRef: "job", ownerKind: "service", ownerServiceAccountId: "service", workflowName: "sealed:task", triggerKind: "cron", consentHash: "hash", definitionHash: "graph", consentedByUserId: "owner", maxTokensPerRun: 100, maxRunsPerDay: 10, extensionReleaseBinding: workflowDelegationReleaseBinding(release.entry) });
  const authority = { userId: null, runAsKind: "service", runAs: "service", delegationId: "delegation", projectId: null };
  return { db, release, authority };
}

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
