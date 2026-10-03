/**
 * The three protected semantic evaluations and the rule that combines them.
 *
 * C10 asks for two complete PASS evaluations covering every semantic field, and
 * for no validator error or inconclusive result. Those are two separate
 * requirements and this module keeps them separate, because collapsing them is
 * the mistake that turns a broken evaluator into a passing variant: two
 * successes and one error is not "two out of three", it is an unfinished
 * measurement.
 *
 * The evaluations share one model, one prompt, and one configuration. Agreement
 * between them is therefore evidence of consistency, not of independent
 * confidence, and `SemanticQuorum` records the common provenance so a reader
 * cannot mistake three answers for three opinions.
 */
import { FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION } from "@ezcorp/factory-sdk";
import type { FactoryValidatorClaimOutcome, FactoryValidatorClaimReport, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";

import { referenceImageLock, type ReferenceImageEvaluationLock } from "./lock.ts";

/** The claim ids the acceptance contract declares for the three evaluations. */
export const SEMANTIC_CLAIM_IDS = Object.freeze(["semantic-evaluation-1", "semantic-evaluation-2", "semantic-evaluation-3"] as const);

/** The group the acceptance contract scores these claims under. */
export const SEMANTIC_QUORUM_GROUP_ID = "semantic-quorum";

/**
 * One evaluation's strict answer.
 *
 * Every field is required and must be a boolean. A model that omits a field or
 * answers with anything else has not evaluated it, and the reading below treats
 * that as an unusable result rather than as a false.
 */
export interface SemanticFields {
  readonly oneOakTree: boolean;
  readonly greenFoliage: boolean;
  readonly plainWhiteBackground: boolean;
  readonly noText: boolean;
}

export type SemanticEvaluationOutcome =
  | { readonly kind: "fields"; readonly fields: SemanticFields; readonly raw: string }
  | { readonly kind: "unusable"; readonly reasonCode: string; readonly detail: string; readonly raw?: string };

export interface SemanticEvaluation {
  /** Which of the three this is; the claim id follows from it. */
  readonly index: number;
  readonly outcome: SemanticEvaluationOutcome;
  readonly measuredAtMs: number;
}

export class ReferenceImageEvaluationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReferenceImageEvaluationError";
  }
}

/**
 * Reads one evaluator answer into a strict result.
 *
 * The answer must be a JSON object carrying exactly the declared fields, each a
 * boolean. Extra fields, a missing field, a string "true", or prose around the
 * object all make the result unusable. Being permissive here would let a model
 * that misunderstood the question contribute to a quorum.
 */
export function readSemanticAnswer(text: string, lock: ReferenceImageEvaluationLock = referenceImageLock.evaluation): SemanticEvaluationOutcome {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { kind: "unusable", reasonCode: "evaluation.answer.empty", detail: "The evaluator returned no text" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unusable", reasonCode: "evaluation.answer.unparsed", detail: "The evaluator's answer is not JSON", raw: trimmed.slice(0, 512) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "unusable", reasonCode: "evaluation.answer.not_object", detail: "The evaluator's answer is not an object", raw: trimmed.slice(0, 512) };
  }
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = [...lock.fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return {
      kind: "unusable",
      reasonCode: "evaluation.answer.fields",
      detail: `The evaluator answered fields ${keys.join(", ")} where ${expected.join(", ")} were asked`,
      raw: trimmed.slice(0, 512),
    };
  }
  for (const key of expected) {
    if (typeof value[key] !== "boolean") {
      return {
        kind: "unusable",
        reasonCode: "evaluation.answer.not_boolean",
        detail: `The evaluator answered ${key} with a ${typeof value[key]} rather than a boolean`,
        raw: trimmed.slice(0, 512),
      };
    }
  }
  return {
    kind: "fields",
    fields: {
      oneOakTree: value.oneOakTree as boolean,
      greenFoliage: value.greenFoliage as boolean,
      plainWhiteBackground: value.plainWhiteBackground as boolean,
      noText: value.noText as boolean,
    },
    raw: trimmed.slice(0, 512),
  };
}

/** The verdict one evaluation reaches on its own. */
export function evaluationVerdict(evaluation: SemanticEvaluation): FactoryValidatorVerdict {
  if (evaluation.outcome.kind === "unusable") return "VALIDATOR_ERROR";
  return Object.values(evaluation.outcome.fields).every(Boolean) ? "PASS" : "FAIL";
}

function summaryOf(evaluation: SemanticEvaluation): string {
  if (evaluation.outcome.kind === "unusable") return evaluation.outcome.detail;
  const entries = Object.entries(evaluation.outcome.fields);
  const failed = entries.filter(([, held]) => !held).map(([field]) => field);
  return failed.length === 0 ? "Every semantic field held" : `Semantic field(s) not held: ${failed.join(", ")}`;
}

/** One evaluation as a strict claim outcome the guest-side report shape uses. */
export function semanticClaimOutcome(evaluation: SemanticEvaluation): FactoryValidatorClaimOutcome {
  const claimId = SEMANTIC_CLAIM_IDS[evaluation.index];
  if (claimId === undefined) throw new ReferenceImageEvaluationError("reference_image_evaluation_index", `There is no semantic claim at index ${evaluation.index}`);
  const verdict = evaluationVerdict(evaluation);
  return {
    id: claimId,
    verdict,
    // Every evaluation answers the whole question or none of it, so an outcome
    // is never a partial signal another evaluation could complete.
    decisive: verdict !== "VALIDATOR_ERROR",
    summary: summaryOf(evaluation),
    reasonCode: evaluation.outcome.kind === "unusable" ? evaluation.outcome.reasonCode : verdict === "PASS" ? "evaluation.fields.all_held" : "evaluation.fields.not_held",
    evidence: [],
    measuredAtMs: evaluation.measuredAtMs,
  };
}

export interface SemanticFieldTally {
  readonly field: string;
  readonly held: number;
  readonly denied: number;
  readonly unusable: number;
}

export interface SemanticQuorum {
  readonly satisfied: boolean;
  readonly reasonCode: string;
  readonly summary: string;
  readonly passes: number;
  readonly failures: number;
  readonly unusable: number;
  readonly minimumPasses: number;
  readonly fields: readonly SemanticFieldTally[];
  /** The one model, prompt, and configuration all three evaluations shared. */
  readonly commonProvenance: { readonly model: string; readonly configurationDigest: string; readonly independent: false };
  readonly claims: readonly FactoryValidatorClaimOutcome[];
}

/**
 * Scores the three evaluations.
 *
 * The order of the checks is the rule. A count mismatch, then any unusable
 * result, then the pass threshold: an unusable result is reported as such even
 * when two others passed, so the wait for a rerun is never mistaken for a
 * verdict on the picture.
 */
export function scoreSemanticQuorum(
  evaluations: readonly SemanticEvaluation[],
  configurationDigest: string,
  lock: ReferenceImageEvaluationLock = referenceImageLock.evaluation,
): SemanticQuorum {
  const claims = evaluations.map(semanticClaimOutcome);
  const verdicts = evaluations.map(evaluationVerdict);
  const passes = verdicts.filter(verdict => verdict === "PASS").length;
  const failures = verdicts.filter(verdict => verdict === "FAIL").length;
  const unusable = verdicts.filter(verdict => verdict === "VALIDATOR_ERROR").length;
  const fields = lock.fields.map(field => {
    let held = 0;
    let denied = 0;
    let missing = 0;
    for (const evaluation of evaluations) {
      if (evaluation.outcome.kind === "unusable") missing += 1;
      else if ((evaluation.outcome.fields as unknown as Record<string, boolean>)[field]) held += 1;
      else denied += 1;
    }
    return { field, held, denied, unusable: missing };
  });
  const commonProvenance = { model: lock.model, configurationDigest, independent: false as const };
  const base = { passes, failures, unusable, minimumPasses: lock.minimumPasses, fields, commonProvenance, claims };

  if (evaluations.length !== lock.evaluations) {
    return { ...base, satisfied: false, reasonCode: "quorum.evaluations.count", summary: `${evaluations.length} evaluation(s) were recorded where the contract requires ${lock.evaluations}` };
  }
  const duplicated = new Set(evaluations.map(evaluation => evaluation.index)).size !== evaluations.length;
  if (duplicated) {
    return { ...base, satisfied: false, reasonCode: "quorum.evaluations.duplicate", summary: "Two evaluations carry the same index, so fewer than three distinct evaluations ran" };
  }
  if (lock.requireAllDecisive && unusable > 0) {
    return { ...base, satisfied: false, reasonCode: "quorum.evaluations.indecisive", summary: `${unusable} evaluation(s) produced no usable verdict; the quorum requires every evaluation to be decisive` };
  }
  if (passes < lock.minimumPasses) {
    return { ...base, satisfied: false, reasonCode: "quorum.passes.below_threshold", summary: `${passes} of ${evaluations.length} evaluation(s) passed where ${lock.minimumPasses} are required` };
  }
  return { ...base, satisfied: true, reasonCode: "quorum.passes.met", summary: `${passes} of ${evaluations.length} evaluation(s) passed with every evaluation decisive` };
}

/**
 * The evaluations that should be rerun, given how many rounds have been spent.
 *
 * Only an unusable result is eligible. A FAIL is a measurement, and rerunning it
 * until it passes is exactly the behaviour C10 forbids.
 */
export function rerunnableEvaluations(evaluations: readonly SemanticEvaluation[], attemptsSpent: number, maxAttempts: number): readonly number[] {
  if (attemptsSpent >= maxAttempts) return Object.freeze([]);
  return Object.freeze(evaluations.filter(evaluation => evaluation.outcome.kind === "unusable").map(evaluation => evaluation.index));
}

/** The guest-side report carrying the three semantic claims and nothing else. */
export function semanticClaimReport(evaluations: readonly SemanticEvaluation[]): FactoryValidatorClaimReport {
  const claims = evaluations.map(semanticClaimOutcome);
  if (claims.length === 0) throw new ReferenceImageEvaluationError("reference_image_evaluation_empty", "A claim report needs at least one evaluation");
  return { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims };
}
