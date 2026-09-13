import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { s3ObjectKey } from "../../src/extensions/v4/blobs";
import { FactoryArtifacts } from "../../src/factory/artifacts";
import {
  FACTORY_MATERIAL_LIMITS,
  FACTORY_WORKSPACE_MATERIAL_PREFIX,
  FactoryAttemptMaterials,
  FactoryScopedMaterials,
  factoryMaterialChunkObjectId,
  factoryMaterialDigest,
  type FactoryMaterialIdentity,
} from "../../src/factory/artifact-materials";
import { signFactoryAttemptToken } from "../../src/factory/attempt-token";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../src/factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../src/factory/executions";
import { startFactoryExecutionGateway } from "../../src/factory/execution-gateway";
import { certificates } from "../../src/__tests__/helpers/factory-certificates";
import { privateHttpsCall } from "../../src/__tests__/helpers/factory-private-https-client";
import { factoryArtifactMaterialsConformance } from "../../src/__tests__/helpers/factory-artifact-materials-suite";
import { factoryMaterialGatewayConformance } from "../../src/__tests__/helpers/factory-material-gateway-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

const TENANT = "material-tenant";
const SECRET = "material-restart-secret";
const INSTALLATION = "installation-a";

async function realFixture(label: string) {
  const database = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/${label}/${randomUUID()}`);
  return {
    db: database.db,
    blobs: storage.blobs,
    client: storage.client,
    bucket: storage.bucket,
    prefix: storage.prefix,
    async close() { storage.close(); await database.close(); },
  };
}

factoryArtifactMaterialsConformance(() => realFixture("factory-materials"));
factoryMaterialGatewayConformance(() => realFixture("factory-material-gateway"));

const closes: Array<() => Promise<void>> = [];
const servers: Array<{ stop(): void }> = [];
const directories: string[] = [];
afterEach(async () => {
  servers.splice(0).forEach(server => { server.stop(); });
  await Promise.all(closes.splice(0).map(close => close()));
  const { rm } = await import("node:fs/promises");
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Everything a restarted process rebuilds from durable identity alone. */
async function guest() {
  const fixture = await realFixture("factory-material-restart");
  closes.push(fixture.close);
  const db = fixture.db;
  const projectId = `restart-project-${randomUUID()}`;
  const runId = `restart-run-${randomUUID()}`;
  const attemptId = `restart-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Restart', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const authority: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 900_000),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attemptId},${TENANT},${projectId},${runId},'node-a',0,1,1,1,6,0,${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const wraps: InstallationKeyWrap[] = [];
  const store: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };

  /** Builds a whole fresh service graph, exactly as a restarted process would. */
  const boot = async () => {
    const key = await InstallationDataKey.loadOrCreate(INSTALLATION, store, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(7) }));
    const blobs = new EncryptedBlobStore(fixture.blobs, key, TENANT);
    const artifacts = new FactoryArtifacts(db, blobs, TENANT);
    const journal = new FactoryExecutionJournal(db, async () => {});
    return {
      blobs, artifacts, journal,
      materials: new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority }),
      reader: new FactoryScopedMaterials({ database: db, artifacts, blobs }),
    };
  };
  const scope = { tenantId: TENANT, projectId, runId, attemptId, operationId: `${runId}:node-a:0:0` };
  return { fixture, db, authority, boot, scope };
}

test("PostgreSQL and S3 keep a guest's material across a full restart and return the same verified bytes", async () => {
  const { fixture, db, boot, scope } = await guest();
  const identity: FactoryMaterialIdentity = { ...scope, objectName: `${FACTORY_WORKSPACE_MATERIAL_PREFIX}transcript.json`, version: 1 };
  const content = new TextEncoder().encode(JSON.stringify({ transcript: "restart".repeat(4000), cursor: 11 }));
  const parts = [content.subarray(0, 12_000), content.subarray(12_000)];

  const first = await boot();
  await first.materials.begin(identity, "application/json", content.byteLength, parts.length);
  await first.materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(parts[0]!), encodedBytes: parts[0]!.byteLength }, parts[0]!);

  // The process dies mid-upload. A new one recovers by identity, not by local state.
  const second = await boot();
  expect((await second.materials.chunks(identity)).map(chunk => chunk.index)).toEqual([0]);
  await second.materials.writeChunk(identity, { index: 1, digest: factoryMaterialDigest(parts[1]!), encodedBytes: parts[1]!.byteLength }, parts[1]!);
  const artifact = await second.materials.seal(identity, factoryMaterialDigest(content));

  // A third process holds nothing but the reference and reads the exact bytes.
  const third = await boot();
  expect(await third.reader.read(scope, artifact)).toEqual(content);
  expect(await third.reader.readChunk(scope, artifact, 1)).toEqual(Uint8Array.from(parts[1]!));

  // Every chunk really lives in S3 under its own immutable version.
  const stored = rows<{ blob_digest: string; storage_version: string; chunk_index: number | string }>(await db.execute(sql`SELECT blob_digest, storage_version, chunk_index FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} ORDER BY chunk_index`));
  expect(stored).toHaveLength(2);
  for (const chunk of stored) {
    expect(chunk.storage_version).not.toBe(chunk.blob_digest);
    const key = s3ObjectKey(fixture.prefix, chunk.blob_digest);
    expect(key.endsWith(chunk.blob_digest)).toBe(true);
    const ciphertext = await fixture.blobs.getVersion(chunk.blob_digest, chunk.storage_version);
    expect(Buffer.from(ciphertext).includes(Buffer.from("restart"))).toBe(false);
    const bound = { tenantId: TENANT, objectId: factoryMaterialChunkObjectId(identity, Number(chunk.chunk_index)) };
    expect((await third.blobs.getBound(bound, chunk.blob_digest)).byteLength).toBeGreaterThan(0);
  }
}, 180_000);

test("a real guest uploads over mutual TLS, the gateway restarts, and the bytes still verify", async () => {
  const { db, authority, boot, scope } = await guest();
  const certs = await certificates(directories, TENANT);
  const services = await boot();
  const start = () => {
    const server = startFactoryExecutionGateway({
      journal: services.journal, authorizeAttempt: async () => {}, jwtSecret: SECRET, installationId: INSTALLATION,
      materials: verified => new FactoryAttemptMaterials({ database: db, artifacts: services.artifacts, blobs: services.blobs, journal: services.journal, authority: verified }),
      tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    });
    servers.push(server);
    return server;
  };
  const token = await signFactoryAttemptToken(authority, SECRET, INSTALLATION, 900);
  const name = "data/export.json";
  const content = new TextEncoder().encode(JSON.stringify({ rows: Array.from({ length: 3000 }, (_, index) => ({ index, value: `row-${index}` })) }));
  const parts = [content.subarray(0, 40_000), content.subarray(40_000)];

  const first = start();
  const object = (url: string) => `${url}/internal/factory/v1/executions/${encodeURIComponent(scope.attemptId)}/materials/${encodeURIComponent(scope.operationId)}/${encodeURIComponent(name)}/1`;
  const begun = await privateHttpsCall(object(first.url), certs, { method: "PUT", token, body: Buffer.from(JSON.stringify({ mediaType: "application/json", totalBytes: content.byteLength, chunkCount: parts.length })), headers: { "content-type": "application/json" } });
  expect(begun.status).toBe(201);
  const wrote = await privateHttpsCall(`${object(first.url)}/chunks/0`, certs, { method: "PUT", token, body: Buffer.from(parts[0]!), headers: { "content-type": "application/octet-stream", "x-ezcorp-factory-chunk-digest": factoryMaterialDigest(parts[0]!) } });
  expect(wrote.status).toBe(200);

  // The gateway process is replaced between chunks.
  first.stop();
  const second = start();
  const resumed = await privateHttpsCall(object(second.url), certs, { method: "GET", token, headers: { "content-type": "application/json" } });
  expect((JSON.parse(resumed.body.toString("utf8")) as { chunks: Array<{ index: number }> }).chunks.map(chunk => chunk.index)).toEqual([0]);
  await privateHttpsCall(`${object(second.url)}/chunks/1`, certs, { method: "PUT", token, body: Buffer.from(parts[1]!), headers: { "content-type": "application/octet-stream", "x-ezcorp-factory-chunk-digest": factoryMaterialDigest(parts[1]!) } });
  const sealed = await privateHttpsCall(`${object(second.url)}/seal`, certs, { method: "POST", token, body: Buffer.from(JSON.stringify({ digest: factoryMaterialDigest(content) })), headers: { "content-type": "application/json" } });
  expect(sealed.status).toBe(200);
  const artifact = (JSON.parse(sealed.body.toString("utf8")) as { artifact: { artifactId: string; digest: string; encodedBytes: number } }).artifact;

  const readBack = await privateHttpsCall(`${object(second.url)}/chunks/1`, certs, { method: "GET", token, headers: { "content-type": "application/json" }, responseLimitBytes: FACTORY_MATERIAL_LIMITS.maxChunkBytes });
  expect(Buffer.from(readBack.body).equals(Buffer.from(parts[1]!))).toBe(true);

  const third = await boot();
  expect(await third.reader.read(scope, artifact)).toEqual(content);
}, 180_000);
