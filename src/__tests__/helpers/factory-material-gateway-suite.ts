import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import {
  FACTORY_MATERIAL_LIMITS,
  FACTORY_WORKSPACE_MATERIAL_PREFIX,
  FactoryAttemptMaterials,
  FactoryScopedMaterials,
  factoryMaterialDigest,
} from "../../factory/artifact-materials";
import { signFactoryAttemptToken } from "../../factory/attempt-token";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { FACTORY_GATEWAY_MATERIAL_ENVELOPE_BYTES, startFactoryExecutionGateway } from "../../factory/execution-gateway";
import { certificates, type Certificates } from "./factory-certificates";
import { privateHttpsCall } from "./factory-private-https-client";

const TENANT = "tenant-a";
const SECRET = "material-gateway-secret";
const INSTALLATION = "installation-a";

export interface FactoryMaterialGatewayFixture {
  readonly db: TransactionalDb;
  /** Supplied by the real PostgreSQL producer so the same routes run against S3. */
  readonly blobs?: BlobStore;
  close(): Promise<void>;
}

export function factoryMaterialGatewayConformance(create: () => Promise<FactoryMaterialGatewayFixture>): void {
describe("C02 gateway material routes", () => {
const databases: Array<{ close(): Promise<void> }> = [];
const servers: { stop(): void }[] = [];
const directories: string[] = [];

afterEach(async () => {
  servers.splice(0).forEach(server => { server.stop(); });
  await Promise.all(databases.splice(0).map(database => database.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const database = await create();
  databases.push(database);
  const db = database.db;
  const projectId = `gateway-project-${randomUUID()}`;
  const runId = `gateway-run-${randomUUID()}`;
  const attemptId = `gateway-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Gateway', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const authority: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 600_000),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${attemptId},${TENANT},${projectId},${runId},'node-a',0,1,1,1,6,0,${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const root = await mkdtemp(join(tmpdir(), "factory-material-gateway-"));
  directories.push(root);
  const wraps: InstallationKeyWrap[] = [];
  const store: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate(INSTALLATION, store, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(5) }));
  const blobs = new EncryptedBlobStore(database.blobs ?? new FileBlobStore(root), key, TENANT);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const certs = await certificates(directories);
  const server = startFactoryExecutionGateway({
    journal, authorizeAttempt: async () => {}, jwtSecret: SECRET, installationId: INSTALLATION,
    materials: verified => new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: verified }),
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
  });
  servers.push(server);
  const token = await signFactoryAttemptToken(authority, SECRET, INSTALLATION, 600);
  const operationId = `${runId}:node-a:0:0`;
  const base = `${server.url}/internal/factory/v1/executions/${encodeURIComponent(attemptId)}/materials/${encodeURIComponent(operationId)}`;
  return { db, certs, server, token, authority, reader, base, operationId, scope: { tenantId: TENANT, projectId, runId, attemptId, operationId } };
}

type Call = { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> };

async function json(url: string, certs: Certificates, token: string, method: string, body?: unknown): Promise<{ status: number; value: Record<string, unknown> }> {
  const result: Call = await privateHttpsCall(url, certs, { method, token, ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }), headers: { "content-type": "application/json" } });
  return { status: result.status, value: JSON.parse(result.body.toString("utf8")) as Record<string, unknown> };
}

async function chunk(url: string, certs: Certificates, token: string, method: string, content?: Uint8Array, digest?: string): Promise<Call> {
  return privateHttpsCall(url, certs, {
    method, token, ...(content === undefined ? {} : { body: Buffer.from(content) }),
    headers: { "content-type": "application/octet-stream", ...(digest === undefined ? {} : { "x-ezcorp-factory-chunk-digest": digest }) },
  });
}

test("a runner stores, lists, reads back and seals a workspace checkpoint over the private envelope", async () => {
  const { certs, token, base, reader, scope } = await setup();
  const name = `${FACTORY_WORKSPACE_MATERIAL_PREFIX}checkpoint.json`;
  const object = `${base}/${encodeURIComponent(name)}/1`;
  const content = new TextEncoder().encode(JSON.stringify({ transcript: "y".repeat(400), cursor: 3 }));
  const parts = [content.subarray(0, 200), content.subarray(200)];

  const begun = await json(object, certs, token, "PUT", { mediaType: "application/json", totalBytes: content.byteLength, chunkCount: parts.length });
  expect(begun.status).toBe(201);
  expect(begun.value.material).toMatchObject({ objectName: name, version: 1, sealed: false, chunkCount: 2 });
  expect(await json(object, certs, token, "PUT", { mediaType: "application/json", totalBytes: content.byteLength, chunkCount: parts.length })).toMatchObject({ status: 201 });

  for (const [index, part] of parts.entries()) {
    const written = await chunk(`${object}/chunks/${index}`, certs, token, "PUT", part, factoryMaterialDigest(part));
    expect(written.status).toBe(200);
  }
  expect((await json(object, certs, token, "GET")).value.chunks).toHaveLength(2);

  const read = await chunk(`${object}/chunks/0`, certs, token, "GET");
  expect(read.status).toBe(200);
  expect(read.headers["content-type"]).toBe("application/octet-stream");
  expect(read.body.equals(Buffer.from(parts[0]!))).toBe(true);

  const sealed = await json(`${object}/seal`, certs, token, "POST", { digest: factoryMaterialDigest(content) });
  expect(sealed.status).toBe(200);
  const artifact = sealed.value.artifact as { artifactId: string; digest: string; encodedBytes: number };
  expect(artifact.artifactId).toMatch(/^factory-artifact-/u);

  const listed = await json(base, certs, token, "GET");
  expect(listed.status).toBe(200);
  expect(listed.value.materials).toHaveLength(1);
  expect((listed.value.materials as Array<Record<string, unknown>>)[0]).toMatchObject({ sealed: true, objectName: name });

  // The scoped reader returns the same verified bytes the runner uploaded.
  expect(await reader.read(scope, artifact)).toEqual(content);
});

test("the gateway carries a whole maximum-size chunk and refuses one byte past it", async () => {
  const { certs, token, base } = await setup();
  const object = `${base}/${encodeURIComponent("data/export.bin")}/1`;
  const size = FACTORY_MATERIAL_LIMITS.maxChunkBytes;
  const content = new Uint8Array(size);
  for (let index = 0; index < size; index += 4093) content[index] = index % 251;
  await json(object, certs, token, "PUT", { mediaType: "application/octet-stream", totalBytes: size, chunkCount: 1 });
  const written = await chunk(`${object}/chunks/0`, certs, token, "PUT", content, factoryMaterialDigest(content));
  expect(written.status).toBe(200);
  const read = await chunk(`${object}/chunks/0`, certs, token, "GET");
  expect(read.body.byteLength).toBe(size);
  expect(read.body.equals(Buffer.from(content))).toBe(true);

  // One byte past the chunk limit still fits the envelope, so the service refuses it.
  const overChunk = new Uint8Array(size + 1);
  const refused = await chunk(`${object}/chunks/0`, certs, token, "PUT", overChunk, factoryMaterialDigest(overChunk));
  expect(refused.status).toBe(400);
  expect(JSON.parse(refused.body.toString("utf8"))).toEqual({ error: "factory_material_chunk_bytes_invalid" });

  // One byte past the envelope never reaches the handler at all.
  const overEnvelope = await chunk(`${object}/chunks/0`, certs, token, "PUT", new Uint8Array(FACTORY_GATEWAY_MATERIAL_ENVELOPE_BYTES + 1), `sha256:${"0".repeat(64)}`);
  expect(overEnvelope.status).toBe(413);
  expect(JSON.parse(overEnvelope.body.toString("utf8"))).toEqual({ error: "request_too_large" });
}, 120_000);

test("a material route needs the attempt token, the tenant certificate and the version header", async () => {
  const { certs, token, base, server, authority } = await setup();
  const object = `${base}/${encodeURIComponent("data/denied.json")}/1`;
  const body = { mediaType: "application/json", totalBytes: 8, chunkCount: 1 };

  const noToken = await privateHttpsCall(object, certs, { method: "PUT", body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } });
  expect(noToken.status).toBe(401);

  const foreign = await privateHttpsCall(object, certs, { method: "PUT", token, certificate: "foreign", body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json" } });
  expect(foreign.status).toBe(401);

  const wrongVersion = await privateHttpsCall(object, certs, { method: "PUT", token, body: Buffer.from(JSON.stringify(body)), headers: { "content-type": "application/json", "x-ezcorp-factory-version": "2" } });
  expect(wrongVersion.status).toBe(400);

  // A token for a different attempt cannot reach this attempt's materials.
  const other = await signFactoryAttemptToken({ ...authority, attemptId: "other-attempt" }, SECRET, INSTALLATION, 600);
  expect((await json(object, certs, other, "PUT", body)).status).toBe(401);

  // A path whose attempt segment does not match the token is refused.
  const mismatched = `${server.url}/internal/factory/v1/executions/${encodeURIComponent("other-attempt")}/materials/x/y/1`;
  expect((await json(mismatched, certs, token, "PUT", body)).status).toBe(401);
});

test("the gateway maps material conflicts, unknown objects and denied methods to distinct statuses", async () => {
  const { certs, token, base } = await setup();
  const name = "data/mapped.json";
  const object = `${base}/${encodeURIComponent(name)}/1`;
  const content = new TextEncoder().encode("mapped material");

  expect((await json(`${object}/chunks/0`.replace("/chunks/0", ""), certs, token, "GET")).status).toBe(404);
  expect((await json(object, certs, token, "PUT", { mediaType: "application/json", totalBytes: content.byteLength, chunkCount: 1 })).status).toBe(201);
  expect((await json(object, certs, token, "PUT", { mediaType: "application/json", totalBytes: content.byteLength + 1, chunkCount: 1 })).status).toBe(409);
  expect((await json(`${base}/${encodeURIComponent(name)}/3`, certs, token, "PUT", { mediaType: "application/json", totalBytes: 8, chunkCount: 1 })).status).toBe(409);
  expect((await json(object, certs, token, "DELETE", {})).status).toBe(405);
  expect((await json(base, certs, token, "PUT", {})).status).toBe(405);
  expect((await chunk(`${object}/chunks/0`, certs, token, "GET")).status).toBe(404);
  expect((await chunk(`${object}/chunks/0`, certs, token, "PUT", content, `sha256:${"f".repeat(64)}`)).status).toBe(400);
  expect((await json(`${object}/seal`, certs, token, "POST", { digest: factoryMaterialDigest(content) })).status).toBe(400);
  // An out-of-range chunk index never reaches the service.
  expect((await chunk(`${object}/chunks/${FACTORY_MATERIAL_LIMITS.maxChunks}`, certs, token, "PUT", content, factoryMaterialDigest(content))).status).toBe(400);
  expect((await chunk(`${object}/chunks/0`, certs, token, "DELETE", content, factoryMaterialDigest(content))).status).toBe(405);
  expect((await json(`${object}/seal`, certs, token, "GET")).status).toBe(405);
});

test("a chunk upload after the attempt deadline is refused while the listing stays readable", async () => {
  const { certs, token, base, db, authority } = await setup();
  const object = `${base}/${encodeURIComponent("data/late.json")}/1`;
  const content = new TextEncoder().encode("late bytes");
  await json(object, certs, token, "PUT", { mediaType: "application/json", totalBytes: content.byteLength, chunkCount: 1 });
  await db.execute(sql`UPDATE factory_executions SET deadline_at=NOW() - INTERVAL '1 minute' WHERE attempt_id=${authority.attemptId}`);
  const expired = await signFactoryAttemptToken({ ...authority, deadlineAt: new Date(Date.now() - 60_000) }, SECRET, INSTALLATION, 600);
  expect((await chunk(`${object}/chunks/0`, certs, expired, "PUT", content, factoryMaterialDigest(content))).status).toBe(400);
  expect((await json(base, certs, expired, "GET")).status).toBe(200);
});

test("a gateway without a material service serves only the four execution operations", async () => {
  const { certs, token, base, db, authority } = await setup();
  const certs2 = certs;
  const journal = new FactoryExecutionJournal(db, async () => {});
  const bare = startFactoryExecutionGateway({ journal, authorizeAttempt: async () => {}, jwtSecret: SECRET, installationId: INSTALLATION, tls: { key: certs2.serverKey, cert: certs2.serverCert, ca: certs2.ca } });
  servers.push(bare);
  const path = base.slice(base.indexOf("/internal"));
  expect((await json(`${bare.url}${path}`, certs, token, "GET")).status).toBe(404);
  expect((await json(`${bare.url}/internal/factory/v1/executions/${encodeURIComponent(authority.attemptId)}`, certs, token, "GET")).status).toBe(200);
});
});
}
