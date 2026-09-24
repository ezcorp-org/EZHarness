import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { digestBytes, digestObject, FileBlobStore } from "../extensions/v4/blobs";
import { FactoryArtifactAccess, type FactoryArtifactTransactionReader } from "./artifact-access";
import { FactoryArtifacts } from "./artifacts";
import { FactoryGrants, type FactoryPrincipal } from "./grants";

const tenantId = "access-tenant";
const sourceProjectId = "access-source";
const targetProjectId = "access-target";
const sourceRunId = "access-source-run";
const actor: FactoryPrincipal = { kind: "user", id: "access-owner", authentication: "session" };
const content = new TextEncoder().encode('{"shared":true}');
const digest = `sha256:${digestBytes(content)}`;
const artifact = { artifactId: "access-artifact", digest, encodedBytes: content.byteLength };
let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let served = content;
const directories: string[] = [];

const reader: FactoryArtifactTransactionReader = {
  async loadInTransaction(_transaction, _identity, reference, kinds) {
    if (reference.objectId !== artifact.artifactId || kinds.length !== 1 || kinds[0] !== "execution_manifest") throw new Error("unexpected artifact read");
    return { reference, kind: "execution_manifest", content: served };
  },
};

beforeAll(async () => {
  fixture = await setupTestDb();
  const db = fixture.db;
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id) VALUES (1, ${tenantId})`);
  for (const projectId of [sourceProjectId, targetProjectId]) {
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, ${projectId}, ${`/${projectId}`})`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
  }
  await db.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES (${actor.id}, 'access@example.test', 'not-a-login', 'Access owner', 'admin')`);
  await db.execute(sql`INSERT INTO project_members(id, project_id, user_id, role) VALUES ('access-membership', ${sourceProjectId}, ${actor.id}, 'owner')`);
  await db.execute(sql`INSERT INTO factory_grants(tenant_id, project_id, principal_kind, principal_id, action, issuer_id, revision) VALUES (${tenantId}, ${sourceProjectId}, 'user', ${actor.id}, 'factory.operate', ${actor.id}, 1)`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, ${sourceProjectId}, ${sourceRunId}, ${`sha256:${"a".repeat(64)}`}, 'immutable-build', 1, ${`sha256:${"b".repeat(64)}`}, '{}')`);
  await db.execute(sql`INSERT INTO factory_artifacts(object_id, tenant_id, project_id, run_id, interpreter_id, kind, digest, blob_digest, storage_version, encoded_bytes) VALUES (${artifact.artifactId}, ${tenantId}, ${sourceProjectId}, ${sourceRunId}, NULL, 'execution_manifest', ${artifact.digest}, ${digest.slice(7)}, 'version-1', ${artifact.encodedBytes})`);
});
afterAll(async () => { await fixture?.pglite.close(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

/**
 * The seal exactly as `artifact-access.ts` computed it before W04b (at d5ee52309), written out here
 * rather than imported, so a change to the product's formula cannot also change this pin.
 */
function preW04bSeal(input: { sourceProjectId: string; sourceRunId: string; targetProjectId: string; artifact: typeof artifact; artifactKind: string; mediaType: string; issuerId: string; issuerGrantRevision: number; storageVersion: string }): string {
  return `sha256:${digestObject({ tenantId, sourceProjectId: input.sourceProjectId, sourceRunId: input.sourceRunId, targetProjectId: input.targetProjectId, artifact: input.artifact, artifactKind: input.artifactKind, mediaType: input.mediaType, issuerId: input.issuerId, issuerGrantRevision: input.issuerGrantRevision, storageVersion: input.storageVersion })}`;
}

function access() { return new FactoryArtifactAccess(fixture.db, tenantId, new FactoryGrants(fixture.db, tenantId), reader); }
function read() { return fixture.db.transaction(transaction => access().loadSharedInTransaction(transaction, targetProjectId, artifact, "application/json")); }

test("human-issued exact share verifies media, storage version, digest and bytes", async () => {
  const granted = await access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-grant-1");
  expect(granted).toMatchObject({ artifact, artifactKind: "execution_manifest", mediaType: "application/json", storageVersion: "version-1", revoked: false, grantRevision: 1 });
  // W04b: a first grant seals exactly as before, so every row written before the upgrade still verifies.
  const pinned = preW04bSeal({ sourceProjectId, sourceRunId, targetProjectId, artifact, artifactKind: "execution_manifest", mediaType: "application/json", issuerId: actor.id, issuerGrantRevision: 1, storageVersion: "version-1" });
  expect(granted.protectedDigest).toBe(pinned);
  expect(await read()).toEqual({ artifact, mediaType: "application/json", storageVersion: "version-1", content });
  await expect(fixture.db.transaction(transaction => access().loadSharedInTransaction(transaction, "foreign-target", artifact, "application/json"))).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await expect(fixture.db.transaction(transaction => access().loadSharedInTransaction(transaction, targetProjectId, artifact, "text/plain"))).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await expect(fixture.db.transaction(transaction => access().loadSharedInTransaction(transaction, targetProjectId, { ...artifact, digest: "sha256:invalid" }, "application/json"))).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
});

test("sealed host metadata and corrupt bytes fail closed without source disclosure", async () => {
  await fixture.db.execute(sql`UPDATE factory_artifacts SET storage_version='version-2' WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await fixture.db.execute(sql`UPDATE factory_artifacts SET storage_version='version-1' WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`);
  served = new TextEncoder().encode('{"shared":false}');
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  served = content;
  await fixture.db.execute(sql`UPDATE factory_artifact_read_grants SET media_type='text/plain' WHERE tenant_id=${tenantId} AND source_project_id=${sourceProjectId} AND source_artifact_id=${artifact.artifactId} AND target_project_id=${targetProjectId}`);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await fixture.db.execute(sql`UPDATE factory_artifact_read_grants SET media_type='application/json' WHERE tenant_id=${tenantId} AND source_project_id=${sourceProjectId} AND source_artifact_id=${artifact.artifactId} AND target_project_id=${targetProjectId}`);
});

test("shared reads use the real immutable artifact reader for a bounded large object", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-artifact-access-")); directories.push(root);
  const artifacts = new FactoryArtifacts(fixture.db, new FileBlobStore(root), tenantId);
  const largeContent = new Uint8Array(96 * 1024).fill(7);
  const stored = await artifacts.stage({ tenantId, projectId: sourceProjectId, logicalRunId: sourceRunId, interpreterId: "access-reader" }, "candidate_output", largeContent, { interpreterScoped: false, candidateNodeInstanceId: "access-node", candidateGeneration: 1 });
  const largeArtifact = { artifactId: stored.objectId, digest: stored.digest, encodedBytes: stored.encodedBytes };
  const realAccess = new FactoryArtifactAccess(fixture.db, tenantId, new FactoryGrants(fixture.db, tenantId), artifacts);
  await realAccess.grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact: largeArtifact, mediaType: "application/octet-stream" }, "access-grant-large");
  const loaded = await fixture.db.transaction(transaction => realAccess.loadSharedInTransaction(transaction, targetProjectId, largeArtifact, "application/octet-stream"));
  expect(loaded).toEqual({ artifact: largeArtifact, mediaType: "application/octet-stream", storageVersion: largeArtifact.digest.slice("sha256:".length), content: largeContent });
});

test("source human revocation is transactional and does not transfer release authority", async () => {
  const revoked = await access().revoke(actor, { sourceProjectId, targetProjectId, artifact }, "access-revoke-1");
  expect(revoked.revoked).toBe(true);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  expect(() => access().grant({ kind: "service", id: "service", authentication: "service" }, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "service-grant")).toThrow("factory_human_required");
  expect(() => access().grant({ ...actor, authentication: "api-key" }, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "api-key-grant")).toThrow("factory_human_required");
});

const grantRows = async () => (await fixture.db.execute(sql`SELECT grant_revision, revoked_at IS NOT NULL AS revoked, protected_digest FROM factory_artifact_read_grants
  WHERE tenant_id=${tenantId} AND source_project_id=${sourceProjectId} AND source_artifact_id=${artifact.artifactId} AND target_project_id=${targetProjectId} ORDER BY grant_revision`) as unknown as { rows: Array<{ grant_revision: number | string; revoked: boolean; protected_digest: string }> }).rows
  .map(row => ({ grantRevision: Number(row.grant_revision), revoked: row.revoked, protectedDigest: row.protected_digest }));
const auditActions = async () => (await fixture.db.execute(sql`SELECT id, action FROM audit_log WHERE target=${artifact.artifactId} AND action LIKE 'factory.artifact.read.%' ORDER BY created_at, id`) as unknown as { rows: Array<{ id: string; action: string }> }).rows;

test("a revoked share can be granted again as a new active row, and the revoked row stays for audit", async () => {
  // The share was revoked by the previous case.
  const again = await access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-regrant-1");
  expect(again).toMatchObject({ artifact, revoked: false });
  expect(await read()).toEqual({ artifact, mediaType: "application/json", storageVersion: "version-1", content });
  const rowsAfter = await grantRows();
  expect(rowsAfter.map(row => [row.grantRevision, row.revoked])).toEqual([[1, true], [2, false]]);
  // The new grant is its own sealed row, never the old one reactivated.
  expect(rowsAfter[1]!.protectedDigest).not.toBe(rowsAfter[0]!.protectedDigest);
  expect(again.protectedDigest).toBe(rowsAfter[1]!.protectedDigest);
  expect((await auditActions()).map(entry => entry.action)).toEqual(["factory.artifact.read.granted", "factory.artifact.read.revoked", "factory.artifact.read.granted"]);
});

test("a share that is still active conflicts, and a revoke reaches only the active row", async () => {
  await expect(access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-regrant-while-active")).rejects.toMatchObject({ code: "factory_artifact_grant_conflict" });
  expect((await access().revoke(actor, { sourceProjectId, targetProjectId, artifact }, "access-revoke-2")).revoked).toBe(true);
  expect((await grantRows()).map(row => [row.grantRevision, row.revoked])).toEqual([[1, true], [2, true]]);
  // A second revoke finds no active row and answers with the latest revoked grant, writing nothing.
  const audited = (await auditActions()).length;
  expect(await access().revoke(actor, { sourceProjectId, targetProjectId, artifact }, "access-revoke-3")).toMatchObject({ revoked: true, protectedDigest: (await grantRows())[1]!.protectedDigest });
  expect((await auditActions()).length).toBe(audited);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
});

test("two re-grants racing after a revoke produce one active row and one typed conflict", async () => {
  const results = await Promise.allSettled([
    access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-race-a"),
    access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-race-b"),
  ]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "factory_artifact_grant_conflict" } });
  expect((await grantRows()).map(row => [row.grantRevision, row.revoked])).toEqual([[1, true], [2, true], [3, false]]);
});
