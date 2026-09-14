import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "../artifact-materials";
import {
  assertFactoryS3AcceptedPublication,
  FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
  type FactoryS3AcceptedPublication,
} from "../release-s3-scope";
import { REFERENCE_DATA_MANIFEST_NAME } from "./manifest";
import { readReferenceDataMaterial, type ReferenceDataMaterial } from "./materials";
import { REFERENCE_DATA_DATASET_OBJECT, type ReferenceDataJourney } from "./pack";
import type { ReferenceDataExportPart, ReferenceDataReconciliationInput } from "./reconcile";

/**
 * What a finished journey hands to the two things that judge it: the protected
 * reconciliation, and W08's immutable S3 publication.
 *
 * Neither is given a number this pack computed. The reconciliation is given
 * BYTES - the immutable input, the manifest, and the exported Parquet - and
 * recomputes everything itself. The publication is given NAMES of sealed
 * materials, and W08's profile reads each one's media type, digest, size, and
 * chunk count back out of its own sealed record.
 */

/**
 * The accepted candidate for `s3.immutable-publish.v1`.
 *
 * The members are exactly the exported dataset: every Parquet part, in
 * partition order, plus the manifest that is the publication point. They are
 * emitted strictly increasing by name because W08 rebuilds identical manifest
 * bytes from this on every dispatch attempt, and `manifest.json` sorts before
 * `part-00000.parquet`.
 */
export function referenceDataAcceptedPublication(journey: ReferenceDataJourney, scope: FactoryMaterialScope): FactoryS3AcceptedPublication {
  const files = [
    { name: REFERENCE_DATA_MANIFEST_NAME, objectName: journey.manifest.objectName, version: journey.manifest.version },
    ...journey.partitions.map(record => ({ name: record.parquet.objectName, objectName: record.parquet.objectName, version: record.parquet.version })),
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return assertFactoryS3AcceptedPublication({
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
    materialOperationId: scope.operationId,
    candidateObjectName: REFERENCE_DATA_DATASET_OBJECT,
    candidateVersion: journey.dataset.version,
    files,
  });
}

/**
 * The reconciliation's input, read back out of W04 rather than kept in memory.
 *
 * The source is opened FRESH for the reconciliation, from the sealed immutable
 * material, so the validator reads the bytes the run was decided against and
 * not a copy the pipeline happened to still be holding.
 */
export function referenceDataReconciliationInput(
  journey: ReferenceDataJourney,
  reader: FactoryScopedArtifactReader,
  scope: FactoryMaterialScope,
  manifest: Uint8Array,
  measuredAtMs: number,
): ReferenceDataReconciliationInput {
  const parts: ReferenceDataExportPart[] = journey.partitions.map(record => ({
    name: record.parquet.objectName,
    read: async () => whole(reader, scope, record.parquet),
  }));
  return { source: () => readReferenceDataMaterial(reader, scope, journey.input), manifest, parts, measuredAtMs };
}

/**
 * Reads one exported member whole.
 *
 * A member is one partition, so it is bounded by ten thousand rows and never
 * by the whole export. The immutable INPUT is never read this way; it streams.
 */
export async function whole(reader: FactoryScopedArtifactReader, scope: FactoryMaterialScope, material: ReferenceDataMaterial): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  let total = 0;
  for await (const block of readReferenceDataMaterial(reader, scope, material)) {
    blocks.push(block);
    total += block.byteLength;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    joined.set(block, offset);
    offset += block.byteLength;
  }
  return joined;
}
