import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { up } from "../../db/migrations/add-factory-grants";
import { FactoryRunGrants } from "../../factory/run-grants";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryRecords } from "../../factory/records";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { releaseRows as rows } from "../../db/queries/extension-releases";

interface GrantFixture { readonly db: TransactionalDb; close(): Promise<void> }

export function factoryGrantsConformance(createFixture: () => Promise<GrantFixture>): void {
let fixture: GrantFixture;
let grants: FactoryGrants;
let now = Date.UTC(2030, 0, 1);
const admin: FactoryPrincipal = { kind: "user", id: "grant-admin", authentication: "session" };
const owner: FactoryPrincipal = { kind: "user", id: "grant-owner", authentication: "session" };
const member: FactoryPrincipal = { kind: "user", id: "grant-member", authentication: "session" };

beforeAll(async () => {
  fixture = await createFixture();
  await up(fixture.db);
  const records = new FactoryRecords(fixture.db, "grant-tenant");
  await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('grant-project', 'Grants', '/tmp/grant-project'), ('grant-other', 'Other', '/tmp/grant-other')`);
  await records.bindProject("grant-project");
  await records.bindProject("grant-other");
  for (const [id, role] of [[admin.id, "admin"], [owner.id, "member"], [member.id, "member"]]) {
    await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES (${id}, ${`${id}@example.test`}, 'not-a-login', ${id}, ${role})`);
  }
  for (const [id, role] of [[admin.id, "member"], [owner.id, "owner"], [member.id, "member"]]) {
    await fixture.db.execute(sql`INSERT INTO project_members (id, project_id, user_id, role) VALUES (${`member-${id}`}, 'grant-project', ${id}, ${role})`);
  }
  grants = new FactoryGrants(fixture.db, "grant-tenant", () => now);
});
afterAll(async () => { await fixture?.close(); });

test("reads require current membership even for administrators and foreign installation IDs", async () => {
  expect(await grants.authorize(member, "grant-project", "read")).toEqual({ revision: 0, expiresAtMs: null });
  await expect(grants.authorize(admin, "grant-other", "read")).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(new FactoryGrants(fixture.db, "foreign", () => now).authorize(member, "grant-project", "read")).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(grants.authorize(member, "grant-project", "factory.run")).rejects.toMatchObject({ code: "factory_forbidden" });
});

test("grants fence revisions, expire at their boundary, and retain revocation audit", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.run" as const };
  const issued = await grants.set(admin, { ...key, expiresAtMs: now + 10, expectedRevision: 0 });
  expect(issued.revision).toBe(1);
  expect(await grants.authorize(member, key.projectId, key.action, 1)).toEqual(issued);
  await expect(grants.authorize(member, key.projectId, key.action, 2)).rejects.toMatchObject({ code: "factory_grant_stale" });
  now += 10;
  await expect(grants.authorize(member, key.projectId, key.action)).rejects.toMatchObject({ code: "factory_forbidden" });
  expect((await grants.set(admin, { ...key, expiresAtMs: null, expectedRevision: 1 })).revision).toBe(2);
  expect((await grants.revoke(admin, { ...key, expectedRevision: 2 })).revision).toBe(3);
  await expect(grants.authorize(member, key.projectId, key.action)).rejects.toMatchObject({ code: "factory_forbidden" });
  expect(rows(await fixture.db.execute(sql`SELECT revision, revoked_at FROM factory_grants WHERE principal_id=${member.id} AND action='factory.run'`))).toHaveLength(1);
  expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE action='factory.grant.revoked'`))).toHaveLength(1);
});

test("owners cannot issue a wider action or a longer expiry than their current grant", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.author" as const };
  await expect(grants.set(owner, { ...key, expectedRevision: 0, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_forbidden" });
  await grants.set(admin, { ...key, principal: owner, expectedRevision: 0, expiresAtMs: now + 20 });
  await expect(grants.set(owner, { ...key, expectedRevision: 0, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_grant_widening" });
  expect((await grants.set(owner, { ...key, expectedRevision: 0, expiresAtMs: now + 10 })).revision).toBe(1);
  await expect(grants.set({ ...admin, authentication: "api-key" }, { ...key, expectedRevision: 1, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_human_required" });
});

test("concurrent saves admit one expected revision and inactive users lose existing grants", async () => {
  const request = { projectId: "grant-project", principal: member, action: "factory.publish" as const, expectedRevision: 0, expiresAtMs: null };
  const raced = await Promise.allSettled([grants.set(admin, request), grants.set(admin, request)]);
  expect(raced.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter(result => result.status === "rejected")).toHaveLength(1);
  await fixture.db.execute(sql`UPDATE users SET status='inactive' WHERE id=${member.id}`);
  await expect(grants.authorize(member, "grant-project", "factory.publish")).rejects.toMatchObject({ code: "factory_forbidden" });
  await fixture.db.execute(sql`UPDATE users SET status='active' WHERE id=${member.id}`);
});

test("service principals need explicit project grants and current account validity", async () => {
  const service: FactoryPrincipal = { kind: "service", id: "grant-service", authentication: "service" };
  await fixture.db.execute(sql`INSERT INTO service_accounts (id, name, created_by_user_id, project_id, max_tokens_per_day, expires_at) VALUES (${service.id}, 'Grant service', ${admin.id}, 'grant-project', 100, ${new Date(now + 100)})`);
  await expect(grants.authorize(service, "grant-project", "read")).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(grants.set(admin, { projectId: "grant-project", principal: service, action: "factory.run", expectedRevision: 0, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_grant_invalid" });
  await grants.set(admin, { projectId: "grant-project", principal: service, action: "factory.run", expectedRevision: 0, expiresAtMs: now + 100 });
  expect((await grants.authorize(service, "grant-project", "factory.run")).revision).toBe(1);
  expect((await grants.authorize(service, "grant-project", "read")).revision).toBe(0);
  const serviceRun = { projectId: "grant-project", runId: "grant-service-run", definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "factory-v1", executionEpoch: 1, input: {}, principalId: service.id, principalKind: "service" as const };
  await new FactoryRecords(fixture.db, "grant-tenant").createRun(serviceRun, async () => {});
  const authority: FactoryAttemptAuthority = { tenantId: "grant-tenant", projectId: serviceRun.projectId, runId: serviceRun.runId, nodeInstanceId: "service-node", attemptId: "service-attempt", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, deadlineAt: new Date(now + 100) };
  const runGrants = new FactoryRunGrants(fixture.db, "grant-tenant", () => now);
  await expect(runGrants.authorize(authority)).resolves.toBeUndefined();
  await expect(grants.set(admin, { projectId: "grant-other", principal: service, action: "factory.run", expectedRevision: 0, expiresAtMs: now + 100 })).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(grants.authorize(service, "grant-project", "factory.approve")).rejects.toMatchObject({ code: "factory_human_required" });
  await fixture.db.execute(sql`UPDATE service_accounts SET enabled=FALSE WHERE id=${service.id}`);
  await expect(runGrants.authorize(authority)).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(grants.authorize(service, "grant-project", "factory.run")).rejects.toMatchObject({ code: "factory_forbidden" });
  await fixture.db.execute(sql`UPDATE service_accounts SET enabled=TRUE, expires_at=${new Date(now)} WHERE id=${service.id}`);
  await expect(grants.authorize(service, "grant-project", "factory.run")).rejects.toMatchObject({ code: "factory_forbidden" });
});

test("consent is human-only and trust also requires a current tenant administrator", async () => {
  await grants.set(admin, { projectId: "grant-project", principal: member, action: "factory.approve", expectedRevision: 0, expiresAtMs: null });
  expect((await grants.authorize(member, "grant-project", "factory.approve")).revision).toBe(1);
  await expect(grants.authorize({ ...member, authentication: "api-key" }, "grant-project", "factory.approve")).rejects.toMatchObject({ code: "factory_human_required" });
  await grants.set(admin, { projectId: "grant-project", principal: admin, action: "factory.trust", expectedRevision: 0, expiresAtMs: null });
  expect((await grants.authorize(admin, "grant-project", "factory.trust")).revision).toBe(1);
  await expect(grants.authorize(member, "grant-project", "factory.trust")).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(grants.set(owner, { projectId: "grant-project", principal: member, action: "factory.trust", expectedRevision: 0, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_forbidden" });
});

test("journal effect claims recheck the durable initiator's current grant", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.run" as const };
  await grants.set(admin, { ...key, expectedRevision: 3, expiresAtMs: null });
  const records = new FactoryRecords(fixture.db, "grant-tenant");
  const request = { projectId: key.projectId, runId: "grant-run", definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "factory-v1", executionEpoch: 1, input: {}, principalId: member.id };
  await records.createRun(request, async () => {});
  const runGrants = new FactoryRunGrants(fixture.db, "grant-tenant", () => now);
  const attempt: FactoryAttemptAuthority = { tenantId: "grant-tenant", projectId: key.projectId, runId: request.runId, nodeInstanceId: "node", attemptId: "grant-attempt", candidateGeneration: 1, attemptNumber: 1, grantRevision: 4, reservationGeneration: 1, executionEpoch: 1, deadlineAt: new Date(now + 1_000) };
  const journal = new FactoryExecutionJournal(fixture.db, runGrants.authorizeInTransaction, () => new Date(now));
  await runGrants.authorize(attempt);
  await expect(runGrants.authorize({ ...attempt, tenantId: "foreign" })).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(runGrants.authorize({ ...attempt, executionEpoch: 2 })).rejects.toMatchObject({ code: "factory_forbidden" });
  expect(await journal.admit({ ...attempt, request: {} })).toMatchObject({ reused: false });
  const operation = { operationId: `${request.runId}:node:1:0`, operationIndex: 0, kind: "tool" as const, requestDigest: "a".repeat(64) };
  await journal.prepare(attempt, operation);
  await grants.revoke(admin, { ...key, expectedRevision: 4 });
  await expect(journal.dispatch(attempt, operation.operationId)).rejects.toMatchObject({ code: "factory_forbidden" });
  expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId}`))).toEqual([{ state: "prepared" }]);
  expect(await journal.cancel(attempt)).toBe(true);
  expect(await journal.confirmStopped(attempt)).toBe(true);
});

test("a failed transactional audit rolls back the grant and its revision", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.release" as const, expectedRevision: 0, expiresAtMs: null };
  await fixture.db.execute(sql`ALTER TABLE audit_log RENAME TO factory_test_hidden_audit`);
  try {
    await expect(grants.set(admin, key)).rejects.toThrow();
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_grants WHERE action='factory.release'`))).toHaveLength(0);
  } finally {
    await fixture.db.execute(sql`ALTER TABLE factory_test_hidden_audit RENAME TO audit_log`);
  }
  expect((await grants.set(admin, key)).revision).toBe(1);
});

test("invalid updates, stale writes and removed memberships cannot keep authority", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.release" as const };
  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) await expect(grants.set(admin, { ...key, expectedRevision, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_grant_invalid" });
  await expect(grants.set(admin, { ...key, expectedRevision: 1, expiresAtMs: now })).rejects.toMatchObject({ code: "factory_grant_invalid" });
  await expect(grants.set(admin, { ...key, expectedRevision: 0, expiresAtMs: null })).rejects.toMatchObject({ code: "factory_grant_conflict" });
  await expect(grants.revoke(admin, { ...key, action: "factory.operate", expectedRevision: 0 })).rejects.toMatchObject({ code: "factory_grant_conflict" });
  await fixture.db.execute(sql`DELETE FROM project_members WHERE user_id=${member.id} AND project_id='grant-project'`);
  await expect(grants.authorize(member, "grant-project", "factory.release")).rejects.toMatchObject({ code: "factory_forbidden" });
});

}
