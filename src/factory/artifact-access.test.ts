import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { digestBytes, FileBlobStore } from "../extensions/v4/blobs";
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

function access() { return new FactoryArtifactAccess(fixture.db, tenantId, new FactoryGrants(fixture.db, tenantId), reader); }
function read() { return fixture.db.transaction(transaction => access().loadSharedInTransaction(transaction, targetProjectId, artifact, "application/json")); }

test("human-issued exact share verifies media, storage version, digest and bytes", async () => {
  const granted = await access().grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/json" }, "access-grant-1");
  expect(granted).toMatchObject({ artifact, artifactKind: "execution_manifest", mediaType: "application/json", storageVersion: "version-1", revoked: false });
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
