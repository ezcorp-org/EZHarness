/**
 * What the image pack hands W08 to publish, and what it refuses to hand over.
 *
 * The S3 adapter owns the publication shape; this module only produces it. It
 * exists so the rule "publish the first accepted variant in input order, with
 * exactly the bytes that were accepted" is enforced in one place rather than at
 * every call site, and so a caller cannot name a variant the round did not
 * accept.
 *
 * Two files are published: the accepted PNG under the output name the run was
 * given, and an evidence document recording every variant of every round,
 * including the ones that failed. The second is not optional. A publication
 * that showed only the winner would make a four-seed round indistinguishable
 * from a one-seed round that got lucky, and C10 requires every failed variant
 * to remain auditable.
 */
import {
  assertFactoryS3AcceptedPublication,
  FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
  type FactoryS3AcceptedPublication,
} from "../release-s3-scope.ts";
import { referenceImageLock, referenceImageLockDigest, type ReferenceImageLock } from "./lock.ts";
import type { RoundAssessment } from "./variants.ts";

export const REFERENCE_IMAGE_EVIDENCE_NAME = "evidence.json";

export class ReferenceImagePublicationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImagePublicationError";
  }
}

/** One material the producing attempt sealed, named so the adapter can read it. */
export interface SealedMaterial {
  readonly objectName: string;
  readonly version: number;
  readonly digest: string;
  readonly bytes: number;
}

export interface ReferenceImageRoundRecord {
  readonly round: number;
  readonly prompt: string;
  readonly assessment: RoundAssessment;
}

export interface ReferenceImagePublicationInput {
  /** The gateway operation the producing attempt wrote its materials under. */
  readonly materialOperationId: string;
  /** The output name the run was given; the accepted PNG is published under it. */
  readonly outputName: string;
  /** Every round that ran, in order. The last one holds the accepted variant. */
  readonly rounds: readonly ReferenceImageRoundRecord[];
  /** The sealed material holding the accepted, normalized PNG. */
  readonly accepted: SealedMaterial;
  /** The sealed material holding the evidence document. */
  readonly evidence: SealedMaterial;
  /** The sealed material holding the candidate manifest itself. */
  readonly candidate: SealedMaterial;
}

/** The auditable record of every variant of every round. */
export interface ReferenceImageEvidenceDocument {
  readonly schemaVersion: "factory.reference-image-evidence.v1";
  readonly definitionId: string;
  readonly lockDigest: string;
  readonly model: { readonly repository: string; readonly revision: string; readonly variant: string };
  readonly guestImage: string;
  readonly generation: ReferenceImageLock["generation"];
  readonly accepted: { readonly round: number; readonly seed: number; readonly index: number; readonly digest: string; readonly bytes: number };
  readonly rounds: readonly {
    readonly round: number;
    readonly prompt: string;
    readonly reasonCode: string;
    readonly summary: string;
    readonly variants: readonly {
      readonly index: number;
      readonly seed: number;
      readonly status: string;
      readonly reasonCode: string;
      readonly summary: string;
      readonly failedClaimIds: readonly string[];
      readonly unmeasuredClaimIds: readonly string[];
      readonly publishedDigest?: string;
    }[];
  }[];
  /** The evaluations share a model and a configuration; agreement is consistency, not independence. */
  readonly semanticProvenance: { readonly model: string; readonly independent: false };
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReferenceImagePublicationError("reference_image_publication_invalid", `${field} must be a non-empty name`);
  }
  return value;
}

/**
 * Builds the evidence document for a completed set of rounds.
 *
 * Every round contributes every variant, whatever happened to it. Filtering to
 * the interesting ones is what would make a later reader believe the round was
 * cleaner than it was.
 */
export function referenceImageEvidence(input: ReferenceImagePublicationInput, lock: ReferenceImageLock = referenceImageLock): ReferenceImageEvidenceDocument {
  if (input.rounds.length === 0) {
    throw new ReferenceImagePublicationError("reference_image_publication_empty", "A publication needs at least one recorded round");
  }
  const last = input.rounds[input.rounds.length - 1] as ReferenceImageRoundRecord;
  const accepted = last.assessment.accepted;
  if (accepted === undefined) {
    throw new ReferenceImagePublicationError("reference_image_publication_unaccepted", "The final round accepted no variant, so there is nothing to publish");
  }
  const earlier = input.rounds.slice(0, -1).find(record => record.assessment.accepted !== undefined);
  if (earlier !== undefined) {
    throw new ReferenceImagePublicationError(
      "reference_image_publication_late_round",
      `Round ${earlier.round} already accepted a variant, so round ${last.round} should never have run`,
    );
  }
  if (accepted.publishedDigest !== input.accepted.digest) {
    throw new ReferenceImagePublicationError(
      "reference_image_publication_bytes",
      `The accepted variant is ${String(accepted.publishedDigest)} and the sealed material holds ${input.accepted.digest}`,
    );
  }
  if (accepted.publishedBytes !== input.accepted.bytes) {
    throw new ReferenceImagePublicationError(
      "reference_image_publication_bytes",
      `The accepted variant is ${String(accepted.publishedBytes)} bytes and the sealed material holds ${input.accepted.bytes}`,
    );
  }
  return {
    schemaVersion: "factory.reference-image-evidence.v1",
    definitionId: lock.definitionId,
    lockDigest: referenceImageLockDigest(lock),
    model: { repository: lock.model.repository, revision: lock.model.revision, variant: lock.model.variant },
    guestImage: lock.runtime.guestImage,
    generation: lock.generation,
    accepted: { round: last.round, seed: accepted.seed, index: accepted.index, digest: input.accepted.digest, bytes: input.accepted.bytes },
    rounds: input.rounds.map(record => ({
      round: record.round,
      prompt: record.prompt,
      reasonCode: record.assessment.reasonCode,
      summary: record.assessment.summary,
      variants: record.assessment.variants.map(entry => ({
        index: entry.index,
        seed: entry.seed,
        status: entry.status,
        reasonCode: entry.reasonCode,
        summary: entry.summary,
        failedClaimIds: [...entry.failedClaimIds],
        unmeasuredClaimIds: [...entry.unmeasuredClaimIds],
        ...(entry.publishedDigest === undefined ? {} : { publishedDigest: entry.publishedDigest }),
      })),
    })),
    semanticProvenance: { model: lock.evaluation.model, independent: false },
  };
}

/**
 * The accepted publication W08 resolves from.
 *
 * The file list is sorted by name because the adapter requires it and because a
 * caller-chosen order would let two runs that published the same bytes produce
 * different request digests.
 */
export function referenceImagePublication(input: ReferenceImagePublicationInput, lock: ReferenceImageLock = referenceImageLock): FactoryS3AcceptedPublication {
  referenceImageEvidence(input, lock);
  const outputName = nonEmpty(input.outputName, "outputName");
  if (outputName === REFERENCE_IMAGE_EVIDENCE_NAME) {
    throw new ReferenceImagePublicationError("reference_image_publication_name", `The output name cannot be ${REFERENCE_IMAGE_EVIDENCE_NAME}, which the evidence document uses`);
  }
  const files = [
    { name: outputName, objectName: nonEmpty(input.accepted.objectName, "accepted.objectName"), version: input.accepted.version },
    { name: REFERENCE_IMAGE_EVIDENCE_NAME, objectName: nonEmpty(input.evidence.objectName, "evidence.objectName"), version: input.evidence.version },
  ].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return assertFactoryS3AcceptedPublication({
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION,
    materialOperationId: nonEmpty(input.materialOperationId, "materialOperationId"),
    candidateObjectName: nonEmpty(input.candidate.objectName, "candidate.objectName"),
    candidateVersion: input.candidate.version,
    files,
  });
}
