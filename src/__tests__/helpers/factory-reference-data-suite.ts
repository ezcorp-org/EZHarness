import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { buildLimits, filesDigest, PythonPodmanRunner } from "@ezcorp/extension-runner";
import type { FactoryRunnerAuthority, RunnerReference } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryAttemptMaterials, FactoryScopedMaterials, type FactoryMaterialScope } from "../../factory/artifact-materials";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { REFERENCE_DATA_HEADER, REFERENCE_DATA_LIMITS } from "../../factory/reference-data/csv";
import {
  FACTORY_REFERENCE_DATA_ENTRYPOINT,
  FACTORY_REFERENCE_DATA_PACKAGE,
  FACTORY_REFERENCE_DATA_VERSION,
  factoryReferenceDataClosure,
  factoryReferenceDataGuestFiles,
  factoryReferenceDataImage,
} from "../../factory/reference-data/guest";
import { assertReferenceDataManifest } from "../../factory/reference-data/manifest";
import { ReferenceDataPackError, runReferenceDataJourney, type ReferenceDataJourney, type ReferenceDataJourneyOptions } from "../../factory/reference-data/pack";
import { referenceDataAcceptedPublication, referenceDataReconciliationInput, whole } from "../../factory/reference-data/publication";
import { reconcileReferenceData, REFERENCE_DATA_CLAIM_IDS } from "../../factory/reference-data/reconcile";
import { readReferenceDataParquet } from "../../factory/reference-data/parquet";

/**
 * The `reference.data.v1` journey, end to end, as real isolated attempts.
 *
 * Every step below runs a real rootless Podman container from the pinned
 * PyArrow image, writes real Parquet into the per-attempt material directory,
 * and seals it through W04. Nothing is mocked. The reconciliation then reads
 * those sealed bytes back with this pack's own Parquet reader and recomputes
 * every claim from the immutable input.
 */

export interface FactoryReferenceDataFixture {
  readonly db: TransactionalDb;
  /** Supplied by the real producer so the same cases run against S3-backed blobs. */
  readonly blobs?: BlobStore;
  /** Only the real producer runs the 256 MiB boundary. */
  readonly large?: boolean;
  close(): Promise<void>;
}

const TENANT = "reference-data-tenant";
const MEASURED_AT = 1_700_000_000_000;
export const GOLDEN_CSV = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n`;

function reference(digest: string): RunnerReference {
  return { package: FACTORY_REFERENCE_DATA_PACKAGE, version: FACTORY_REFERENCE_DATA_VERSION, digest: `sha256:${digest}`, export: "snapshotCsv" };
}

export function factoryReferenceDataConformance(create: () => Promise<FactoryReferenceDataFixture>): void {
describe("C10 reference.data.v1 through the pinned PyArrow guest", () => {
const fixtures: FactoryReferenceDataFixture[] = [];
const directories: string[] = [];
let runner: PythonPodmanRunner;
let runnerRoot: string;
let files: WorkspaceFiles;
let artifactDigest: string;
let buildLanes: readonly string[];

beforeAll(async () => {
  runnerRoot = await mkdtemp(join(tmpdir(), "ez-refdata-runner-"));
  runner = new PythonPodmanRunner({ root: runnerRoot, image: await factoryReferenceDataImage(), closure: await factoryReferenceDataClosure() });
  files = await factoryReferenceDataGuestFiles();
  const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: FACTORY_REFERENCE_DATA_ENTRYPOINT, limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  expect(build.state).toBe("succeeded");
  artifactDigest = build.artifactDigest as string;
  buildLanes = build.evidence.tests.map(entry => entry.name);
}, 900_000);

afterAll(async () => {
  await runner.close();
  await rm(runnerRoot, { recursive: true, force: true });
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/**
 * One fixture per TEST, not per world.
 *
 * `setupTestDb` closes the previous embedded database when it opens the next
 * one, so a second fixture inside one test would invalidate the first. Several
 * worlds share one database instead; each gets its own project, run, attempt,
 * and material scope, which is what isolates them.
 */
async function fresh(): Promise<FactoryReferenceDataFixture> {
  const fixture = await create();
  fixtures.push(fixture);
  return fixture;
}

async function world(fixture: FactoryReferenceDataFixture, overrides: { artifactDigest?: string } = {}) {
  const db = fixture.db;
  const projectId = `refdata-project-${randomUUID()}`;
  const runId = `refdata-run-${randomUUID()}`;
  const attemptId = `refdata-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Reference data', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const authority: FactoryAttemptAuthority = {
    attemptId, tenantId: TENANT, projectId, runId, nodeInstanceId: "reference-data", candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 3_600_000),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${authority.attemptId},${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptNumber},${authority.grantRevision},${authority.reservationGeneration},${authority.executionEpoch},${authority.cancellationEpoch},${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const root = await mkdtemp(join(tmpdir(), "refdata-blobs-"));
  directories.push(root);
  const wraps: InstallationKeyWrap[] = [];
  const store: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("refdata-installation", store, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(5) }));
  const blobs = new EncryptedBlobStore(fixture.blobs ?? new FileBlobStore(root), key, TENANT);
  const artifacts = new FactoryArtifacts(db, blobs, TENANT);
  const journal = new FactoryExecutionJournal(db, async () => {}, () => new Date());
  const materials = new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority });
  const reader = new FactoryScopedMaterials({ database: db, artifacts, blobs });
  const scope: FactoryMaterialScope = { tenantId: TENANT, projectId, runId, attemptId, operationId: `${runId}:reference-data:0:0` };
  const runnerAuthority: Omit<FactoryRunnerAuthority, "nodeInstanceId"> = {
    attemptId, tenantId: TENANT, projectId, runId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1,
    reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs: Date.now() + 3_600_000, nextOperationIndex: 0,
  };
  const workRoot = await mkdtemp(join(tmpdir(), "refdata-work-"));
  directories.push(workRoot);
  const options: ReferenceDataJourneyOptions = {
    host: { runner, artifactDigest: overrides.artifactDigest ?? artifactDigest, reference: reference("b".repeat(64)) },
    materials, reader, scope, authority: runnerAuthority, workRoot,
  };
  return { db, options, materials, reader, scope, fixture };
}

async function* csv(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

async function reconcile(journey: ReferenceDataJourney, reader: FactoryScopedMaterials, scope: FactoryMaterialScope) {
  const manifest = await whole(reader, scope, journey.manifest);
  return reconcileReferenceData(referenceDataReconciliationInput(journey, reader, scope, manifest, MEASURED_AT));
}

test("every build lane ran inside the pinned PyArrow guest, including the sealed suite", () => {
  expect(buildLanes.slice(0, 2)).toEqual(["syntax", "closure"]);
  expect(buildLanes).toContain("feature:refdata/test_sealed.py");
  expect(buildLanes.at(-1)).toBe("metadata-discovery");
  expect(artifactDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("the golden three-row input runs C10's whole graph and every protected claim passes", async () => {
  const { options, reader, scope } = await world(await fresh());
  const journey = await runReferenceDataJourney(options, () => csv(GOLDEN_CSV), "golden-v1");

  expect(journey.attempts.map(attempt => attempt.export)).toEqual(["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"]);
  for (const attempt of journey.attempts) expect(attempt.result.status).toBe("completed");
  expect(journey.partitions).toHaveLength(1);
  expect(journey.input.totalBytes).toBe(GOLDEN_CSV.length);

  // The exported bytes really are Parquet, and they really hold C10's rows.
  const parquet = readReferenceDataParquet(await whole(reader, scope, journey.partitions[0]!.parquet));
  expect(parquet.createdBy).toContain("parquet-cpp-arrow");
  expect(parquet.rows.map(row => `${row.recordId}/${row.category}/${row.amountCents}`)).toEqual(["a/alpha/100", "b/beta/250", "c/alpha/50"]);

  const manifest = assertReferenceDataManifest(JSON.parse(new TextDecoder().decode(await whole(reader, scope, journey.manifest))) as unknown);
  expect(manifest.rowCount).toBe(3);
  expect(manifest.totalAmountCents).toBe("400");
  expect(manifest.categories).toEqual([
    { category: "alpha", count: 2, sumCents: "150" },
    { category: "beta", count: 1, sumCents: "250" },
  ]);
  expect(manifest.source.digest).toBe(journey.input.digest);

  const report = await reconcile(journey, reader, scope);
  expect(report.claims.map(claim => [claim.id, claim.verdict])).toEqual(REFERENCE_DATA_CLAIM_IDS.map(id => [id, "PASS"]));
}, 900_000);

test("the accepted publication names every exported member and the manifest, strictly ordered", async () => {
  const { options, scope } = await world(await fresh());
  const journey = await runReferenceDataJourney(options, () => csv(GOLDEN_CSV), "golden-v1");
  const accepted = referenceDataAcceptedPublication(journey, scope);
  expect(accepted.materialOperationId).toBe(scope.operationId);
  expect(accepted.candidateObjectName).toBe("dataset.json");
  expect(accepted.files.map(file => file.name)).toEqual(["manifest.json", "part-00000.parquet"]);
  for (const file of accepted.files) expect(file.version).toBe(1);
}, 900_000);

test("every C10 negative fixture stops the run at the parse step, naming its own reason", async () => {
  const cases = [
    [`${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\na,alpha,50\n`, "record_id_duplicate"],
    [`${REFERENCE_DATA_HEADER}\na,alpha,${REFERENCE_DATA_LIMITS.maxAmountCents + 1n}\n`, "amount_overflow"],
    [`${REFERENCE_DATA_HEADER}\na,alpha\n`, "row_field_count"],
    ["record_id,category,amount\na,alpha,1\n", "header_mismatch"],
    [`${REFERENCE_DATA_HEADER}\na,alpha,-5\n`, "amount_charset"],
    [`${REFERENCE_DATA_HEADER}\n`, "row_empty"],
  ] as const;
  const fixture = await fresh();
  for (const [text, code] of cases) {
    const { options } = await world(fixture);
    const failure = await runReferenceDataJourney(options, () => csv(text), "negative-v1").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect([code, failure instanceof ReferenceDataPackError ? failure.code : failure]).toEqual([code, "reference_data_attempt_failed"]);
    expect([code, (failure as Error).message]).toEqual([code, expect.stringContaining(code) as unknown as string]);
  }
}, 900_000);

test("a partition boundary produces ordered partitions that reconcile with the input", async () => {
  const rows = Array.from({ length: REFERENCE_DATA_LIMITS.partitionRows + 1 }, (_, index) => `id${index},c${index % 3},${index}`);
  const { options, reader, scope } = await world(await fresh());
  const journey = await runReferenceDataJourney(options, () => csv(`${REFERENCE_DATA_HEADER}\n${rows.join("\n")}\n`), "boundary-v1");
  expect(journey.partitions.map(record => record.rowCount)).toEqual([REFERENCE_DATA_LIMITS.partitionRows, 1]);
  expect(journey.partitions.map(record => record.parquet.objectName)).toEqual(["part-00000.parquet", "part-00001.parquet"]);
  const report = await reconcile(journey, reader, scope);
  expect(report.claims.map(claim => [claim.id, claim.verdict])).toEqual(REFERENCE_DATA_CLAIM_IDS.map(id => [id, "PASS"]));
}, 900_000);

test("the signed-64-bit boundary survives the whole journey exactly", async () => {
  const limit = REFERENCE_DATA_LIMITS.maxAmountCents;
  const { options, reader, scope } = await world(await fresh());
  const journey = await runReferenceDataJourney(options, () => csv(`${REFERENCE_DATA_HEADER}\nzero,alpha,0\nbig,beta,${limit}\nalso,beta,${limit}\n`), "boundary-v1");
  const manifest = assertReferenceDataManifest(JSON.parse(new TextDecoder().decode(await whole(reader, scope, journey.manifest))) as unknown);
  // The total leaves the per-row domain, and it is still exact.
  expect(manifest.totalAmountCents).toBe(String(limit * 2n));
  const parquet = readReferenceDataParquet(await whole(reader, scope, journey.partitions[0]!.parquet));
  expect(parquet.rows.map(row => row.amountCents)).toEqual([0n, limit, limit]);
  const report = await reconcile(journey, reader, scope);
  expect(report.claims.map(claim => claim.verdict)).toEqual(REFERENCE_DATA_CLAIM_IDS.map(() => "PASS"));
}, 900_000);

test("a defective transform is caught by the reconciliation and repaired only as a new pinned revision", async () => {
  // The defect: a transform that drops the last row of every partition. It is
  // internally consistent - its own counters agree with the Parquet it wrote -
  // which is exactly the self-certification C10 forbids acceptance from resting on.
  const defective: WorkspaceFiles = { ...files, "refdata/parquet.py": (files["refdata/parquet.py"] as string).replace("def write_partition(rows: list[Row]) -> bytes:", "def write_partition(rows: list[Row]) -> bytes:\n    rows = rows[:-1] if len(rows) > 1 else rows") };
  const defectiveDigest = filesDigest(defective);
  expect(defectiveDigest).not.toBe(filesDigest(files));
  const build = await runner.build({ operationId: randomUUID(), files: defective, sourceDigest: defectiveDigest, entrypoint: FACTORY_REFERENCE_DATA_ENTRYPOINT, limits: buildLimits });
  expect(build.state).toBe("succeeded");
  const defectiveArtifact = build.artifactDigest as string;
  expect(defectiveArtifact).not.toBe(artifactDigest);

  const fixture = await fresh();
  const broken = await world(fixture, { artifactDigest: defectiveArtifact });
  const brokenJourney = await runReferenceDataJourney(broken.options, () => csv(GOLDEN_CSV), "golden-v1");
  const brokenReport = await reconcile(brokenJourney, broken.reader, broken.scope);
  const verdicts = Object.fromEntries(brokenReport.claims.map(claim => [claim.id, claim.verdict]));
  expect(verdicts["source-row-values"]).toBe("FAIL");
  expect(verdicts["row-count-unique-ids"]).toBe("FAIL");

  // The repair is a DIFFERENT pinned artifact. The defective one is still
  // defective: nothing was fixed in place, and rerunning it fails again.
  const repaired = await world(fixture, { artifactDigest });
  const repairedJourney = await runReferenceDataJourney(repaired.options, () => csv(GOLDEN_CSV), "golden-v1");
  const repairedReport = await reconcile(repairedJourney, repaired.reader, repaired.scope);
  expect(repairedReport.claims.map(claim => claim.verdict)).toEqual(REFERENCE_DATA_CLAIM_IDS.map(() => "PASS"));

  const again = await world(fixture, { artifactDigest: defectiveArtifact });
  const againJourney = await runReferenceDataJourney(again.options, () => csv(GOLDEN_CSV), "golden-v1");
  const againReport = await reconcile(againJourney, again.reader, again.scope);
  expect(againReport.claims.find(claim => claim.id === "source-row-values")?.verdict).toBe("FAIL");
}, 1_800_000);

test("correcting the input is a new snapshot and a new run, never a rewrite of the old one", async () => {
  const fixture = await fresh();
  const { options, materials, scope } = await world(fixture);
  const first = await runReferenceDataJourney(options, () => csv(`${REFERENCE_DATA_HEADER}\na,alpha,100\n`), "v1");
  // The same object name at the same version cannot be re-begun with different
  // bytes: W04 refuses the plan, so the decided snapshot cannot be replaced.
  await expect(materials.begin({ ...scope, objectName: "input.csv", version: 1 }, "text/csv", 999, 1)).rejects.toMatchObject({ code: "factory_material_conflict" });
  const corrected = await world(fixture);
  const second = await runReferenceDataJourney(corrected.options, () => csv(`${REFERENCE_DATA_HEADER}\na,alpha,101\n`), "v2");
  expect(second.input.digest).not.toBe(first.input.digest);
  expect(second.snapshot.digest).not.toBe(first.snapshot.digest);
}, 900_000);
});
}
