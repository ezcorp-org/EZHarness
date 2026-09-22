import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { canonicalizeJson, sha256Hex, type FactoryGuestMaterialResponse, type FactoryRunnerRequest, type JsonValue } from "@ezcorp/factory-sdk";
import { createFactoryGuestStaging, FactoryGuestMaterialError } from "@ezcorp/factory-sdk/guest-materials";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { encodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import type { TransactionalDb } from "../../db/migrations/types";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryAttemptMaterials, FactoryScopedMaterials, FactoryWorkspaceCheckpoints } from "../../factory/artifact-materials";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { digestObject } from "../../extensions/v4/blobs";
import type { AgentRun } from "../../types";
import { factoryRunnerRequestAuthority } from "../../factory/runner/attempt-authority";
import { createNativeFactoryArtifacts, nativeFactoryOutputValue } from "../../factory/runner/native";
import {
  FACTORY_GUEST_MATERIAL_REFUSALS,
  createFactoryCandidateOutputWriter,
  createFactoryGuestMaterialBroker,
} from "../../factory/runner/guest-material-broker";
import type { FactoryGuestBroker } from "../../factory/runner/guest-model-broker";

/**
 * The staging broker against a real database, driven by the real guest client.
 *
 * Every case here is one a sandboxed guest can actually produce: a lost
 * response it retries, a host that restarted between its chunks, an attempt
 * someone cancelled while it was uploading, a neighbour's material it asks for
 * by name. The guest client is the production one, so a frame this suite sends
 * is a frame the shipped SDK builds.
 */

const TENANT = "tenant-a";

export interface FactoryGuestMaterialBrokerFixture {
  readonly db: TransactionalDb;
  /** Supplied by the real-PostgreSQL producer so the same broker runs against S3. */
  readonly blobs?: BlobStore;
  close(): Promise<void>;
}

/** One attempt's runner request, whose canonical digest is the journal row's request hash. */
function runnerRequest(overrides: { attemptId: string; projectId: string; runId: string; deadlineAtMs: number; cancellationEpoch?: number; executionEpoch?: number; nodeInstanceId?: string }): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId: overrides.attemptId, tenantId: TENANT, projectId: overrides.projectId, runId: overrides.runId,
      nodeInstanceId: overrides.nodeInstanceId ?? "node-a", candidateGeneration: 0, attemptNumber: 1,
      grantRevision: 1, reservationGeneration: 1, executionEpoch: overrides.executionEpoch ?? 6,
      cancellationEpoch: overrides.cancellationEpoch ?? 0, deadlineAtMs: overrides.deadlineAtMs, nextOperationIndex: 0,
    },
    runner: { package: "@example/runner", manifestName: "runner", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    input: { kind: "inline", value: { prompt: "stage an output" } },
    grants: [],
    resources: { maxCostMicros: "1000", maxTokens: 200, maxComputeMs: 30_000, memoryBytes: 1024, resourceClass: "cpu.small" },
    tools: [],
    broker: { attemptToken: "signed-attempt-token", audience: "installation-a" },
  } as FactoryRunnerRequest;
}

export function factoryGuestMaterialBrokerConformance(create: () => Promise<FactoryGuestMaterialBrokerFixture>): void {
describe("W01g guest material staging over the broker", () => {
const closing: Array<{ close(): Promise<void> }> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(closing.splice(0).map(entry => entry.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup(options: { deadlineMs?: number } = {}) {
  const fixture = await create();
  closing.push(fixture);
  const db = fixture.db;
  const projectId = `broker-project-${randomUUID()}`;
  const runId = `broker-run-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Broker', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);

  const root = await mkdtemp(join(tmpdir(), "factory-guest-material-"));
  directories.push(root);
  const blobs = fixture.blobs ?? new FileBlobStore(root);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {});
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const output = createFactoryCandidateOutputWriter({ database: db, artifacts, journal });

  const admit = async (nodeInstanceId = "node-a", deadlineMs = options.deadlineMs ?? 600_000) => {
    const attemptId = `broker-attempt-${randomUUID()}`;
    const request = runnerRequest({ attemptId, projectId, runId, nodeInstanceId, deadlineAtMs: Date.now() + deadlineMs });
    const authority = factoryRunnerRequestAuthority(request);
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
      VALUES (${attemptId},${TENANT},${projectId},${runId},${nodeInstanceId},0,1,1,1,6,0,${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
    return { request, authority, attemptId, operationId: `${runId}:${nodeInstanceId}:0:0` };
  };

  /** A fresh broker every time, so a "restart" is a real rebuild of every object. */
  const broker = (delegate?: FactoryGuestBroker, now?: () => number): FactoryGuestBroker => createFactoryGuestMaterialBroker({
    services: {
      materials: (authority: FactoryAttemptAuthority) => new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority }),
      reader: () => reader,
      output,
    },
    ...(delegate ? { delegate } : {}),
    ...(now ? { now } : {}),
  });

  const guest = (request: FactoryRunnerRequest, operationId: string, instance = broker()) => createFactoryGuestStaging({
    call: async (payload: JsonValue) => instance.invoke(request, payload),
    operationId,
    operationIndex: 0,
  });

  const materials = (authority: FactoryAttemptAuthority) => new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority });
  const checkpoints = new FactoryWorkspaceCheckpoints({ database: db, artifacts, blobs, journal });
  return { db, artifacts, journal, reader, projectId, runId, admit, broker, guest, output, materials, checkpoints };
}

async function refusalOf(action: Promise<unknown>): Promise<string> {
  const error = await action.then(() => undefined, (failure: unknown) => failure);
  expect(error, "the call was expected to be refused").toBeInstanceOf(FactoryGuestMaterialError);
  return (error as FactoryGuestMaterialError).code;
}

test("a guest stages an output, seals it, promotes it, and both artifacts read back", async () => {
  const fixture = await setup();
  const { request, authority, operationId } = await fixture.admit();
  const value = { report: "ok", rows: [1, 2, 3] } as unknown as JsonValue;
  const canonical = new TextEncoder().encode(canonicalizeJson(value));

  const promoted = await fixture.guest(request, operationId).stageResult("result.json", value);
  expect(promoted.resultDigest).toBe(sha256Hex(canonical));
  // The pair a COMPLETED runner result must satisfy, asserted as the equality
  // `verifyCompletedEvidence` performs rather than as two separate facts.
  expect(promoted.output.digest).toBe(`sha256:${promoted.resultDigest}`);
  expect(promoted.output.encodedBytes).toBe(canonical.byteLength);

  // The staged material survives as durable evidence beside the candidate. Two
  // artifacts now exist for one output: the sealed material and the candidate.
  const scope = { tenantId: TENANT, projectId: fixture.projectId, runId: fixture.runId, attemptId: authority.attemptId, operationId };
  const materials = await fixture.materials(authority).list(scope);
  expect(materials).toHaveLength(1);
  expect(materials[0]).toMatchObject({ objectName: "result.json", version: 1, sealed: true, totalBytes: canonical.byteLength, mediaType: "application/json" });
  expect(materials[0]?.digest).toBe(`sha256:${sha256Hex(canonical)}`);

  // The candidate output is a `candidate_output` artifact in this attempt's own
  // node slot, which is what the completion path and every validator load.
  const loaded = await fixture.db.transaction(transaction => fixture.artifacts.loadInTransaction(
    transaction, { tenantId: TENANT, projectId: fixture.projectId, logicalRunId: fixture.runId },
    { objectId: promoted.output.artifactId, digest: promoted.output.digest, encodedBytes: promoted.output.encodedBytes }, ["candidate_output"]));
  expect(loaded.candidateNodeInstanceId).toBe("node-a");
  expect(loaded.candidateGeneration).toBe(0);
  expect(new TextDecoder().decode(loaded.content)).toBe(canonicalizeJson(value));
});

test("the sealed material is readable through the scoped reader, byte for byte", async () => {
  const fixture = await setup();
  const { request, authority, operationId } = await fixture.admit();
  const bytes = new Uint8Array(70_000);
  for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (index * 31) % 251;

  const staged = await fixture.guest(request, operationId).stageOutput("big.bin", bytes);
  const scope = { tenantId: TENANT, projectId: fixture.projectId, runId: fixture.runId, attemptId: authority.attemptId, operationId };
  const readBack = await fixture.reader.read({ ...scope, objectName: "big.bin", version: 1 } as never, staged.material);
  expect(readBack.byteLength).toBe(bytes.byteLength);
  expect(sha256Hex(readBack)).toBe(sha256Hex(bytes));
  expect(staged.digest).toBe(`sha256:${sha256Hex(bytes)}`);
});

test("a repeated frame after a lost response answers the same thing and writes nothing twice", async () => {
  const fixture = await setup();
  const { request, operationId, authority } = await fixture.admit();
  const instance = fixture.broker();
  const bytes = new TextEncoder().encode("durably idempotent");
  const frame = (payload: Record<string, unknown>) => instance.invoke(request, { operationId, operationIndex: 0, objectName: "once.bin", version: 1, ...payload }) as Promise<FactoryGuestMaterialResponse>;

  const plan = { schemaVersion: "factory.guest-material-begin.v1", mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 1 };
  expect(await frame(plan)).toMatchObject({ status: "begun", totalBytes: bytes.byteLength });
  expect(await frame(plan)).toMatchObject({ status: "begun", totalBytes: bytes.byteLength });

  const chunk = { schemaVersion: "factory.guest-material-chunk.v1", index: 0, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) };
  expect(await frame(chunk)).toMatchObject({ status: "stored", index: 0 });
  expect(await frame(chunk)).toMatchObject({ status: "stored", index: 0 });

  const seal = { schemaVersion: "factory.guest-material-seal.v1", digest: `sha256:${sha256Hex(bytes)}` };
  const first = await frame(seal);
  const second = await frame(seal);
  expect(first).toEqual(second);

  const rows = await fixture.db.transaction(async transaction => transaction.execute(sql`SELECT COUNT(*)::int AS count FROM factory_artifact_material_chunks WHERE attempt_id=${authority.attemptId}`));
  const count = (rows as unknown as Array<{ count: number }>)[0] ?? ((rows as unknown as { rows: Array<{ count: number }> }).rows ?? [])[0];
  expect(Number(count?.count)).toBe(1);
});

test("a promotion repeated after a lost response returns the same candidate reference", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const client = fixture.guest(request, operationId);
  const value = { stable: true } as unknown as JsonValue;
  const first = await client.stageResult("result.json", value);
  // Exactly the frame a guest resends after a lost response: same name, same
  // content digest, same version.
  const second = await client.promoteOutput("result.json");
  expect(second).toEqual(first);
});

test("a host that restarted mid-upload finishes the same material", async () => {
  const fixture = await setup();
  const { request, operationId, authority } = await fixture.admit();
  const bytes = new Uint8Array(40_000).fill(9);
  const digest = `sha256:${sha256Hex(bytes)}`;

  // Two chunks through one broker, then a completely new broker for the seal.
  const first = fixture.broker();
  await first.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", operationId, operationIndex: 0, objectName: "resumed.bin", version: 1, mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 2 });
  const head = bytes.subarray(0, 32_768);
  await first.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", operationId, operationIndex: 0, objectName: "resumed.bin", version: 1, index: 0, digest: `sha256:${sha256Hex(head)}`, encodedBytes: head.byteLength, contentBase64: encodeFactoryPageBase64(head) });

  const restarted = fixture.broker();
  const tail = bytes.subarray(32_768);
  await restarted.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", operationId, operationIndex: 0, objectName: "resumed.bin", version: 1, index: 1, digest: `sha256:${sha256Hex(tail)}`, encodedBytes: tail.byteLength, contentBase64: encodeFactoryPageBase64(tail) });
  const sealed = await restarted.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", operationId, operationIndex: 0, objectName: "resumed.bin", version: 1, digest }) as FactoryGuestMaterialResponse;
  expect(sealed).toMatchObject({ status: "sealed" });
  // The sealed handle addresses the MANIFEST, so the bytes are proved through
  // the scoped reader rather than by reading the handle's own digest.
  const handle = (sealed as { material: { artifactId: string; digest: string; encodedBytes: number } }).material;
  const scope = { tenantId: TENANT, projectId: fixture.projectId, runId: fixture.runId, attemptId: authority.attemptId, operationId, objectName: "resumed.bin", version: 1 };
  const readBack = await fixture.reader.read(scope as never, handle);
  expect(`sha256:${sha256Hex(readBack)}`).toBe(digest);
});

test("concurrent chunks all land, and the seal proves they assembled in order", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const blocks = [0, 1, 2, 3].map(index => new Uint8Array(1_000).fill(index + 1));
  const whole = new Uint8Array(4_000);
  blocks.forEach((block, index) => { whole.set(block, index * 1_000); });
  const instance = fixture.broker();
  const base = { operationId, operationIndex: 0, objectName: "parallel.bin", version: 1 };
  await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", ...base, mediaType: "application/octet-stream", totalBytes: 4_000, chunkCount: 4 });

  // All four at once against one real database, which is the case a serial
  // version cannot exercise: the material row is locked by each write.
  const stored = await Promise.all(blocks.map((block, index) => instance.invoke(request, {
    schemaVersion: "factory.guest-material-chunk.v1", ...base, index,
    digest: `sha256:${sha256Hex(block)}`, encodedBytes: block.byteLength, contentBase64: encodeFactoryPageBase64(block),
  }) as Promise<FactoryGuestMaterialResponse>));
  expect(stored.map(answer => answer.status)).toEqual(["stored", "stored", "stored", "stored"]);

  const sealed = await instance.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", ...base, digest: `sha256:${sha256Hex(whole)}` }) as FactoryGuestMaterialResponse;
  expect(sealed.status).toBe("sealed");
});

test("corrupt bytes are refused by name at the chunk and at the seal", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const instance = fixture.broker();
  const bytes = new TextEncoder().encode("honest bytes");
  const base = { operationId, operationIndex: 0, objectName: "corrupt.bin", version: 1 };
  await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", ...base, mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 1 });

  // A digest that does not describe the bytes beside it.
  const lying = await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(new TextEncoder().encode("other"))}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) }) as FactoryGuestMaterialResponse;
  expect(lying).toMatchObject({ status: "refused", refusal: { code: "digest_mismatch" } });

  await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) });
  const wrongSeal = await instance.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", ...base, digest: `sha256:${sha256Hex(new TextEncoder().encode("not what arrived"))}` }) as FactoryGuestMaterialResponse;
  expect(wrongSeal).toMatchObject({ status: "refused", refusal: { code: "digest_mismatch" } });

  // Base64 the strict decoder refuses: the frame validator accepts the
  // alphabet and the length, and the decoder additionally refuses non-zero
  // trailing bits. That is a malformed frame, not a stale attempt.
  const malformed = await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: 4, contentBase64: "AAAAAAAB" }) as FactoryGuestMaterialResponse;
  expect(malformed).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
});

test("a chunk past the plan, and a chunk after the seal, are each refused by their own name", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const instance = fixture.broker();
  const bytes = new TextEncoder().encode("one chunk only");
  const base = { operationId, operationIndex: 0, objectName: "ordered.bin", version: 1 };
  await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", ...base, mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 1 });

  const beyond = await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 1, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) }) as FactoryGuestMaterialResponse;
  expect(beyond).toMatchObject({ status: "refused", refusal: { code: "chunk_out_of_order" } });

  await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) });
  await instance.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", ...base, digest: `sha256:${sha256Hex(bytes)}` });
  const afterSeal = await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(bytes)}`, encodedBytes: bytes.byteLength, contentBase64: encodeFactoryPageBase64(bytes) }) as FactoryGuestMaterialResponse;
  expect(afterSeal).toMatchObject({ status: "refused", refusal: { code: "sealed" } });
});

test("an expired deadline refuses every frame, before the database is touched", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  // The attempt's own signed deadline, read from the request the host verified.
  const expired = fixture.broker(undefined, () => request.authority.deadlineAtMs + 1);
  const client = createFactoryGuestStaging({ call: async payload => expired.invoke(request, payload), operationId, operationIndex: 0 });
  expect(await refusalOf(client.stageOutput("late.bin", new TextEncoder().encode("too late")))).toBe("deadline_expired");
});

test("an attempt whose fence moved is refused as a stale epoch, whichever field moved", async () => {
  const fixture = await setup();
  const { request, operationId, attemptId } = await fixture.admit();
  const client = fixture.guest(request, operationId);
  // A cancelled attempt: the journal's liveness statement refuses a status
  // outside admitted or running, which is the same statement that refuses a
  // moved epoch or generation. The refusal is one name by design.
  await fixture.db.execute(sql`UPDATE factory_executions SET status='cancel_accepted' WHERE attempt_id=${attemptId}`);
  expect(await refusalOf(client.stageOutput("cancelled.bin", new TextEncoder().encode("stopped")))).toBe("stale_epoch");

  await fixture.db.execute(sql`UPDATE factory_executions SET status='admitted', cancellation_epoch=1 WHERE attempt_id=${attemptId}`);
  expect(await refusalOf(client.stageOutput("superseded.bin", new TextEncoder().encode("stopped")))).toBe("stale_epoch");

  await fixture.db.execute(sql`UPDATE factory_executions SET cancellation_epoch=0 WHERE attempt_id=${attemptId}`);
  await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch=7 WHERE singleton=1`);
  expect(await refusalOf(client.stageOutput("old-epoch.bin", new TextEncoder().encode("stopped")))).toBe("stale_epoch");
});

test("cancellation lands mid-upload and the next frame is refused rather than accepted", async () => {
  const fixture = await setup();
  const { request, operationId, attemptId } = await fixture.admit();
  const instance = fixture.broker();
  const bytes = new Uint8Array(40_000).fill(4);
  const base = { operationId, operationIndex: 0, objectName: "interrupted.bin", version: 1 };
  await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", ...base, mediaType: "application/octet-stream", totalBytes: bytes.byteLength, chunkCount: 2 });
  const head = bytes.subarray(0, 32_768);
  await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 0, digest: `sha256:${sha256Hex(head)}`, encodedBytes: head.byteLength, contentBase64: encodeFactoryPageBase64(head) });

  await fixture.db.execute(sql`UPDATE factory_executions SET status='cancel_accepted' WHERE attempt_id=${attemptId}`);

  const tail = bytes.subarray(32_768);
  const refused = await instance.invoke(request, { schemaVersion: "factory.guest-material-chunk.v1", ...base, index: 1, digest: `sha256:${sha256Hex(tail)}`, encodedBytes: tail.byteLength, contentBase64: encodeFactoryPageBase64(tail) }) as FactoryGuestMaterialResponse;
  expect(refused).toMatchObject({ status: "refused", refusal: { code: "stale_epoch" } });
  // And the half-written material cannot be sealed either.
  const sealed = await instance.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", ...base, digest: `sha256:${sha256Hex(bytes)}` }) as FactoryGuestMaterialResponse;
  expect(sealed).toMatchObject({ status: "refused", refusal: { code: "stale_epoch" } });
});

test("one attempt cannot promote or read another attempt's material", async () => {
  const fixture = await setup();
  const owner = await fixture.admit("node-a");
  const neighbour = await fixture.admit("node-b");
  const value = { secret: "owner bytes" } as unknown as JsonValue;
  const owned = await fixture.guest(owner.request, owner.operationId).stageOutput("result.json", new TextEncoder().encode(canonicalizeJson(value)), "application/json");

  // The neighbour asks for the same object name under its OWN operation id, and
  // then under the owner's. Neither reaches the bytes, and neither answer says
  // whether the object exists.
  const instance = fixture.broker();
  for (const operationId of [neighbour.operationId, owner.operationId]) {
    const stolen = await instance.invoke(neighbour.request, { schemaVersion: "factory.guest-material-output.v1", operationId, operationIndex: 0, objectName: "result.json", version: 1, digest: owned.digest }) as FactoryGuestMaterialResponse;
    expect(stolen, operationId).toMatchObject({ status: "refused", refusal: { code: "unknown_material" } });
  }
});

test("a promotion must name the exact sealed version it is asking for", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const client = fixture.guest(request, operationId);
  const first = await client.stageOutput("result.json", new TextEncoder().encode(canonicalizeJson({ take: 1 } as unknown as JsonValue)), "application/json");
  await client.stageOutput("result.json", new TextEncoder().encode(canonicalizeJson({ take: 2 } as unknown as JsonValue)), "application/json");
  // Version 2 is current; naming it with version 1's digest is refused rather
  // than answered with whichever bytes happen to be there.
  expect(await refusalOf(client.promoteOutput("result.json", first.digest))).toBe("digest_mismatch");
  // Version 1 with version 1's digest is the correct pair and succeeds.
  expect((await client.promoteOutput("result.json", first.digest, 1)).resultDigest).toBe(first.digest.slice("sha256:".length));
  // A version that was never begun is unknown.
  expect(await refusalOf(client.promoteOutput("result.json", first.digest, 9))).toBe("unknown_material");
});

test("bytes that are not canonical I-JSON cannot become a candidate output", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const client = fixture.guest(request, operationId);
  // Valid JSON, wrong key order: the artifact layer re-canonicalizes on the way
  // back out, so accepting this would produce a candidate that fails its own
  // verification later, with nothing naming the cause.
  const uncanonical = new TextEncoder().encode('{"b":1,"a":2}');
  await client.stageOutput("bad.json", uncanonical, "application/json");
  expect(await refusalOf(client.promoteOutput("bad.json"))).toBe("output_not_canonical_json");

  await client.stageOutput("raw.bin", new Uint8Array([0xff, 0xfe, 0x00]));
  expect(await refusalOf(client.promoteOutput("raw.bin"))).toBe("output_not_canonical_json");
});

test("a frame the shared contract refuses never reaches the material service", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const instance = fixture.broker();
  const bad = await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", operationId, operationIndex: 0, objectName: "../escape", version: 1, mediaType: "application/json", totalBytes: 4, chunkCount: 1 }) as FactoryGuestMaterialResponse;
  expect(bad).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
  // The refusal still carries an identity a guest can correlate, even though
  // the frame's own object name was the thing refused.
  expect(bad.objectName).toBe("unknown");
  expect(bad.operationId).toBe(operationId);

  const huge = await instance.invoke(request, { schemaVersion: "factory.guest-material-begin.v1", operationId, operationIndex: 0, objectName: "huge.bin", version: 1, mediaType: "application/octet-stream", totalBytes: 99_999_999, chunkCount: 64 }) as FactoryGuestMaterialResponse;
  expect(huge).toMatchObject({ status: "refused", refusal: { code: "oversize" } });

  // A payload with no usable identity at all still answers, clamped to a shape
  // the response schema admits.
  const shapeless = await instance.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", operationId: 12, operationIndex: -4, objectName: "a/b", version: 0, digest: 7 }) as FactoryGuestMaterialResponse;
  expect(shapeless).toMatchObject({ status: "refused", operationId: "unknown:0", operationIndex: 0, objectName: "unknown", version: 1 });
});

test("a host with no material service for the attempt refuses by name", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const unavailable = createFactoryGuestMaterialBroker({
    services: {
      materials: () => { throw new Error("this host serves no attempt-scoped material service"); },
      reader: () => fixture.reader,
      output: fixture.output,
    },
  });
  const client = createFactoryGuestStaging({ call: async payload => unavailable.invoke(request, payload), operationId, operationIndex: 0 });
  expect(await refusalOf(client.stageOutput("nowhere.bin", new Uint8Array([1])))).toBe("unknown_attempt");
});

test("a payload that is not a staging frame goes to the delegate, or is refused when there is none", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const seen: unknown[] = [];
  const delegating = fixture.broker({ invoke: async (_request, payload) => { seen.push(payload); return { accepted: true }; } });
  expect(await delegating.invoke(request, { schemaVersion: "factory.guest-model-request.v1", operationId })).toEqual({ accepted: true });
  expect(seen).toHaveLength(1);
  // The staging frames still go to this broker, not to the delegate.
  // Even a malformed one: it is refused here by name, never handed onward.
  expect(await delegating.invoke(request, { schemaVersion: "factory.guest-material-seal.v1", operationId })).toMatchObject({ status: "refused", refusal: { code: "invalid_request" } });
  expect(seen).toHaveLength(1);

  const alone = fixture.broker();
  await expect(alone.invoke(request, { schemaVersion: "factory.guest-model-request.v1" })).rejects.toThrow("has no other route");
});

test("the refusal table names every code the material service can raise", async () => {
  // Derived from the service module's own source rather than from a written
  // list: a code added there without a name here would otherwise become
  // `unavailable`, which tells a guest to retry a permanent fault.
  const source = await readFile(join(import.meta.dir, "../../factory/artifact-materials.ts"), "utf8");
  const declared = new Set([...source.matchAll(/FactoryMaterialError\("(factory_material_[a-z_]+)"\)/g)].map(match => match[1] as string));
  expect(declared.size).toBeGreaterThan(20);
  const unmapped = [...declared].filter(code => !(code in FACTORY_GUEST_MATERIAL_REFUSALS)).sort();
  expect(unmapped).toEqual([]);
});

test("the native entrypoint's artifacts are the same two writers the guest path uses", async () => {
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  void operationId;
  const native = createNativeFactoryArtifacts({ output: fixture.output, checkpoints: fixture.checkpoints });
  const run = { id: "native-run", agentName: "chat", status: "success", startedAt: 1, logs: [], result: { success: true, output: { answer: 42, dropped: undefined } } } as unknown as AgentRun;

  const output = await native.output(request, run);
  // The exact equality `verifyCompletedEvidence` performs. Deriving both sides
  // from `nativeFactoryOutputValue` is what makes it hold.
  expect(output.digest).toBe(`sha256:${digestObject(nativeFactoryOutputValue(run))}`);
  const loaded = await fixture.db.transaction(transaction => fixture.artifacts.loadInTransaction(
    transaction, { tenantId: TENANT, projectId: fixture.projectId, logicalRunId: fixture.runId },
    { objectId: output.artifactId, digest: output.digest, encodedBytes: output.encodedBytes }, ["candidate_output"]));
  // The undefined member is dropped on the way to the wire, and the stored
  // bytes are its canonical form.
  expect(new TextDecoder().decode(loaded.content)).toBe('{"answer":42}');

  const checkpoint = await native.checkpoint(request, run);
  expect(checkpoint.journalCursor).toBe(request.authority.nextOperationIndex);
  // A repeat is the same handle rather than a second material version.
  expect(await native.checkpoint(request, run)).toEqual(checkpoint);
  expect(await native.output(request, run)).toEqual(output);
});

test("the request digest the journal matches on is the token-free identity", async () => {
  // A reissued attempt token must not change the attempt a frame writes into.
  const fixture = await setup();
  const { request, operationId } = await fixture.admit();
  const reissued = { ...request, broker: { ...request.broker, attemptToken: "a-freshly-minted-token" } } as FactoryRunnerRequest;
  expect(factoryRunnerRequestDigest(reissued)).toBe(factoryRunnerRequestDigest(request));
  const staged = await fixture.guest(reissued, operationId).stageOutput("reissued.bin", new TextEncoder().encode("same attempt"));
  expect(staged.totalBytes).toBe(12);
  expect(staged.digest).toBe(`sha256:${sha256Hex(new TextEncoder().encode("same attempt"))}`);
});
});
}
