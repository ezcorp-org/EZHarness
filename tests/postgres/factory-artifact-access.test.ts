import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { s3ObjectKey } from "../../src/extensions/v4/blobs";
import { FactoryArtifactAccess } from "../../src/factory/artifact-access";
import { FactoryArtifacts } from "../../src/factory/artifacts";
import { FactoryGrants, type FactoryPrincipal } from "../../src/factory/grants";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closes.splice(0).map(close => close())); });

async function fixture() {
  const database = await setupFactoryPostgres(); closes.push(database.close);
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-artifact-access/${randomUUID()}`); closes.push(async () => storage.close());
  const tenantId = "artifact-access-tenant";
  const sourceProjectId = `artifact-source-${randomUUID()}`;
  const targetProjectId = `artifact-target-${randomUUID()}`;
  const sourceRunId = `artifact-run-${randomUUID()}`;
  const actor: FactoryPrincipal = { kind: "user", id: `artifact-owner-${randomUUID()}`, authentication: "session" };
  await database.db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${tenantId}, 1)`);
  for (const projectId of [sourceProjectId, targetProjectId]) {
    await database.db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, ${projectId}, ${`/${projectId}`})`);
    await database.db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
  }
  await database.db.execute(sql`INSERT INTO users(id, email, password_hash, name, role) VALUES (${actor.id}, ${`${actor.id}@example.test`}, 'not-a-login', 'Artifact owner', 'admin')`);
  await database.db.execute(sql`INSERT INTO project_members(id, project_id, user_id, role) VALUES (${`membership-${randomUUID()}`}, ${sourceProjectId}, ${actor.id}, 'owner')`);
  await database.db.execute(sql`INSERT INTO factory_grants(tenant_id, project_id, principal_kind, principal_id, action, issuer_id, revision) VALUES (${tenantId}, ${sourceProjectId}, 'user', ${actor.id}, 'factory.operate', ${actor.id}, 1)`);
  await database.db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, ${sourceProjectId}, ${sourceRunId}, ${`sha256:${"a".repeat(64)}`}, 'test', 1, ${`sha256:${"b".repeat(64)}`}, '{}')`);
  const artifacts = new FactoryArtifacts(database.db, storage.blobs, tenantId);
  const access = new FactoryArtifactAccess(database.db, tenantId, new FactoryGrants(database.db, tenantId), artifacts);
  return { database: database.db, storage, tenantId, sourceProjectId, targetProjectId, sourceRunId, actor, artifacts, access };
}

test("PostgreSQL/S3 shared access binds source scope, versioned bytes, media and revocation", async () => {
  const { database, storage, tenantId, sourceProjectId, targetProjectId, sourceRunId, actor, artifacts, access } = await fixture();
  const content = new Uint8Array(96 * 1024).fill(11);
  const reference = await artifacts.stage({ tenantId, projectId: sourceProjectId, logicalRunId: sourceRunId, interpreterId: "artifact-reader" }, "candidate_output", content, { interpreterScoped: false, candidateNodeInstanceId: "artifact-node", candidateGeneration: 1 });
  const artifact = { artifactId: reference.objectId, digest: reference.digest, encodedBytes: reference.encodedBytes };
  await access.grant(actor, { sourceProjectId, sourceRunId, targetProjectId, artifact, mediaType: "application/octet-stream" }, "artifact-access-grant");
  const read = () => database.transaction(transaction => access.loadSharedInTransaction(transaction, targetProjectId, artifact, "application/octet-stream"));
  const selectedVersion = await database.execute(sql`SELECT storage_version FROM factory_artifacts WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`) as unknown as { rows?: Array<{ storage_version: string }> } | Array<{ storage_version: string }>;
  const expected = { artifact, mediaType: "application/octet-stream", storageVersion: (Array.isArray(selectedVersion) ? selectedVersion : selectedVersion.rows)![0]!.storage_version, content };
  expect(await read()).toEqual(expected);
  await expect(database.transaction(transaction => access.loadSharedInTransaction(transaction, `foreign-${targetProjectId}`, artifact, "application/octet-stream"))).rejects.toMatchObject({ code: "factory_artifact_unavailable" });

  const selected = await database.execute(sql`SELECT blob_digest, storage_version FROM factory_artifacts WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`) as unknown as { rows?: Array<{ blob_digest: string; storage_version: string }> } | Array<{ blob_digest: string; storage_version: string }>;
  const row = (Array.isArray(selected) ? selected : selected.rows)![0]!;
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: s3ObjectKey(storage.prefix, row.blob_digest), Body: new Uint8Array(content.byteLength).fill(12) }));
  expect(await read()).toEqual(expected);
  const changedVersion = await storage.blobs.version(row.blob_digest);
  expect(changedVersion).not.toBe(row.storage_version);
  await database.execute(sql`UPDATE factory_artifacts SET storage_version=${changedVersion} WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await database.execute(sql`UPDATE factory_artifacts SET storage_version=${row.storage_version} WHERE tenant_id=${tenantId} AND project_id=${sourceProjectId} AND object_id=${artifact.artifactId}`);

  expect((await access.revoke(actor, { sourceProjectId, targetProjectId, artifact }, "artifact-access-revoke")).revoked).toBe(true);
  await expect(read()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
});
