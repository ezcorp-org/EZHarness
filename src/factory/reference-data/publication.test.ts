import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { referenceDataDoubleWorld, referenceDataInput } from "../../__tests__/helpers/factory-reference-data-guest-double";
import { REFERENCE_DATA_GOLDEN_CSV } from "../../__tests__/helpers/factory-reference-data-world";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FactoryArtifactAccessError } from "../artifact-materials";
import { FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION } from "../release-s3-scope";
import { REFERENCE_DATA_MANIFEST_NAME } from "./manifest";
import { readReferenceDataMaterial } from "./materials";
import { REFERENCE_DATA_DATASET_OBJECT, referenceDataOperationId, runReferenceDataJourney, type ReferenceDataJourney } from "./pack";
import { referenceDataAcceptedPublication, referenceDataReconciliationInput, whole } from "./publication";

/**
 * What a finished journey hands to its two judges, without the data image.
 *
 * The journey is real host code over the real W04 materials on the embedded
 * database; only the guest is a double (see the helper). The real-guest and
 * real-S3 halves of these two hand-overs are proved by
 * `journey.integration.test.ts` and `tests/postgres/factory-reference-data.test.ts`.
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

/** Three partitions of one row each, so ordering has something to get wrong. */
async function finished() {
  const built = await referenceDataDoubleWorld(db.db, directory => directories.push(directory), { rowsPerPartition: 1 });
  const journey = await runReferenceDataJourney(built.options, () => referenceDataInput(REFERENCE_DATA_GOLDEN_CSV), "golden-v1");
  return { ...built, journey };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("the accepted candidate names the manifest and every part, strictly by name, all in the export operation", async () => {
  const { journey, scope } = await finished();
  const accepted = referenceDataAcceptedPublication(journey);
  expect(accepted).toEqual({
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
    materialOperationId: referenceDataOperationId(scope.operationId, "export"),
    candidateObjectName: REFERENCE_DATA_DATASET_OBJECT,
    candidateVersion: journey.dataset.version,
    files: [
      { name: REFERENCE_DATA_MANIFEST_NAME, objectName: REFERENCE_DATA_MANIFEST_NAME, version: 1 },
      { name: "part-00000.parquet", objectName: "part-00000.parquet", version: 1 },
      { name: "part-00001.parquet", objectName: "part-00001.parquet", version: 1 },
      { name: "part-00002.parquet", objectName: "part-00002.parquet", version: 1 },
    ],
  });
  expect(Object.isFrozen(accepted)).toBe(true);
});

test("the candidate is the same whatever order the partitions are held in", async () => {
  const { journey } = await finished();
  const reversed: ReferenceDataJourney = { ...journey, partitions: [...journey.partitions].reverse() };
  const shuffled: ReferenceDataJourney = { ...journey, partitions: [journey.partitions[1]!, journey.partitions[2]!, journey.partitions[0]!] };
  expect(referenceDataAcceptedPublication(reversed)).toEqual(referenceDataAcceptedPublication(journey));
  expect(referenceDataAcceptedPublication(shuffled)).toEqual(referenceDataAcceptedPublication(journey));
});

test("a journey the publication profile cannot name is refused, not published", async () => {
  const { journey } = await finished();
  const refusals: ReferenceDataJourney[] = [
    // Two members with one name: W08 could not rebuild one manifest from it.
    { ...journey, partitions: [journey.partitions[0]!, journey.partitions[0]!] },
    // A material version below 1 is no sealed version at all.
    { ...journey, dataset: { ...journey.dataset, version: 0 } },
    // An empty operation names nothing to publish from.
    { ...journey, manifest: { ...journey.manifest, operationId: "" } },
  ];
  for (const refused of refusals) expect(() => referenceDataAcceptedPublication(refused)).toThrow("factory_s3_profile_invalid");
});

test("the reconciliation reads the sealed input, the manifest it is given, and every part, back out of W04", async () => {
  const { journey, reader, scope } = await finished();
  const manifest = await whole(reader, scope, journey.manifest);
  const input = referenceDataReconciliationInput(journey, reader, scope, manifest, 1_700_000_000_000);

  expect(input.measuredAtMs).toBe(1_700_000_000_000);
  expect(input.manifest).toBe(manifest);
  expect(JSON.parse(decode(manifest))).toMatchObject({ rowCount: 3, partitions: 3 });

  const source: Uint8Array[] = [];
  for await (const block of input.source()) source.push(block);
  expect(decode(Buffer.concat(source))).toBe(REFERENCE_DATA_GOLDEN_CSV);
  // A fresh stream each time: the validator never reads a copy the pipeline still holds.
  const again: Uint8Array[] = [];
  for await (const block of input.source()) again.push(block);
  expect(decode(Buffer.concat(again))).toBe(REFERENCE_DATA_GOLDEN_CSV);

  expect(input.parts.map(part => part.name)).toEqual(["part-00000.parquet", "part-00001.parquet", "part-00002.parquet"]);
  const rows = REFERENCE_DATA_GOLDEN_CSV.trimEnd().split("\n");
  const parts = await Promise.all(input.parts.map(part => part.read()));
  expect(parts.map(decode)).toEqual(rows.slice(1).map(row => `PAR1${rows[0]}\n${row}\nPAR1`));
});

test("two reconciliation inputs read at once see the same bytes", async () => {
  const { journey, reader, scope } = await finished();
  const manifest = await whole(reader, scope, journey.manifest);
  const input = referenceDataReconciliationInput(journey, reader, scope, manifest, 0);
  const [left, right] = await Promise.all([Promise.all(input.parts.map(part => part.read())), Promise.all(input.parts.map(part => part.read()))]);
  expect(left.map(decode)).toEqual(right.map(decode));
});

test("whole() joins every block of a material in order, to exactly its sealed size", async () => {
  const { journey, reader, scope } = await finished();
  const streamed: Uint8Array[] = [];
  for await (const block of readReferenceDataMaterial(reader, scope, journey.summaries)) streamed.push(block);
  expect(decode(await whole(reader, scope, journey.summaries))).toBe(decode(Buffer.concat(streamed)));
  expect((await whole(reader, scope, journey.summaries)).byteLength).toBe(journey.summaries.totalBytes);
});

test("a reader under another run's scope cannot read this journey's parts or input", async () => {
  const mine = await finished();
  const theirs = await referenceDataDoubleWorld(db.db, directory => directories.push(directory));
  const input = referenceDataReconciliationInput(mine.journey, theirs.reader, theirs.scope, new Uint8Array(), 0);
  const denied = (error: unknown) => (error instanceof FactoryArtifactAccessError ? error.code : error);
  const unavailable = expect.stringMatching(/unavailable/) as unknown as string;
  expect(await input.parts[0]!.read().then(() => "read", denied)).toEqual(unavailable);
  const source = async () => {
    for await (const _block of input.source()) return "read";
    return "empty";
  };
  expect(await source().then(value => value, denied)).toEqual(unavailable);
  // The owner still reads both.
  expect((await referenceDataReconciliationInput(mine.journey, mine.reader, mine.scope, new Uint8Array(), 0).parts[0]!.read()).byteLength).toBeGreaterThan(0);
});
