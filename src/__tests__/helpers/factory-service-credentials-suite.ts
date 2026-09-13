import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FactoryRecords } from "../../factory/records";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryServiceCredentials } from "../../factory/service-credentials";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import type { TransactionalDb } from "../../db/migrations/types";

interface CredentialFixture { readonly db: TransactionalDb; close(): Promise<void> }

export function factoryServiceCredentialsConformance(createFixture: () => Promise<CredentialFixture>): void {
let fixture: CredentialFixture;
let database: TransactionalDb;
let grants: FactoryGrants;
let credentials: FactoryServiceCredentials;
const admin: FactoryPrincipal = { kind: "user", id: "credential-admin", authentication: "session" };
const member: FactoryPrincipal = { kind: "user", id: "credential-member", authentication: "session" };
const service: FactoryPrincipal = { kind: "service", id: "credential-service", authentication: "service" };

beforeAll(async () => {
  fixture = await createFixture();
  database = fixture.db;
  await database.execute(sql`INSERT INTO projects (id, name, path) VALUES ('credential-project', 'Credentials', '/tmp/credentials'), ('credential-other', 'Other', '/tmp/other')`);
  await database.execute(sql`INSERT INTO users (id, email, password_hash, name, role) VALUES
    (${admin.id}, 'credential-admin@example.test', 'not-a-login', 'Admin', 'admin'),
    (${member.id}, 'credential-member@example.test', 'not-a-login', 'Member', 'member')`);
  await database.execute(sql`INSERT INTO service_accounts (id, name, created_by_user_id, project_id, max_tokens_per_day, expires_at)
    VALUES (${service.id}, 'Credential service', ${admin.id}, 'credential-project', 100, ${new Date(Date.now() + 3_600_000)})`);
  const records = new FactoryRecords(database, "credential-tenant");
  await records.bindInstallation();
  await records.bindProject("credential-project");
  await records.bindProject("credential-other");
  grants = new FactoryGrants(database, "credential-tenant");
  credentials = new FactoryServiceCredentials(database, "credential-tenant", grants);
});
afterAll(async () => { await fixture?.close(); });

test("issues one deterministic durable record and rechecks it on retries", async () => {
  const expiresAtMs = (Math.floor(Date.now() / 1_000) + 600) * 1_000;
  const request = { projectId: "credential-project", serviceAccountId: service.id, scopes: ["read", "chat"] as const, expiresAtMs, expectedRevision: 0 as const };
  const issued = await credentials.issue(admin, request, "credential-issue");
  expect(await credentials.issue(admin, request, "credential-issue")).toEqual(issued);
  expect(issued).toMatchObject({ revision: 1, scopes: ["read", "chat"], expiresAtMs, revoked: false, issuedByUserId: admin.id });
  expect(issued.issuedAtMs % 1_000).toBe(0);
  expect(rows(await database.execute(sql`SELECT id FROM audit_log WHERE action='factory.service-credential.issued'`))).toHaveLength(1);
  expect(rows<{ response_json: string }>(await database.execute(sql`SELECT response_json FROM factory_mutation_receipts WHERE idempotency_key='credential-issue'`))[0]!.response_json).not.toContain("ezkfsvc_");
  await expect(credentials.issue(admin, { ...request, scopes: ["write"] }, "credential-issue")).rejects.toMatchObject({ code: "idempotency_conflict" });
});

test("authenticates exact current scope, project, account and grant authority", async () => {
  const issued = rows<{ response_json: string }>(await database.execute(sql`SELECT response_json FROM factory_mutation_receipts WHERE idempotency_key='credential-issue'`))[0]!;
  const record = JSON.parse(issued.response_json);
  expect(await credentials.authenticate({ tokenUse: "factory-service", ...record }, "read")).toMatchObject({ credentialId: record.credentialId });
  await expect(credentials.authenticate({ tokenUse: "factory-service", ...record }, "write")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await grants.set(admin, { projectId: "credential-project", principal: service, action: "factory.run", expectedRevision: 0, expiresAtMs: record.expiresAtMs });
  const publicPrincipal: FactoryPrincipal = { ...service, credential: record };
  expect((await grants.authorize(publicPrincipal, "credential-project", "factory.run")).revision).toBe(1);
  await expect(grants.authorize(publicPrincipal, "credential-other", "read")).rejects.toMatchObject({ code: "factory_forbidden" });
});

test("revocation fences stale and cached credentials immediately", async () => {
  const stored = JSON.parse(rows<{ response_json: string }>(await database.execute(sql`SELECT response_json FROM factory_mutation_receipts WHERE idempotency_key='credential-issue'`))[0]!.response_json);
  const revoked = await credentials.revoke(admin, { projectId: stored.projectId, serviceAccountId: stored.serviceAccountId, credentialId: stored.credentialId, expectedRevision: 1 }, "credential-revoke");
  expect(revoked).toMatchObject({ revision: 2, revoked: true });
  expect(await credentials.revoke(admin, { projectId: stored.projectId, serviceAccountId: stored.serviceAccountId, credentialId: stored.credentialId, expectedRevision: 1 }, "credential-revoke")).toEqual(revoked);
  await expect(credentials.authenticate({ tokenUse: "factory-service", ...stored }, "read")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await expect(credentials.issue(admin, { projectId: stored.projectId, serviceAccountId: stored.serviceAccountId, scopes: stored.scopes, expiresAtMs: stored.expiresAtMs, expectedRevision: 0 }, "credential-issue")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
});

test("expired rows and caller-owned claim mutation cannot regain authority", async () => {
  const issuedAtMs = (Math.floor(Date.now() / 1_000) - 2) * 1_000;
  const expiresAtMs = issuedAtMs + 1_000;
  await database.execute(sql`INSERT INTO factory_service_credentials
    (tenant_id, project_id, service_account_id, credential_id, scopes, revision, issued_by_user_id, issued_at, expires_at)
    VALUES ('credential-tenant', 'credential-project', ${service.id}, 'expired-credential', '["read"]'::jsonb, 1, ${admin.id}, ${new Date(issuedAtMs)}, ${new Date(expiresAtMs)})`);
  const claims = { tokenUse: "factory-service" as const, serviceAccountId: service.id, projectId: "credential-project", credentialId: "expired-credential", revision: 1, scopes: ["read"] as ("read" | "write")[], issuedAtMs, expiresAtMs };
  const authentication = credentials.authenticate(claims, "read");
  claims.credentialId = "attacker-changed";
  claims.scopes[0] = "write";
  await expect(authentication).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  const liveIssuedAtMs = Math.floor(Date.now() / 1_000) * 1_000;
  const liveExpiresAtMs = liveIssuedAtMs + 60_000;
  await database.execute(sql`INSERT INTO factory_service_credentials
    (tenant_id, project_id, service_account_id, credential_id, scopes, revision, issued_by_user_id, issued_at, expires_at)
    VALUES ('credential-tenant', 'credential-project', ${service.id}, 'snapshot-credential', '["read"]'::jsonb, 1, ${admin.id}, ${new Date(liveIssuedAtMs)}, ${new Date(liveExpiresAtMs)})`);
  const mutable = { tokenUse: "factory-service" as const, serviceAccountId: service.id, projectId: "credential-project", credentialId: "snapshot-credential", revision: 1, scopes: ["read"] as ("read" | "write")[], issuedAtMs: liveIssuedAtMs, expiresAtMs: liveExpiresAtMs };
  const snapshotted = credentials.authenticate(mutable, "read");
  mutable.credentialId = "attacker-changed";
  mutable.scopes[0] = "write";
  expect(await snapshotted).toMatchObject({ credentialId: "snapshot-credential", scopes: ["read"] });
});

test("rejects non-human, non-admin, foreign, disabled, expired and invalid issuance", async () => {
  const expiry = (Math.floor(Date.now() / 1_000) + 300) * 1_000;
  const base = { projectId: "credential-project", serviceAccountId: service.id, scopes: ["read"] as const, expiresAtMs: expiry, expectedRevision: 0 as const };
  await expect(credentials.issue({ ...admin, authentication: "api-key" }, base, "bad-auth")).rejects.toMatchObject({ code: "factory_human_required" });
  await expect(credentials.issue(member, base, "bad-member")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await database.execute(sql`UPDATE users SET status='inactive' WHERE id=${admin.id}`);
  await expect(credentials.issue(admin, base, "bad-inactive-admin")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await database.execute(sql`UPDATE users SET status='active' WHERE id=${admin.id}`);
  await expect(credentials.issue(admin, { ...base, projectId: "credential-other" }, "bad-project")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await expect(credentials.issue(admin, { ...base, expiresAtMs: expiry + 4_000_000 }, "bad-expiry")).rejects.toMatchObject({ code: "factory_service_credential_invalid" });
  await database.execute(sql`UPDATE service_accounts SET enabled=FALSE WHERE id=${service.id}`);
  await expect(credentials.issue(admin, base, "bad-disabled")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  await database.execute(sql`UPDATE service_accounts SET enabled=TRUE, expires_at=${new Date(Date.now() - 1_000)} WHERE id=${service.id}`);
  await expect(credentials.issue(admin, base, "bad-account-expiry")).rejects.toMatchObject({ code: "factory_service_credential_forbidden" });
  const issuedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  await expect(Promise.resolve(database.execute(sql`INSERT INTO factory_service_credentials
    (tenant_id, project_id, service_account_id, credential_id, scopes, revision, issued_by_user_id, issued_at, expires_at)
    VALUES ('credential-tenant', 'credential-other', ${service.id}, 'foreign-project-credential', '["read"]'::jsonb, 1, ${admin.id}, ${issuedAt}, ${new Date(issuedAt.getTime() + 60_000)})`))).rejects.toBeDefined();
});
}
