import { afterAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "../__tests__/helpers/test-pglite";
import { releaseRuntimeFixture } from "../__tests__/helpers/release-runtime";
import { DatabaseLifecycleRepository } from "../db/queries/extension-releases";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { getReleaseRuntime, resolveActiveRelease } from "./release-process";
import { readWorkflowAuthorityUser, readWorkflowAuthorityMembership } from "../db/queries/workflow-authority";
import { users, projects, projectMembers } from "../db/schema";

mockDbConnection();
afterAll(closeTestDb);

test("production release resolver reads transaction-local state without opening another transaction", async () => {
  await setupTestDb();
  await getExtensionLifecycle();
  const { snapshot } = releaseRuntimeFixture(crypto.randomUUID(), { schemaVersion: 4, name: "transaction-fixture", version: "1.0.0", description: "Fixture", author: { name: "Owner" }, permissions: {} });
  const repository = new DatabaseLifecycleRepository(getTestDb());
  await repository.create({ installation: snapshot.installation, releases: { [snapshot.release.id]: snapshot.release }, revisions: {}, workspaces: {}, approvals: {}, operations: {} });
  const runtime = getReleaseRuntime();
  await getTestDb().transaction(async transaction => {
    await transaction.execute(sql`UPDATE extension_release_installations SET payload = ${JSON.stringify({ ...snapshot.installation, enabled: false })} WHERE id = ${snapshot.installation.id}`);
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error("Release read deadlocked outside the supplied transaction")), 1000);
    try {
      expect(await Promise.race([runtime.resolve(snapshot.installation.id, transaction), deadline.promise])).toBeNull();
    } finally { clearTimeout(timer); }
  });
  const ownerId = snapshot.installation.ownerId;
  let projectId: string;
  await getTestDb().transaction(async transaction => {
    await transaction.execute(sql`UPDATE extension_release_installations SET payload = ${JSON.stringify(snapshot.installation)} WHERE id = ${snapshot.installation.id}`);
    expect((await resolveActiveRelease(snapshot.installation.id, runtime, transaction)).release.id).toBe(snapshot.release.id);
    expect(await repository.read("missing", transaction)).toBeNull();
    await transaction.execute(sql`INSERT INTO extension_release_data_state (installation_id, version, migration_id) VALUES (${snapshot.installation.id}, 'v1', 'pending-migration')`);
    expect(await runtime.resolve(snapshot.installation.id, transaction)).toBeNull();
    await transaction.execute(sql`DELETE FROM extension_release_data_state WHERE installation_id = ${snapshot.installation.id}`);
    expect((await runtime.resolve(snapshot.installation.id, transaction))?.installation.enabled).toBe(true);
    await transaction.insert(users).values({ id: ownerId, email: "transaction-owner@example.test", name: "Owner", passwordHash: "unused" });
    const [project] = await transaction.insert(projects).values({ name: "Transaction", path: "/tmp/transaction-authority" }).returning();
    projectId = project!.id;
    await transaction.insert(projectMembers).values({ projectId, userId: ownerId, role: "member" });
    expect(await readWorkflowAuthorityUser(ownerId, transaction)).toEqual({ id: ownerId, role: "member", status: "active" });
    expect(await readWorkflowAuthorityMembership(ownerId, projectId, transaction)).toBe(true);
    await transaction.execute(sql`UPDATE users SET status = 'inactive' WHERE id = ${ownerId}`);
    await transaction.execute(sql`DELETE FROM project_members WHERE user_id = ${ownerId} AND project_id = ${projectId}`);
    expect((await readWorkflowAuthorityUser(ownerId, transaction))?.status).toBe("inactive");
    expect(await readWorkflowAuthorityMembership(ownerId, projectId, transaction)).toBe(false);
    expect(await readWorkflowAuthorityUser("missing", transaction)).toBeUndefined();
  });
  expect((await readWorkflowAuthorityUser(ownerId))?.status).toBe("inactive");
  expect(await readWorkflowAuthorityUser("missing")).toBeUndefined();
  expect(await readWorkflowAuthorityMembership(ownerId, projectId!)).toBe(false);
  await getTestDb().insert(projectMembers).values({ projectId: projectId!, userId: ownerId, role: "member" });
  expect(await readWorkflowAuthorityMembership(ownerId, projectId!)).toBe(true);
});
