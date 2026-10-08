import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "@ezcorp/factory-sdk";
import {
  referenceDataDigest,
  referenceDataDoubleWorld,
  referenceDataGuestWrite,
  referenceDataInput,
  referenceDataRewriteReport,
  type ReferenceDataGuestDoubleOptions,
  type ReferenceDataGuestStep,
} from "../../__tests__/helpers/factory-reference-data-guest-double";
import { REFERENCE_DATA_GOLDEN_CSV as GOLDEN, type ReferenceDataMaterialsWorld } from "../../__tests__/helpers/factory-reference-data-world";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FactoryArtifactAccessError } from "../artifact-materials";
import { REFERENCE_DATA_HEADER, REFERENCE_DATA_LIMITS } from "./csv";
import { REFERENCE_DATA_MANIFEST_NAME } from "./manifest";
import type { ReferenceDataMaterial } from "./materials";
import { referenceDataOperationId, ReferenceDataPackError, runReferenceDataJourney, type ReferenceDataJourneyOptions } from "./pack";
import { whole } from "./publication";

/**
 * C10's whole graph, host side, without the data image.
 *
 * `journey.integration.test.ts` runs these four steps in the real PyArrow
 * guest, which only a factory-real runner holds. This suite runs the same host
 * code against a guest double that keeps the guest's file protocol, over the
 * REAL W04 materials on the embedded database: every byte is staged, measured,
 * sealed, and read back exactly as production does. What it proves is the
 * host's half: the order of steps, the operation each material lands in, and
 * that every disagreement between what a guest says and what it wrote stops
 * the run by name and leaves no attempt directory behind.
 */

const directories: string[] = [];
let db: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  if (!db.pglite.closed) await db.pglite.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const encoder = new TextEncoder();
const world = (guest: ReferenceDataGuestDoubleOptions = {}) => referenceDataDoubleWorld(db.db, directory => directories.push(directory), guest);

async function text(base: ReferenceDataMaterialsWorld, material: ReferenceDataMaterial): Promise<string> {
  return new TextDecoder().decode(await whole(base.reader, base.scope, material));
}

async function failure(promise: Promise<unknown>): Promise<ReferenceDataPackError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  if (!(error instanceof ReferenceDataPackError)) throw new Error(`expected a ReferenceDataPackError, got ${String(error)}`);
  return error;
}

/** A guest step hook that only acts on one export. */
function on(step: ReferenceDataGuestStep["step"], act: (step: ReferenceDataGuestStep) => Promise<void> | void) {
  return (seen: ReferenceDataGuestStep) => (seen.step === step ? act(seen) : undefined);
}

test("the golden input runs all four steps in order and every material lands in its own operation", async () => {
  const built = await world();
  const journey = await runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1");

  expect(journey.attempts.map(attempt => [attempt.export, attempt.nodeInstanceId])).toEqual([
    ["snapshotCsv", "reference-data:snapshotCsv"],
    ["parseCsv", "reference-data:parseCsv"],
    ["transformPartition", "reference-data:transformPartition:00000"],
    ["transformPartition", "reference-data:transformPartition:00001"],
    ["orderedReduce", "reference-data:orderedReduce"],
  ]);
  // The transform is told where its partition starts in the whole input.
  expect(built.double.steps.filter(step => step.step === "transformPartition").map(step => step.command.firstRowIndex)).toEqual([0, 2]);

  // The input is the caller's bytes, sealed before anything expanded it.
  expect(await text(built, journey.input)).toBe(GOLDEN);
  expect(journey.input.digest).toBe(referenceDataDigest(encoder.encode(GOLDEN)));
  expect(JSON.parse(await text(built, journey.snapshot))).toEqual({ digest: journey.input.digest, totalBytes: GOLDEN.length, sourceVersion: "golden-v1" });

  expect(journey.partitions.map(record => [record.index, record.rowCount, record.partition.objectName, record.parquet.objectName])).toEqual([
    [0, 2, "partition-00000.csv", "part-00000.parquet"],
    [1, 1, "partition-00001.csv", "part-00001.parquet"],
  ]);
  expect(await text(built, journey.partitions[1]!.partition)).toBe(`${REFERENCE_DATA_HEADER}\nc,alpha,50\n`);
  expect(await text(built, journey.partitions[1]!.parquet)).toBe(`PAR1${REFERENCE_DATA_HEADER}\nc,alpha,50\nPAR1`);
  // Every partition's report is ONE material, read back by the reduce step rather than held in memory.
  expect(JSON.parse(await text(built, journey.summaries))).toEqual(journey.partitions.map(record => record.summary as JsonValue));
  expect(JSON.parse(await text(built, journey.manifest))).toEqual({ rowCount: 3, partitions: 2, source: { digest: journey.input.digest, totalBytes: GOLDEN.length } });
  expect(journey.manifest.objectName).toBe(REFERENCE_DATA_MANIFEST_NAME);
  expect(JSON.parse(await text(built, journey.dataset))).toMatchObject({ rowCount: 3, file: { name: REFERENCE_DATA_MANIFEST_NAME, digest: journey.manifest.digest } });

  const operation = (step: "source" | "partitions" | "export") => referenceDataOperationId(built.scope.operationId, step);
  expect([journey.input, journey.snapshot].map(material => material.operationId)).toEqual([operation("source"), operation("source")]);
  expect([...journey.partitions.map(record => record.partition), journey.summaries].map(material => material.operationId)).toEqual(Array(3).fill(operation("partitions")));
  expect([...journey.partitions.map(record => record.parquet), journey.manifest, journey.dataset].map(material => material.operationId)).toEqual(Array(4).fill(operation("export")));

  // One worker per step, every one closed, and no attempt directory left behind.
  expect([built.double.started(), built.double.closed()]).toEqual([5, 5]);
  expect(await readdir(built.workRoot)).toEqual([]);
});

test("two journeys at once over one database name the same nodes and never share a material", async () => {
  const [left, right] = await Promise.all([world(), world()]);
  const [one, two] = await Promise.all([
    runReferenceDataJourney(left.options, () => referenceDataInput(GOLDEN), "golden-v1"),
    runReferenceDataJourney(right.options, () => referenceDataInput(GOLDEN), "golden-v1"),
  ]);
  expect(one.attempts.map(attempt => attempt.nodeInstanceId)).toEqual(two.attempts.map(attempt => attempt.nodeInstanceId));
  expect(one.manifest.digest).toBe(two.manifest.digest);
  expect(one.manifest.operationId).not.toBe(two.manifest.operationId);
  // Each journey's materials are readable only under its own scope.
  const crossed = await whole(right.reader, right.scope, one.manifest).then(() => "read", (error: unknown) => error);
  expect(crossed).toBeInstanceOf(FactoryArtifactAccessError);
  expect(await text(left, one.manifest)).toBe(await text(right, two.manifest));
});

test("a snapshot whose guest hashed other bytes than the sealed input stops the run and leaves no directory", async () => {
  const built = await world({ after: on("snapshotCsv", step => referenceDataRewriteReport(step, report => ({ ...report, digest: `sha256:${"0".repeat(64)}` }))) });
  const error = await failure(runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1"));
  expect([error.code, error.message]).toEqual(["reference_data_guest_disagrees", expect.stringContaining("The snapshot guest measured sha256:000") as unknown as string]);
  expect(await readdir(built.workRoot)).toEqual([]);
});

test("a parse step that declares no partitions, or more than C10 allows, is refused by count", async () => {
  const cases: Array<[JsonValue, number]> = [
    ["not-a-list", 0],
    [[], 0],
    [Array.from({ length: REFERENCE_DATA_LIMITS.maxPartitions + 1 }, (_, index) => index), REFERENCE_DATA_LIMITS.maxPartitions + 1],
  ];
  for (const [partitions, count] of cases) {
    const built = await world({ after: on("parseCsv", step => referenceDataRewriteReport(step, report => ({ ...report, partitions }))) });
    const error = await failure(runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1"));
    expect([error.code, error.message]).toEqual(["reference_data_report_invalid", `The parse step declared ${count} partition(s).`]);
    expect(await readdir(built.workRoot)).toEqual([]);
  }
});

test("a declared partition out of order or missing a field is refused before anything is sealed from it", async () => {
  const edits: Array<(partition: Record<string, JsonValue>) => Record<string, JsonValue>> = [
    partition => ({ ...partition, index: 1 }),
    partition => ({ ...partition, rowCount: "2" }),
    partition => ({ ...partition, name: 7 }),
    partition => ({ ...partition, digest: null }),
    partition => ({ ...partition, encodedBytes: "9" }),
  ];
  for (const edit of edits) {
    const built = await world({
      after: on("parseCsv", step => referenceDataRewriteReport(step, report => ({ ...report, partitions: (report.partitions as Record<string, JsonValue>[]).map((entry, index) => (index === 0 ? edit(entry) : entry)) }))),
    });
    const error = await failure(runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1"));
    expect([error.code, error.message]).toEqual(["reference_data_report_invalid", "Partition 0 is not the declared shape."]);
    expect(await readdir(built.workRoot)).toEqual([]);
  }
});

test("a partition the guest named but never wrote, or wrote differently than it said, is refused by name", async () => {
  const absent = await world({ after: on("parseCsv", step => referenceDataRewriteReport(step, report => ({ ...report, partitions: (report.partitions as Record<string, JsonValue>[]).map(entry => ({ ...entry, name: "never-written.csv" })) }))) });
  const missing = await failure(runReferenceDataJourney(absent.options, () => referenceDataInput(GOLDEN), "golden-v1"));
  expect([missing.code, missing.message]).toEqual(["reference_data_report_invalid", "The parseCsv guest left no never-written.csv."]);
  expect(await readdir(absent.workRoot)).toEqual([]);

  const corrupt = await world({ after: on("parseCsv", step => referenceDataGuestWrite(step.root, "slice-00000.csv", encoder.encode("tampered\n")).then(() => undefined)) });
  const disagrees = await failure(runReferenceDataJourney(corrupt.options, () => referenceDataInput(GOLDEN), "golden-v1"));
  expect([disagrees.code, disagrees.message]).toEqual(["reference_data_guest_disagrees", expect.stringContaining("The parseCsv guest reported sha256:") as unknown as string]);
  expect(disagrees.message).toContain(`and the bytes measure ${referenceDataDigest(encoder.encode("tampered\n"))}/9.`);
  expect(await readdir(corrupt.workRoot)).toEqual([]);
});

test("a file that changes between the host's measurement and its seal is refused, not sealed under the old digest", async () => {
  const built = await world();
  const options: ReferenceDataJourneyOptions = {
    ...built.options,
    materials: {
      ...built.options.materials,
      begin: async (identity, mediaType, totalBytes, chunkCount) => {
        if (identity.objectName === "part-00000.parquet") {
          // Same length, other bytes: only the digest can tell.
          const [directory] = await readdir(built.workRoot);
          const path = join(built.workRoot, String(directory), "part-00000.parquet");
          await writeFile(path, encoder.encode("X".repeat(totalBytes)));
        }
        return built.materials.begin(identity, mediaType, totalBytes, chunkCount);
      },
      writeChunk: (...args) => built.materials.writeChunk(...args),
      seal: (...args) => built.materials.seal(...args),
    },
  };
  const error = await failure(runReferenceDataJourney(options, () => referenceDataInput(GOLDEN), "golden-v1"));
  expect([error.code, error.message]).toEqual(["reference_data_guest_disagrees", expect.stringMatching(/^part-00000\.parquet sealed as sha256:[0-9a-f]{64} and measured sha256:[0-9a-f]{64}\.$/) as unknown as string]);
  expect(await readdir(built.workRoot)).toEqual([]);
});

test("a transform or reduce report that does not name its file as {name,digest,encodedBytes} is refused", async () => {
  const cases: Array<[ReferenceDataGuestStep["step"], JsonValue, string]> = [
    ["transformPartition", null, "The transformPartition report names no file."],
    ["transformPartition", ["part-00000.parquet"], "The transformPartition report names no file."],
    ["transformPartition", { name: "part-00000.parquet", digest: "sha256:x" }, "The transformPartition report's file is not {name,digest,encodedBytes}."],
    ["orderedReduce", "dataset-manifest.json", "The orderedReduce report names no file."],
    ["orderedReduce", { name: 1, digest: "sha256:x", encodedBytes: 1 }, "The orderedReduce report's file is not {name,digest,encodedBytes}."],
  ];
  for (const [step, file, message] of cases) {
    const built = await world({ after: on(step, seen => referenceDataRewriteReport(seen, report => ({ ...report, file }))) });
    const error = await failure(runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1"));
    expect([step, error.code, error.message]).toEqual([step, "reference_data_report_invalid", message]);
    expect(await readdir(built.workRoot)).toEqual([]);
  }
});

test("a guest that dies inside a step fails the run with its worker closed and its directory removed", async () => {
  const built = await world({ after: on("transformPartition", () => { throw new Error("guest killed"); }) });
  const error = await runReferenceDataJourney(built.options, () => referenceDataInput(GOLDEN), "golden-v1").then(() => undefined, (caught: unknown) => caught);
  expect((error as Error).message).toBe("guest killed");
  expect(built.double.started()).toBe(built.double.closed());
  expect(await readdir(built.workRoot)).toEqual([]);
  // The steps before the death are sealed and stay readable; nothing after it was attempted.
  expect(built.double.steps.map(step => step.step)).toEqual(["snapshotCsv", "parseCsv", "transformPartition"]);
});

