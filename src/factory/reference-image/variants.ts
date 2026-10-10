/**
 * The four seeded variants, and which one is published.
 *
 * Two rules from C10 shape everything here. Selection is by input order, not by
 * quality, arrival, or score: the first variant that satisfies every claim is
 * the one that is published, and a later variant that also satisfies them
 * changes nothing. And every variant stays visible, including the ones that
 * failed to generate at all, so a round is always a record of four attempts
 * rather than a record of whichever attempt happened to succeed.
 *
 * The dense, input-ordered shape this module reads is exactly what the kernel's
 * `collect` map produces. A failed item keeps its slot there and keeps its slot
 * here, which is why `assessRound` refuses a list whose indexes are not the
 * complete range: a missing slot would silently move every later seed's
 * position and change which variant "first" means.
 */
import type { FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk";

import { referenceImageLock, type ReferenceImageLock } from "./lock.ts";
import { SEMANTIC_CLAIM_IDS, type SemanticQuorum } from "./semantic-quorum.ts";

/** The claims that must all pass before a variant can be published. */
export const REQUIRED_DETERMINISTIC_CLAIM_IDS = Object.freeze([
  "png-single-frame",
  "png-dimensions-color",
  "png-size",
  "png-no-extra-payload",
  "ocr-no-text",
] as const);

export class ReferenceImageVariantError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImageVariantError";
  }
}

/** What one seed produced, or why it produced nothing. */
export type VariantGeneration =
  | { readonly outcome: "succeeded"; readonly digest: string; readonly bytes: number; readonly runtime: Readonly<Record<string, string>> }
  | { readonly outcome: "failed"; readonly error: string };

export interface VariantNormalization {
  readonly digest: string;
  readonly bytes: number;
  readonly sourceDigest: string;
}

export interface VariantRecord {
  /** Position in the recorded seed order. The map's slot index. */
  readonly index: number;
  readonly seed: number;
  readonly generation: VariantGeneration;
  readonly normalization?: VariantNormalization;
  readonly deterministic?: readonly FactoryValidatorClaimOutcome[];
  readonly quorum?: SemanticQuorum;
}

export type VariantStatus = "accepted" | "rejected" | "unmeasured";

export interface VariantAssessment {
  readonly index: number;
  readonly seed: number;
  readonly status: VariantStatus;
  readonly reasonCode: string;
  readonly summary: string;
  /** Present only when the variant is accepted; these are the bytes published. */
  readonly publishedDigest?: string;
  readonly publishedBytes?: number;
  readonly failedClaimIds: readonly string[];
  readonly unmeasuredClaimIds: readonly string[];
}

export interface RoundAssessment {
  readonly accepted?: VariantAssessment;
  /** Every variant, in input order, whatever happened to it. */
  readonly variants: readonly VariantAssessment[];
  readonly reasonCode: string;
  readonly summary: string;
}

function claimById(claims: readonly FactoryValidatorClaimOutcome[] | undefined, id: string): FactoryValidatorClaimOutcome | undefined {
  return claims?.find(claim => claim.id === id);
}

/**
 * Assesses one variant against every claim the contract requires.
 *
 * A claim that was never measured is distinguished from one that failed. Both
 * stop publication, but only the second is a statement about the picture, and
 * conflating them would make a crashed validator look like a bad generation.
 */
export function assessVariant(variant: VariantRecord): VariantAssessment {
  const base = { index: variant.index, seed: variant.seed };
  if (variant.generation.outcome === "failed") {
    return {
      ...base,
      status: "rejected",
      reasonCode: "variant.generation.failed",
      summary: `Seed ${variant.seed} produced no image: ${variant.generation.error}`,
      failedClaimIds: [],
      unmeasuredClaimIds: [...REQUIRED_DETERMINISTIC_CLAIM_IDS],
    };
  }
  if (variant.normalization === undefined) {
    return {
      ...base,
      status: "unmeasured",
      reasonCode: "variant.normalization.missing",
      summary: `Seed ${variant.seed} was generated but never normalized`,
      failedClaimIds: [],
      unmeasuredClaimIds: [...REQUIRED_DETERMINISTIC_CLAIM_IDS],
    };
  }
  if (variant.normalization.sourceDigest !== variant.generation.digest) {
    return {
      ...base,
      status: "rejected",
      reasonCode: "variant.normalization.mismatch",
      summary: `Seed ${variant.seed} normalized ${variant.normalization.sourceDigest} rather than the generated ${variant.generation.digest}`,
      failedClaimIds: [],
      unmeasuredClaimIds: [...REQUIRED_DETERMINISTIC_CLAIM_IDS],
    };
  }

  const failed: string[] = [];
  const unmeasured: string[] = [];
  for (const id of REQUIRED_DETERMINISTIC_CLAIM_IDS) {
    const claim = claimById(variant.deterministic, id);
    if (claim === undefined || claim.verdict === "VALIDATOR_ERROR" || claim.verdict === "INCONCLUSIVE") unmeasured.push(id);
    else if (claim.verdict !== "PASS") failed.push(id);
  }
  if (unmeasured.length > 0) {
    return {
      ...base,
      status: "unmeasured",
      reasonCode: "variant.claims.unmeasured",
      summary: `Seed ${variant.seed} has no usable verdict for ${unmeasured.join(", ")}`,
      failedClaimIds: failed,
      unmeasuredClaimIds: unmeasured,
    };
  }
  if (failed.length > 0) {
    return {
      ...base,
      status: "rejected",
      reasonCode: "variant.claims.failed",
      summary: `Seed ${variant.seed} failed ${failed.join(", ")}`,
      failedClaimIds: failed,
      unmeasuredClaimIds: [],
    };
  }
  if (variant.quorum === undefined) {
    return {
      ...base,
      status: "unmeasured",
      reasonCode: "variant.quorum.missing",
      summary: `Seed ${variant.seed} passed every byte-level claim but was never evaluated semantically`,
      failedClaimIds: [],
      unmeasuredClaimIds: [...SEMANTIC_CLAIM_IDS],
    };
  }
  if (!variant.quorum.satisfied) {
    const indecisive = variant.quorum.reasonCode === "quorum.evaluations.indecisive";
    return {
      ...base,
      status: indecisive ? "unmeasured" : "rejected",
      reasonCode: variant.quorum.reasonCode,
      summary: `Seed ${variant.seed}: ${variant.quorum.summary}`,
      failedClaimIds: variant.quorum.claims.filter(claim => claim.verdict === "FAIL").map(claim => claim.id),
      unmeasuredClaimIds: variant.quorum.claims.filter(claim => claim.verdict === "VALIDATOR_ERROR" || claim.verdict === "INCONCLUSIVE").map(claim => claim.id),
    };
  }
  return {
    ...base,
    status: "accepted",
    reasonCode: "variant.accepted",
    summary: `Seed ${variant.seed} satisfied every byte-level claim and the semantic quorum`,
    publishedDigest: variant.normalization.digest,
    publishedBytes: variant.normalization.bytes,
    failedClaimIds: [],
    unmeasuredClaimIds: [],
  };
}

/**
 * Assesses one round of four seeds and names the variant to publish.
 *
 * The list must hold one record per recorded seed, in the lock's seed order.
 * Anything else is refused rather than reordered, because selection means
 * nothing if the caller chose the order.
 */
export function assessRound(variants: readonly VariantRecord[], lock: ReferenceImageLock = referenceImageLock): RoundAssessment {
  const seeds = lock.generation.seeds;
  if (variants.length !== seeds.length) {
    throw new ReferenceImageVariantError("reference_image_round_shape", `A round must hold ${seeds.length} variants, one per recorded seed, and holds ${variants.length}`);
  }
  variants.forEach((variant, position) => {
    if (variant.index !== position) {
      throw new ReferenceImageVariantError("reference_image_round_order", `The variant at position ${position} claims index ${variant.index}; a collect map keeps every slot in input order`);
    }
    if (variant.seed !== seeds[position]) {
      throw new ReferenceImageVariantError("reference_image_round_seed", `The variant at position ${position} carries seed ${variant.seed} where the lock records ${seeds[position]}`);
    }
  });

  const assessed = variants.map(assessVariant);
  const accepted = assessed.find(entry => entry.status === "accepted");
  if (accepted !== undefined) {
    return {
      accepted,
      variants: Object.freeze(assessed),
      reasonCode: "round.accepted",
      summary: `Seed ${accepted.seed} at position ${accepted.index} is the first accepted variant in input order`,
    };
  }
  const unmeasured = assessed.filter(entry => entry.status === "unmeasured");
  if (unmeasured.length > 0) {
    return {
      variants: Object.freeze(assessed),
      reasonCode: "round.unmeasured",
      summary: `No variant was accepted and ${unmeasured.length} of ${assessed.length} could not be measured, so the round is unfinished rather than rejected`,
    };
  }
  return {
    variants: Object.freeze(assessed),
    reasonCode: "round.rejected",
    summary: `All ${assessed.length} variants were measured and none satisfied the contract`,
  };
}

/**
 * The dense, input-ordered outcome list a `collect` map produced, read back.
 *
 * A `collect` map yields one envelope per input item whether it succeeded or
 * failed. Reading it into variant records keeps the failed slots, so a later
 * selection still counts positions the way the seeds were offered.
 */
export interface CollectedOutcome {
  readonly outcome: "succeeded" | "failed";
  readonly value?: { readonly digest: string; readonly bytes: number; readonly runtime?: Readonly<Record<string, string>> };
  readonly error?: string;
}

export function variantsFromCollect(outcomes: readonly CollectedOutcome[], lock: ReferenceImageLock = referenceImageLock): readonly VariantRecord[] {
  const seeds = lock.generation.seeds;
  if (outcomes.length !== seeds.length) {
    throw new ReferenceImageVariantError("reference_image_collect_shape", `A collect map over ${seeds.length} seeds yields ${seeds.length} outcomes and yielded ${outcomes.length}`);
  }
  return Object.freeze(
    outcomes.map((entry, index) => {
      const seed = seeds[index] as number;
      if (entry.outcome === "failed") {
        return Object.freeze({ index, seed, generation: Object.freeze({ outcome: "failed" as const, error: entry.error ?? "MAP_ITEM_FAILED" }) });
      }
      if (entry.value === undefined) {
        throw new ReferenceImageVariantError("reference_image_collect_value", `The outcome for seed ${seed} reports success and carries no image`);
      }
      return Object.freeze({
        index,
        seed,
        generation: Object.freeze({ outcome: "succeeded" as const, digest: entry.value.digest, bytes: entry.value.bytes, runtime: Object.freeze({ ...entry.value.runtime }) }),
      });
    }),
  );
}
