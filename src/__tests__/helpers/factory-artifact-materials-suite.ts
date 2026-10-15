import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import {
  FACTORY_MATERIAL_LIMITS,
  FACTORY_WORKSPACE_MATERIAL_PREFIX,
  FactoryAttemptMaterials,
  FactoryScopedMaterials,
  FactoryWorkspaceCheckpoints,
  factoryMaterialChunkObjectId,
  factoryMaterialDigest,
  type FactoryMaterialIdentity,
  type FactoryMaterialScope,
} from "../../factory/artifact-materials";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { validateFactoryRunnerResult } from "@ezcorp/factory-sdk";

export interface FactoryMaterialFixture {
  readonly db: TransactionalDb;
  /** Supplied by the real PostgreSQL producer so the same cases run against S3. */
  readonly blobs?: BlobStore;
  close(): Promise<void>;
}

const TENANT = "material-tenant";

function chunkPlan(total: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < total.byteLength; offset += size) parts.push(total.subarray(offset, Math.min(total.byteLength, offset + size)));
  return parts;
}

export function factoryArtifactMaterialsConformance(create: () => Promise<FactoryMaterialFixture>): void {
describe("C02 auxiliary artifact materials", () => {
const fixtures: FactoryMaterialFixture[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup(overrides: Partial<FactoryAttemptAuthority> = {}) {
  const fixture = await create();
  fixtures.push(fixture);
  const db = fixture.db;
  const projectId = `material-project-${randomUUID()}`;
  const runId = `material-run-${randomUUID()}`;
  const attemptId = `material-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Material', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const authority: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "node-a", candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 600_000), ...overrides,
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${authority.attemptId},${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptNumber},${authority.grantRevision},${authority.reservationGeneration},${authority.executionEpoch},${authority.cancellationEpoch},${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const root = await mkdtemp(join(tmpdir(), "factory-materials-"));
  directories.push(root);
  const wraps: InstallationKeyWrap[] = [];
  const store: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("material-installation", store, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(3) }));
  const inner = fixture.blobs ?? new FileBlobStore(root);
  const blobs = new EncryptedBlobStore(inner, key, TENANT);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  let now = Date.now();
  const journal = new FactoryExecutionJournal(db, async () => {}, () => new Date(now));
  const materials = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority });
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const checkpoints = new FactoryWorkspaceCheckpoints({ database: db, artifacts, blobs, journal });
  const scope: FactoryMaterialScope = { tenantId: TENANT, projectId, runId, attemptId, operationId: `${runId}:node-a:0:0` };
  const identity: FactoryMaterialIdentity = { ...scope, objectName: "data/export.json", version: 1 };
  return { db, artifacts, blobs, inner, journal, materials, reader, checkpoints, authority, scope, identity, root, advance: (ms: number) => { now += ms; } };
}

/** Writes a whole material through the public begin/writeChunk/seal path. */
async function store(materials: FactoryAttemptMaterials, identity: FactoryMaterialIdentity, content: Uint8Array, mediaType = "application/json", chunkBytes = 8) {
  const parts = chunkPlan(content, chunkBytes);
  await materials.begin(identity, mediaType, content.byteLength, parts.length);
  for (const [index, part] of parts.entries()) {
    await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  }
  return materials.seal(identity, factoryMaterialDigest(content));
}

test("an attempt stores a chunked material and the scoped reader returns the exact verified bytes", async () => {
  const { materials, reader, scope, identity, artifacts, db } = await setup();
  const content = new TextEncoder().encode(JSON.stringify({ rows: Array.from({ length: 40 }, (_, index) => index) }));
  const begun = await materials.begin(identity, "application/json", content.byteLength, chunkPlan(content, 8).length);
  expect(begun).toMatchObject({ schemaVersion: "factory.material.v1", sealed: false, totalBytes: content.byteLength, mediaType: "application/json", version: 1 });
  expect(begun.artifact).toBeUndefined();

  // The operation row commits before any upload, so a crash here still recovers by identity.
  expect(rows(await db.execute(sql`SELECT sealed FROM factory_artifact_materials WHERE attempt_id=${identity.attemptId} AND object_name=${identity.objectName}`))).toEqual([{ sealed: false }]);

  const parts = chunkPlan(content, 8);
  for (const [index, part] of parts.entries()) await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  const artifact = await materials.seal(identity, factoryMaterialDigest(content));
  expect(artifact.artifactId).toMatch(/^factory-artifact-/u);

  expect(await reader.read(scope, artifact)).toEqual(content);
  expect(await reader.readChunk(scope, artifact, 0)).toEqual(Uint8Array.from(parts[0]!));
  expect(await reader.readChunk(scope, artifact, parts.length - 1)).toEqual(Uint8Array.from(parts.at(-1)!));

  // The handle is one ordinary artifact of kind material holding the chunk manifest.
  const loaded = await artifacts.load({ tenantId: identity.tenantId, projectId: identity.projectId, logicalRunId: identity.runId }, { objectId: artifact.artifactId, digest: artifact.digest, encodedBytes: artifact.encodedBytes }, ["material"]);
  const manifest = JSON.parse(new TextDecoder().decode(loaded.content));
  expect(manifest).toMatchObject({ schemaVersion: "factory.material-manifest.v1", objectName: identity.objectName, version: 1, digest: factoryMaterialDigest(content), totalBytes: content.byteLength });
  expect(manifest.chunks).toHaveLength(parts.length);

  const listed = await materials.list(scope);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ sealed: true, digest: factoryMaterialDigest(content), artifact });
});

test("begin is idempotent for the same plan and rejects a duplicate name with a different plan", async () => {
  const { materials, identity } = await setup();
  const first = await materials.begin(identity, "application/json", 64, 8);
  expect(await materials.begin(identity, "application/json", 64, 8)).toEqual(first);
  await expect(materials.begin(identity, "application/json", 65, 8)).rejects.toMatchObject({ code: "factory_material_conflict" });
  await expect(materials.begin(identity, "application/json", 64, 9)).rejects.toMatchObject({ code: "factory_material_conflict" });
  await expect(materials.begin(identity, "application/octet-stream", 64, 8)).rejects.toMatchObject({ code: "factory_material_conflict" });
});

test("a version must be exactly one past the previous version of the same object", async () => {
  const { materials, identity } = await setup();
  await expect(materials.begin({ ...identity, version: 2 }, "application/json", 8, 1)).rejects.toMatchObject({ code: "factory_material_version_conflict" });
  const content = new TextEncoder().encode("v1 bytes");
  await store(materials, identity, content);
  await expect(materials.begin({ ...identity, version: 3 }, "application/json", 8, 1)).rejects.toMatchObject({ code: "factory_material_version_conflict" });
  const second = await materials.begin({ ...identity, version: 2 }, "application/json", 8, 1);
  expect(second.version).toBe(2);
});

test("plan, chunk, media type, and name limits are accepted at the boundary and rejected one past it", async () => {
  const { materials, identity, db } = await setup();
  const limits = FACTORY_MATERIAL_LIMITS;
  await expect(materials.begin(identity, "application/json", limits.maxTotalBytes + 1, limits.maxChunks)).rejects.toMatchObject({ code: "factory_material_bytes_invalid" });
  await expect(materials.begin(identity, "application/json", 0, 1)).rejects.toMatchObject({ code: "factory_material_bytes_invalid" });
  await expect(materials.begin(identity, "application/json", 1024, limits.maxChunks + 1)).rejects.toMatchObject({ code: "factory_material_chunk_count_invalid" });
  await expect(materials.begin(identity, "application/json", 1024, 0)).rejects.toMatchObject({ code: "factory_material_chunk_count_invalid" });
  // A plan that cannot fit its declared bytes in its declared chunks is rejected.
  await expect(materials.begin(identity, "application/json", limits.maxChunkBytes + 1, 1)).rejects.toMatchObject({ code: "factory_material_chunk_count_invalid" });
  await expect(materials.begin(identity, "application/json", 4, 5)).rejects.toMatchObject({ code: "factory_material_chunk_count_invalid" });
  await expect(materials.begin(identity, "text/PLAIN", 8, 1)).rejects.toMatchObject({ code: "factory_material_media_type_invalid" });
  await expect(materials.begin({ ...identity, objectName: "../escape" }, "application/json", 8, 1)).rejects.toMatchObject({ code: "factory_material_name_invalid" });
  // Every limit is accepted at its exact boundary, not only rejected one past it.
  // These stay plan-level: a committed row costs nothing, and no bytes are uploaded.
  expect((await materials.begin(identity, "application/json", limits.maxChunkBytes, 1)).chunkCount).toBe(1);

  const wholeExport = await materials.begin({ ...identity, objectName: "data/whole-export.bin" }, "application/octet-stream", limits.maxTotalBytes, limits.maxChunks);
  expect(wholeExport).toMatchObject({ totalBytes: limits.maxTotalBytes, chunkCount: limits.maxChunks, sealed: false });
  expect(wholeExport.totalBytes).toBe(256 * 1024 * 1024);

  // Exactly the maximum chunk count, with the smallest plan that can carry it.
  const everyChunk = await materials.begin({ ...identity, objectName: "data/every-chunk.bin" }, "application/octet-stream", limits.maxChunks, limits.maxChunks);
  expect(everyChunk).toMatchObject({ totalBytes: limits.maxChunks, chunkCount: limits.maxChunks });
  expect(everyChunk.chunkCount).toBe(64);

  // The longest accepted name and the last object the operation admits.
  const longestName = `data/${"n".repeat(limits.maxNameLength - "data/".length)}`;
  expect(longestName).toHaveLength(limits.maxNameLength);
  expect((await materials.begin({ ...identity, objectName: longestName }, "application/json", 8, 1)).objectName).toBe(longestName);

  // The stored rows carry the boundary values, so the database CHECKs admit them too.
  const stored = rows<{ object_name: string; total_bytes: number | string; chunk_count: number }>(await db.execute(sql`SELECT object_name, total_bytes, chunk_count FROM factory_artifact_materials WHERE attempt_id=${identity.attemptId} AND object_name IN ('data/whole-export.bin', 'data/every-chunk.bin') ORDER BY object_name`));
  expect(stored.map(row => ({ ...row, total_bytes: Number(row.total_bytes) }))).toEqual([
    { object_name: "data/every-chunk.bin", total_bytes: limits.maxChunks, chunk_count: limits.maxChunks },
    { object_name: "data/whole-export.bin", total_bytes: limits.maxTotalBytes, chunk_count: limits.maxChunks },
  ]);
});

test("a chunk whose bytes do not match its declared digest, index, or length is rejected", async () => {
  const { materials, identity } = await setup();
  const part = new TextEncoder().encode("chunk-a");
  await materials.begin(identity, "application/json", 14, 2);
  await expect(materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(new TextEncoder().encode("other")), encodedBytes: part.byteLength }, part)).rejects.toMatchObject({ code: "factory_material_chunk_digest_mismatch" });
  await expect(materials.writeChunk(identity, { index: 2, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part)).rejects.toMatchObject({ code: "factory_material_chunk_index_invalid" });
  await expect(materials.writeChunk(identity, { index: -1, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part)).rejects.toMatchObject({ code: "factory_material_chunk_index_invalid" });
  await expect(materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength + 1 }, part)).rejects.toMatchObject({ code: "factory_material_chunk_bytes_invalid" });
  await expect(materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(new Uint8Array(0)), encodedBytes: 0 }, new Uint8Array(0))).rejects.toMatchObject({ code: "factory_material_chunk_bytes_invalid" });
  await expect(materials.writeChunk({ ...identity, version: 2 }, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part)).rejects.toMatchObject({ code: "factory_material_not_found" });
});

test("a repeated chunk with the same digest succeeds and a changed digest conflicts", async () => {
  const { materials, identity, db } = await setup();
  const part = new TextEncoder().encode("chunk-a");
  const other = new TextEncoder().encode("chunk-b");
  await materials.begin(identity, "application/json", 14, 2);
  await materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  await materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  expect(rows(await db.execute(sql`SELECT chunk_index FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId}`))).toHaveLength(1);
  await expect(materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(other), encodedBytes: other.byteLength }, other)).rejects.toMatchObject({ code: "factory_material_chunk_conflict" });
});

test("concurrent writes of the same chunk commit exactly one row", async () => {
  const { materials, identity, db } = await setup();
  const part = new TextEncoder().encode("chunk-a");
  await materials.begin(identity, "application/json", 14, 2);
  const chunk = { index: 0, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength };
  const settled = await Promise.allSettled([materials.writeChunk(identity, chunk, part), materials.writeChunk(identity, chunk, part), materials.writeChunk(identity, chunk, part)]);
  expect(settled.filter(result => result.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
  expect(rows(await db.execute(sql`SELECT chunk_index FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} AND chunk_index=0`))).toHaveLength(1);
});

test("seal rejects a missing chunk, a changed digest, and a sealed material's later write", async () => {
  const { materials, identity } = await setup();
  const content = new TextEncoder().encode("sealed material bytes");
  const parts = chunkPlan(content, 8);
  await materials.begin(identity, "application/json", content.byteLength, parts.length);
  await materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(parts[0]!), encodedBytes: parts[0]!.byteLength }, parts[0]!);
  await expect(materials.seal(identity, factoryMaterialDigest(content))).rejects.toMatchObject({ code: "factory_material_incomplete" });
  for (const [index, part] of parts.entries()) await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  await expect(materials.seal(identity, factoryMaterialDigest(new TextEncoder().encode("other bytes")))).rejects.toMatchObject({ code: "factory_material_digest_mismatch" });
  const artifact = await materials.seal(identity, factoryMaterialDigest(content));
  // Sealing again with the same digest returns the same immutable handle.
  expect(await materials.seal(identity, factoryMaterialDigest(content))).toEqual(artifact);
  await expect(materials.seal(identity, factoryMaterialDigest(new TextEncoder().encode("other bytes")))).rejects.toMatchObject({ code: "factory_material_conflict" });
  await expect(materials.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(parts[0]!), encodedBytes: parts[0]!.byteLength }, parts[0]!)).rejects.toMatchObject({ code: "factory_material_sealed" });
});

test("a partial upload and a workspace checkpoint both recover by identity after a restart", async () => {
  const { materials, reader, scope, artifacts, blobs, journal, authority, db } = await setup();
  const identity: FactoryMaterialIdentity = { ...scope, objectName: `${FACTORY_WORKSPACE_MATERIAL_PREFIX}checkpoint.json`, version: 1 };
  const content = new TextEncoder().encode(JSON.stringify({ transcript: "x".repeat(200), cursor: 7 }));
  const parts = chunkPlan(content, 32);
  await materials.begin(identity, "application/json", content.byteLength, parts.length);
  for (const [index, part] of parts.slice(0, 2).entries()) await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);

  // A fresh process re-reads what landed and resumes the remaining chunks only.
  const resumed = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority });
  const committed = await resumed.chunks(identity);
  expect(committed.map(chunk => chunk.index)).toEqual([0, 1]);
  expect((await resumed.list(scope))[0]).toMatchObject({ sealed: false, objectName: identity.objectName });
  for (const [index, part] of parts.entries()) {
    if (committed.some(chunk => chunk.index === index)) continue;
    await resumed.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  }
  const artifact = await resumed.seal(identity, factoryMaterialDigest(content));
  expect(await reader.read(scope, artifact)).toEqual(content);
  await expect(resumed.chunks({ ...identity, version: 9 })).rejects.toMatchObject({ code: "factory_material_not_found" });
});

test("a read denies changed stored bytes, a tampered chunk row, and a tampered manifest", async () => {
  const { materials, reader, scope, identity, inner, db } = await setup();
  const content = new TextEncoder().encode("bytes that must not change");
  const artifact = await store(materials, identity, content);
  expect(await reader.read(scope, artifact)).toEqual(content);

  // A chunk row that no longer matches the sealed manifest is refused.
  const original = rows<{ chunk_digest: string }>(await db.execute(sql`SELECT chunk_digest FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} AND chunk_index=0`))[0]!;
  await db.execute(sql`UPDATE factory_artifact_material_chunks SET chunk_digest=${`sha256:${"b".repeat(64)}`} WHERE attempt_id=${identity.attemptId} AND chunk_index=0`);
  await expect(reader.read(scope, artifact)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await db.execute(sql`UPDATE factory_artifact_material_chunks SET chunk_digest=${original.chunk_digest} WHERE attempt_id=${identity.attemptId} AND chunk_index=0`);
  expect(await reader.read(scope, artifact)).toEqual(content);

  // Stored ciphertext that decrypts to different bytes is refused by digest.
  const blob = rows<{ blob_digest: string }>(await db.execute(sql`SELECT blob_digest FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} AND chunk_index=0`))[0]!;
  const swapped = await inner.put(await inner.get(rows<{ blob_digest: string }>(await db.execute(sql`SELECT blob_digest FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} AND chunk_index=1`))[0]!.blob_digest));
  await db.execute(sql`UPDATE factory_artifact_material_chunks SET blob_digest=${swapped} WHERE attempt_id=${identity.attemptId} AND chunk_index=0`);
  await expect(reader.read(scope, artifact)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await expect(reader.readChunk(scope, artifact, 0)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  await db.execute(sql`UPDATE factory_artifact_material_chunks SET blob_digest=${blob.blob_digest} WHERE attempt_id=${identity.attemptId} AND chunk_index=0`);

  // A material row whose assembled digest was edited no longer matches its manifest.
  await db.execute(sql`UPDATE factory_artifact_materials SET digest=${`sha256:${"c".repeat(64)}`} WHERE attempt_id=${identity.attemptId} AND object_name=${identity.objectName}`);
  await expect(reader.read(scope, artifact)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
});

test("a cross-scope read is denied with the same code as an unknown reference", async () => {
  const { materials, reader, scope, identity } = await setup();
  const content = new TextEncoder().encode("scoped material bytes");
  const artifact = await store(materials, identity, content);
  const unknown = { artifactId: "factory-artifact-absent", digest: artifact.digest, encodedBytes: artifact.encodedBytes };
  const denials: Array<() => Promise<unknown>> = [
    () => reader.read({ ...scope, projectId: "other-project" }, artifact),
    () => reader.read({ ...scope, runId: "other-run" }, artifact),
    () => reader.read({ ...scope, attemptId: "other-attempt" }, artifact),
    () => reader.read({ ...scope, operationId: "other-operation" }, artifact),
    () => reader.read({ ...scope, tenantId: "other-tenant" }, artifact),
    () => reader.read(scope, unknown),
    () => reader.read(scope, { ...artifact, digest: `sha256:${"d".repeat(64)}` }),
    () => reader.read(scope, { ...artifact, encodedBytes: artifact.encodedBytes + 1 }),
    () => reader.readChunk(scope, artifact, 99),
    () => reader.readChunk(scope, artifact, -1),
    () => reader.read(scope, { ...artifact, artifactId: "" }),
  ];
  for (const denial of denials) await expect(denial()).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  expect(await reader.read(scope, artifact)).toEqual(content);
});

test("a write after the attempt deadline, from a stale epoch, or from a stale reservation is rejected", async () => {
  const { materials, identity, scope, db, artifacts, blobs, journal, authority } = await setup();
  const part = new TextEncoder().encode("late");
  await materials.begin(identity, "application/json", 4, 1);

  const stale = (overrides: Partial<FactoryAttemptAuthority>) => new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: { ...authority, ...overrides } });
  await expect(stale({ executionEpoch: 5 }).begin({ ...identity, objectName: "data/stale.json" }, "application/json", 4, 1)).rejects.toThrow();
  await expect(stale({ reservationGeneration: 9 }).writeChunk(identity, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: 4 }, part)).rejects.toThrow();
  await expect(stale({ grantRevision: 9 }).seal(identity, factoryMaterialDigest(part))).rejects.toThrow();

  await db.execute(sql`UPDATE factory_executions SET deadline_at=NOW() - INTERVAL '1 minute' WHERE attempt_id=${identity.attemptId}`);
  const expired = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority: { ...authority, deadlineAt: new Date(Date.now() - 60_000) } });
  await expect(expired.writeChunk(identity, { index: 0, digest: factoryMaterialDigest(part), encodedBytes: 4 }, part)).rejects.toThrow();
  await expect(expired.seal(identity, factoryMaterialDigest(part))).rejects.toThrow();
  // Reads stay available after the deadline, exactly as C02 separates them.
  expect(await expired.list(scope)).toHaveLength(1);
});

test("a cancelled attempt cannot advance a material but its committed bytes stay readable", async () => {
  const { materials, reader, scope, identity, db } = await setup();
  const content = new TextEncoder().encode("committed before cancel");
  const artifact = await store(materials, identity, content);
  await db.execute(sql`UPDATE factory_executions SET status='cancel_accepted' WHERE attempt_id=${identity.attemptId}`);
  await expect(materials.begin({ ...identity, objectName: "data/after-cancel.json" }, "application/json", 8, 1)).rejects.toThrow();
  expect(await reader.read(scope, artifact)).toEqual(content);
});

test("a scope outside the verified attempt authority is denied before any database work", async () => {
  const { materials, identity, scope } = await setup();
  for (const override of [{ projectId: "other" }, { runId: "other" }, { attemptId: "other" }, { tenantId: "other" }]) {
    await expect(materials.begin({ ...identity, ...override }, "application/json", 8, 1)).rejects.toMatchObject({ code: "factory_material_scope_denied" });
    await expect(materials.list({ ...scope, ...override })).rejects.toMatchObject({ code: "factory_material_scope_denied" });
  }
  expect(materials.scope("op-1").operationId).toBe("op-1");
});

test("an aborted signal stops a write and a read without storing or returning bytes", async () => {
  const { materials, reader, scope, identity, db } = await setup();
  const content = new TextEncoder().encode("abortable material");
  const artifact = await store(materials, identity, content);
  const aborted = AbortSignal.abort();
  await expect(materials.begin({ ...identity, objectName: "data/aborted.json" }, "application/json", 8, 1, aborted)).rejects.toMatchObject({ name: "AbortError" });
  await expect(materials.list(scope, aborted)).rejects.toMatchObject({ name: "AbortError" });
  await expect(reader.read(scope, artifact, aborted)).rejects.toMatchObject({ name: "AbortError" });
  await expect(reader.readChunk(scope, artifact, 0, aborted)).rejects.toMatchObject({ name: "AbortError" });
  expect(rows(await db.execute(sql`SELECT object_name FROM factory_artifact_materials WHERE attempt_id=${identity.attemptId} AND object_name='data/aborted.json'`))).toEqual([]);
});

test("one operation holds a bounded number of material objects", async () => {
  const { materials, scope, db } = await setup();
  const filler = Array.from({ length: FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation }, (_, index) => [scope.tenantId, scope.projectId, scope.runId, scope.attemptId, scope.operationId, `data/filler-${index}.json`]);
  for (const row of filler) {
    await db.execute(sql`INSERT INTO factory_artifact_materials(tenant_id,project_id,run_id,attempt_id,operation_id,object_name,version,media_type,digest,total_bytes,chunk_count,storage_version,sealed,object_id)
      VALUES (${row[0]},${row[1]},${row[2]},${row[3]},${row[4]},${row[5]},1,'application/json',${`sha256:${"0".repeat(64)}`},8,1,'pending',FALSE,NULL)`);
  }
  await expect(materials.begin({ ...scope, objectName: "data/one-too-many.json", version: 1 }, "application/json", 8, 1)).rejects.toMatchObject({ code: "factory_material_operation_full" });
  expect(await materials.list(scope)).toHaveLength(FACTORY_MATERIAL_LIMITS.maxObjectsPerOperation);
});

test("chunk blob bindings are derived from identity, so a forged object id cannot decrypt them", async () => {
  const { materials, identity, blobs, db } = await setup();
  const content = new TextEncoder().encode("bound material bytes");
  await store(materials, identity, content);
  const stored = rows<{ blob_digest: string; chunk_index: number | string }>(await db.execute(sql`SELECT blob_digest, chunk_index FROM factory_artifact_material_chunks WHERE attempt_id=${identity.attemptId} ORDER BY chunk_index`))[0]!;
  const index = Number(stored.chunk_index);
  const objectId = factoryMaterialChunkObjectId(identity, index);
  expect(objectId).toMatch(/^factory-material-chunk-[0-9a-f]{64}-\d+$/u);
  expect(objectId).not.toBe(factoryMaterialChunkObjectId({ ...identity, version: 2 }, index));
  expect((await blobs.getBound({ tenantId: identity.tenantId, objectId }, stored.blob_digest)).byteLength).toBeGreaterThan(0);
  await expect(blobs.getBound({ tenantId: identity.tenantId, objectId: `${objectId}-forged` }, stored.blob_digest)).rejects.toThrow();
  await expect(blobs.getBound({ tenantId: "other-tenant", objectId }, stored.blob_digest)).rejects.toThrow();
});

test("an unreadable stored chunk fails the seal instead of issuing a handle", async () => {
  const { materials, identity, db } = await setup();
  const content = new TextEncoder().encode("unreadable seal bytes");
  const parts = chunkPlan(content, 8);
  await materials.begin(identity, "application/json", content.byteLength, parts.length);
  for (const [index, part] of parts.entries()) await materials.writeChunk(identity, { index, digest: factoryMaterialDigest(part), encodedBytes: part.byteLength }, part);
  await db.execute(sql`UPDATE factory_artifact_material_chunks SET blob_digest=${"e".repeat(64)} WHERE attempt_id=${identity.attemptId} AND chunk_index=0`);
  await expect(materials.seal(identity, factoryMaterialDigest(content))).rejects.toThrow();
  expect(rows(await db.execute(sql`SELECT sealed, object_id FROM factory_artifact_materials WHERE attempt_id=${identity.attemptId} AND object_name=${identity.objectName}`))).toEqual([{ sealed: false, object_id: null }]);
});

test("a workspace checkpoint is one immutable material whose cursor the runner result accepts", async () => {
  const { checkpoints, reader, scope, authority, materials } = await setup();
  const transcript = { transcript: [{ role: "assistant", text: "y".repeat(500) }], cursor: 5, tools: [{ name: "read", ok: true }], workspace: { files: ["src/main.ts"] }, model: { provider: "test", name: "m" } };
  const reference = await checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 5, attempt: authority, result: transcript });

  // The cursor the completed operation is validated against is the operation index.
  expect(reference.journalCursor).toBe(5);
  expect(reference.artifactId).toMatch(/^factory-artifact-/u);
  expect(reference.artifactId.includes("/")).toBe(false);
  expect(Object.isFrozen(reference)).toBe(true);

  // The SDK accepts a completed runner result carrying exactly this checkpoint.
  const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "1" };
  const digest = "a".repeat(64);
  const accepted = validateFactoryRunnerResult({
    schemaVersion: "factory.runner.result.v1", status: "completed", resultDigest: digest,
    journalCursor: 5, usage, output: { artifactId: "factory-artifact-output", digest: `sha256:${digest}`, encodedBytes: 4 },
    operations: [{ operationId: `${authority.runId}:node-a:0:5`, operationIndex: 5, kind: "model", requestDigest: digest, state: "completed", resultDigest: digest, usage, workspaceCheckpoint: reference }],
    workspaceCheckpoint: reference,
  } as never);
  expect(accepted.ok).toBe(true);

  // A cursor that does not equal the operation index is exactly what the SDK rejects.
  const rejected = validateFactoryRunnerResult({
    schemaVersion: "factory.runner.result.v1", status: "completed", resultDigest: digest,
    journalCursor: 5, usage, output: { artifactId: "factory-artifact-output", digest: `sha256:${digest}`, encodedBytes: 4 },
    operations: [{ operationId: `${authority.runId}:node-a:0:5`, operationIndex: 5, kind: "model", requestDigest: digest, state: "completed", resultDigest: digest, usage, workspaceCheckpoint: { ...reference, journalCursor: 4 } }],
    workspaceCheckpoint: reference,
  } as never);
  expect(rejected.ok).toBe(false);

  // The checkpoint bytes read back verified through the one scoped reader.
  expect(JSON.parse(new TextDecoder().decode(await reader.read(scope, reference)))).toEqual(transcript);
  expect((await materials.list(scope))[0]).toMatchObject({ objectName: FactoryWorkspaceCheckpoints.objectName(5), sealed: true, version: 1 });
});

test("a replayed checkpoint returns the same handle and a changed one is refused", async () => {
  const { checkpoints, scope, authority, db } = await setup();
  const result = { transcript: ["a"], cursor: 0 };
  const first = await checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 0, attempt: authority, result });
  expect(await checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 0, attempt: authority, result })).toEqual(first);
  await expect(checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 0, attempt: authority, result: { transcript: ["b"], cursor: 0 } })).rejects.toMatchObject({ code: "factory_material_conflict" });

  // Successive operations checkpoint side by side; nothing is overwritten.
  const second = await checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 1, attempt: authority, result: { transcript: ["a", "b"], cursor: 1 } });
  expect(second.artifactId).not.toBe(first.artifactId);
  expect(second.journalCursor).toBe(1);
  expect(rows(await db.execute(sql`SELECT object_name FROM factory_artifact_materials WHERE attempt_id=${authority.attemptId} ORDER BY object_name`))).toEqual([
    { object_name: FactoryWorkspaceCheckpoints.objectName(0) }, { object_name: FactoryWorkspaceCheckpoints.objectName(1) },
  ]);
  for (const index of [-1, 1.5, Number.NaN]) expect(() => FactoryWorkspaceCheckpoints.objectName(index)).toThrowError();
  await expect(checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: -1, attempt: authority, result })).rejects.toMatchObject({ code: "factory_material_checkpoint_cursor_invalid" });
});

test("a checkpoint after the attempt deadline is refused by the same journal fence", async () => {
  const { checkpoints, scope, authority, db } = await setup();
  await db.execute(sql`UPDATE factory_executions SET deadline_at=NOW() - INTERVAL '1 minute' WHERE attempt_id=${authority.attemptId}`);
  await expect(checkpoints.checkpoint({ operationId: scope.operationId, operationIndex: 0, attempt: { ...authority, deadlineAt: new Date(Date.now() - 60_000) }, result: { cursor: 0 } })).rejects.toThrow();
  expect(rows(await db.execute(sql`SELECT object_name FROM factory_artifact_materials WHERE attempt_id=${authority.attemptId}`))).toEqual([]);
});
});
}
