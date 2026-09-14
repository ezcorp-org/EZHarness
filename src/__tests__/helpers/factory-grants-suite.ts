import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { up } from "../../db/migrations/add-factory-grants";
import { FactoryRunGrants } from "../../factory/run-grants";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FactoryRecords } from "../../factory/records";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FactoryServiceCredentials } from "../../factory/service-credentials";

interface GrantFixture { readonly db: TransactionalDb; close(): Promise<void> }

function runnerRequestFor(authority: FactoryAttemptAuthority): FactoryRunnerRequest {
  return { schemaVersion: "factory.runner.request.v1", authority: { attemptId: authority.attemptId, tenantId: authority.tenantId, projectId: authority.projectId, runId: authority.runId, nodeInstanceId: authority.nodeInstanceId, candidateGeneration: authority.candidateGeneration, attemptNumber: authority.attemptNumber, grantRevision: authority.grantRevision, reservationGeneration: authority.reservationGeneration, executionEpoch: authority.executionEpoch, cancellationEpoch: authority.cancellationEpoch, deadlineAtMs: authority.deadlineAt.getTime(), nextOperationIndex: 0 }, runner: { package: "runner", manifestName: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: {} }, grants: [], resources: {}, tools: [], broker: { attemptToken: "ephemeral-grant-token", audience: "gateway" } };
}

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

test("grant metadata pages are scoped, filtered, cursor-bound, and durably idempotent", async () => {
  const key = { projectId: "grant-project", principal: member, action: "factory.operate" as const };
  const issued = await grants.set(admin, { ...key, expectedRevision: 0, expiresAtMs: null }, "http-grant-set");
  expect(await grants.set(admin, { ...key, expectedRevision: 0, expiresAtMs: null }, "http-grant-set")).toEqual(issued);
  await expect(grants.set(admin, { ...key, expectedRevision: 0, expiresAtMs: now + 1_000 }, "http-grant-set")).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect(await grants.read(member, key)).toMatchObject({ projectId: key.projectId, principalKind: "user", principalId: member.id, action: key.action, revision: 1, revoked: false, issuerId: admin.id, updatedAtMs: expect.any(Number) });
  const filtered = await grants.list(member, key.projectId, { principalKind: "user", action: key.action, limit: 1 });
  expect(filtered.items).toHaveLength(1);
  expect(filtered.items[0]).toMatchObject({ principalId: member.id, action: key.action });
  const first = await grants.list(member, key.projectId, { principalKind: "user", limit: 1 });
  expect(first.nextCursor).not.toBeNull();
  expect((await grants.list(member, key.projectId, { principalKind: "user", limit: 200, cursor: first.nextCursor! })).items.every(item => item.principalId !== first.items[0]!.principalId || item.action !== first.items[0]!.action)).toBe(true);
  await expect(grants.list(member, key.projectId, { cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "factory_page_invalid" });
  await expect(grants.list(member, key.projectId, { cursor: "x".repeat(2_049) })).rejects.toMatchObject({ code: "factory_page_invalid" });
  const revoked = await grants.revoke(admin, { ...key, expectedRevision: 1 }, "http-grant-revoke");
  expect(await grants.revoke(admin, { ...key, expectedRevision: 1 }, "http-grant-revoke")).toEqual(revoked);
  expect(await grants.read(member, key)).toMatchObject({ revision: 2, revoked: true });
});

test("grant operations snapshot caller-owned authority and targets before authorization waits", async () => {
  const targetA: FactoryPrincipal = { kind: "user", id: "grant-race-a", authentication: "session" };
  const targetB: FactoryPrincipal = { kind: "user", id: "grant-race-b", authentication: "session" };
  for (const principal of [targetA, targetB]) {
    await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES (${principal.id}, ${`${principal.id}@example.test`}, 'not-a-login', ${principal.id}, 'member')`);
    await fixture.db.execute(sql`INSERT INTO project_members (id, project_id, user_id, role) VALUES (${`member-${principal.id}`}, 'grant-project', ${principal.id}, 'member')`);
  }
  await grants.set(admin, { projectId: "grant-project", principal: owner, action: "factory.approve", expectedRevision: 0, expiresAtMs: null });

  const originalAuthorize = grants.authorizeInTransaction.bind(grants);
  let release = () => {};
  let reached = Promise.resolve();
  function holdNextAuthorization(): void {
    reached = new Promise<void>(resolve => {
      let unblock!: () => void;
      const blocked = new Promise<void>(resume => { unblock = resume; });
      release = unblock;
      grants.authorizeInTransaction = async (...args) => {
        resolve();
        await blocked;
        grants.authorizeInTransaction = originalAuthorize;
        return originalAuthorize(...args);
      };
    });
  }

  try {
    const mutableActor = { ...owner };
    const mutableTarget = { ...targetA };
    const mutableUpdate = { projectId: "grant-project", principal: mutableTarget, action: "factory.approve" as "factory.approve" | "factory.operate", expectedRevision: 0, expiresAtMs: null };
    holdNextAuthorization();
    const setting = grants.set(mutableActor, mutableUpdate, "grant-snapshot-race");
    await reached;
    mutableActor.id = targetB.id;
    mutableTarget.id = targetB.id;
    mutableUpdate.action = "factory.operate";
    release();
    expect(await setting).toEqual({ revision: 1, expiresAtMs: null });
    expect(await grants.read(targetA, { projectId: "grant-project", principal: targetA, action: "factory.approve" })).toMatchObject({ principalId: targetA.id, action: "factory.approve", issuerId: owner.id });
    await expect(grants.read(targetB, { projectId: "grant-project", principal: targetB, action: "factory.operate" })).rejects.toMatchObject({ code: "factory_grant_not_found" });

    const mutableReader = { ...targetA };
    const mutableKey = { projectId: "grant-project", principal: { ...targetA }, action: "factory.approve" as const };
    holdNextAuthorization();
    const reading = grants.read(mutableReader, mutableKey);
    await reached;
    mutableReader.id = "not-a-member";
    mutableKey.principal.id = targetB.id;
    release();
    expect(await reading).toMatchObject({ principalId: targetA.id, action: "factory.approve" });

    const mutableLister = { ...targetA };
    const mutableOptions = { principalKind: "user" as "user" | "service", action: "factory.approve" as "factory.approve" | "factory.run", limit: 10 };
    holdNextAuthorization();
    const listing = grants.list(mutableLister, "grant-project", mutableOptions);
    await reached;
    mutableLister.id = "not-a-member";
    mutableOptions.principalKind = "service";
    mutableOptions.action = "factory.run";
    mutableOptions.limit = 1;
    release();
    expect((await listing).items.some(item => item.principalId === targetA.id && item.action === "factory.approve")).toBe(true);
  } finally {
    release();
    grants.authorizeInTransaction = originalAuthorize;
  }
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
  const authority: FactoryAttemptAuthority = { tenantId: "grant-tenant", projectId: serviceRun.projectId, runId: serviceRun.runId, nodeInstanceId: "service-node", attemptId: "service-attempt", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 100) };
  const runGrants = new FactoryRunGrants(fixture.db, "grant-tenant", () => now);
  let resume!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const awaitingRead = new Promise<void>(resolve => { reached = resolve; });
  let firstQuery = true;
  const delayedTransaction: MigrationDb = { execute: async query => {
    if (firstQuery) {
      firstQuery = false;
      reached();
      await blocked;
    }
    return fixture.db.execute(query);
  } };
  const mutableAuthority = { ...authority };
  const authorizing = runGrants.authorizeInTransaction(delayedTransaction, mutableAuthority);
  await awaitingRead;
  Object.assign(mutableAuthority, { tenantId: "foreign", projectId: "grant-other", runId: "other-run", executionEpoch: 2, grantRevision: 2 });
  resume();
  await expect(authorizing).resolves.toBeUndefined();
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
  const baseAttempt: FactoryAttemptAuthority = { tenantId: "grant-tenant", projectId: key.projectId, runId: request.runId, nodeInstanceId: "node", attemptId: "grant-attempt", candidateGeneration: 1, attemptNumber: 1, grantRevision: 4, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 1_000) };
  const runnerRequest = runnerRequestFor(baseAttempt);
  const attempt = { ...baseAttempt, requestDigest: factoryRunnerRequestDigest(runnerRequest) };
  const journal = new FactoryExecutionJournal(fixture.db, runGrants.authorizeInTransaction, () => new Date(now));
  await runGrants.authorize(attempt);
  await expect(runGrants.authorize({ ...attempt, tenantId: "foreign" })).rejects.toMatchObject({ code: "factory_forbidden" });
  await expect(runGrants.authorize({ ...attempt, executionEpoch: 2 })).rejects.toMatchObject({ code: "factory_forbidden" });
  expect(await journal.admit({ ...attempt, request: runnerRequest })).toMatchObject({ reused: false });
  const operation = { operationId: `${request.runId}:node:1:0`, operationIndex: 0, kind: "tool" as const, requestDigest: "a".repeat(64) };
  await journal.prepare(attempt, operation);
  await grants.revoke(admin, { ...key, expectedRevision: 4 });
  await expect(journal.dispatch(attempt, operation.operationId)).rejects.toMatchObject({ code: "factory_forbidden" });
  expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId}`))).toEqual([{ state: "prepared" }]);
  expect(await journal.cancel(attempt)).toBe(true);
  expect(await journal.confirmStopped(attempt)).toBe(true);
});

test("journal effect claims retain and recheck the durable service credential", async () => {
  const service: FactoryPrincipal = { kind: "service", id: "grant-http-service", authentication: "service" };
  await fixture.db.execute(sql`INSERT INTO service_accounts (id, name, created_by_user_id, project_id, max_tokens_per_day, expires_at) VALUES (${service.id}, 'Grant HTTP service', ${admin.id}, 'grant-project', 100, ${new Date(now + 1_000)})`);
  await grants.set(admin, { projectId: "grant-project", principal: service, action: "factory.run", expectedRevision: 0, expiresAtMs: now + 1_000 });
  const credentials = new FactoryServiceCredentials(fixture.db, "grant-tenant", grants);
  const expiresAtMs = (Math.floor(Date.now() / 1_000) + 600) * 1_000;
  const credential = await credentials.issue(admin, { projectId: "grant-project", serviceAccountId: service.id, scopes: ["chat"], expiresAtMs, expectedRevision: 0 }, "grant-http-service-credential");
  const request = { projectId: "grant-project", runId: "grant-http-service-run", definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "factory-v1", executionEpoch: 1, input: {}, principalId: service.id, principalKind: "service" as const, serviceCredential: credential };
  await new FactoryRecords(fixture.db, "grant-tenant").createRun(request, async () => {});
  const authority: FactoryAttemptAuthority = { tenantId: "grant-tenant", projectId: request.projectId, runId: request.runId, nodeInstanceId: "node", attemptId: "grant-http-service-attempt", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 1_000) };
  const runnerRequest = runnerRequestFor(authority);
  const attempt = { ...authority, requestDigest: factoryRunnerRequestDigest(runnerRequest) };
  const runGrants = new FactoryRunGrants(fixture.db, "grant-tenant", () => now);
  const journal = new FactoryExecutionJournal(fixture.db, runGrants.authorizeInTransaction, () => new Date(now));
  await journal.admit({ ...attempt, request: runnerRequest });
  const operation = { operationId: `${request.runId}:node:1:0`, operationIndex: 0, kind: "tool" as const, requestDigest: "a".repeat(64) };
  await journal.prepare(attempt, operation);
  await credentials.revoke(admin, { projectId: request.projectId, serviceAccountId: service.id, credentialId: credential.credentialId, expectedRevision: 1 }, "grant-http-service-credential-revoke");
  await expect(journal.dispatch(attempt, operation.operationId)).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  expect(rows(await fixture.db.execute(sql`SELECT state FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId}`))).toEqual([{ state: "prepared" }]);
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
