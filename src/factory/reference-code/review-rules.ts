import type { FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk/types";
import type { ReferenceCodeFile, ReferenceCodeSnapshot } from "./snapshot";

/**
 * The supervised review's rules, with no model SDK and no broker (W4H-28): the rubric, the
 * reviewer's prompt, the strict parse of its answer, and the one claim it reports. Split out of
 * `review.ts` so the review can run in a sandboxed validator guest, through the guest's one model
 * call, under exactly the rules the host review applies.
 */

export const REFERENCE_CODE_REVIEW_CLAIM_ID = "supervised-review";
export const REFERENCE_CODE_REVIEW_FIELDS = Object.freeze(["matchesRequest", "noUnrequestedEffect", "noKnownCriticalIssue"] as const);
export type ReferenceCodeReviewField = (typeof REFERENCE_CODE_REVIEW_FIELDS)[number];

/** How much of one changed file the reviewer is shown. Enough to judge, bounded against a flood. */
export const REFERENCE_CODE_REVIEW_FILE_LIMIT = 32 * 1024;

export interface ReferenceCodeReviewRubric {
  readonly matchesRequest: boolean;
  readonly noUnrequestedEffect: boolean;
  readonly noKnownCriticalIssue: boolean;
  readonly reason: string;
}

export type ReferenceCodeReviewOutcome =
  | { readonly kind: "decided"; readonly rubric: ReferenceCodeReviewRubric }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

const decoder = new TextDecoder("utf-8", { fatal: false });

function text(file: ReferenceCodeFile | undefined): string {
  if (!file) return "(absent)";
  const body = decoder.decode(file.content);
  return body.length > REFERENCE_CODE_REVIEW_FILE_LIMIT ? `${body.slice(0, REFERENCE_CODE_REVIEW_FILE_LIMIT)}\n… truncated …` : body;
}

/** The reviewer's instructions. Strict output shape, stated once, with no room for prose. */
export const REFERENCE_CODE_REVIEW_SYSTEM_PROMPT = [
  "You review one proposed change to a small Bun and TypeScript package. You have no tools and cannot run anything.",
  "",
  "Answer with one JSON object and nothing else, with exactly these four fields:",
  '  "matchesRequest": true when the change does what the request asked for.',
  '  "noUnrequestedEffect": true when the change does nothing the request did not ask for.',
  '  "noKnownCriticalIssue": true when you see no critical correctness or security problem in it.',
  '  "reason": one short sentence explaining any false field, or why all three are true.',
  "",
  "Set a field to false when you are not satisfied. Do not add fields, do not omit fields, and do not wrap the object in code fences.",
].join("\n");

/** The exact material the reviewer judges: the request, and every changed file before and after. */
export function referenceCodeReviewPrompt(input: {
  readonly issue: string;
  readonly snapshot: ReferenceCodeSnapshot;
  readonly files: readonly ReferenceCodeFile[];
  readonly changedPaths: readonly string[];
}): string {
  const before = new Map(input.snapshot.files.map(file => [file.path, file]));
  const after = new Map(input.files.map(file => [file.path, file]));
  const sections = input.changedPaths.map(path => [
    `### ${path}`,
    "Before:",
    "```",
    text(before.get(path)),
    "```",
    "After:",
    "```",
    text(after.get(path)),
    "```",
  ].join("\n"));
  return [`Request:\n${input.issue}`, "", `Changed files (${input.changedPaths.length}):`, "", ...sections].join("\n");
}

/**
 * Reads the reviewer's answer, strictly.
 *
 * Every way an answer can be wrong is one error rather than a verdict: not JSON, not an object, a
 * missing field, a field that is not a boolean, or a field nobody asked for. A reviewer that
 * answers `{"matchesRequest": "yes"}` has not said true.
 */
export function parseReferenceCodeReview(answer: string): ReferenceCodeReviewOutcome {
  const trimmed = answer.trim();
  if (trimmed.length === 0) return { kind: "error", code: "review_empty", message: "The reviewer returned no content." };
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { return { kind: "error", code: "review_unparseable", message: "The reviewer's answer is not one JSON object." }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "error", code: "review_not_an_object", message: "The reviewer's answer is not a JSON object." };
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...REFERENCE_CODE_REVIEW_FIELDS, "reason"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return { kind: "error", code: "review_fields_unexpected", message: `The reviewer answered with fields [${keys.join(", ")}] rather than [${expected.join(", ")}].` };
  }
  for (const field of REFERENCE_CODE_REVIEW_FIELDS) {
    if (typeof record[field] !== "boolean") {
      return { kind: "error", code: "review_field_not_boolean", message: `The reviewer's '${field}' is not a boolean.` };
    }
  }
  if (typeof record.reason !== "string") {
    return { kind: "error", code: "review_field_not_boolean", message: "The reviewer's 'reason' is not a string." };
  }
  return {
    kind: "decided",
    rubric: {
      matchesRequest: record.matchesRequest as boolean,
      noUnrequestedEffect: record.noUnrequestedEffect as boolean,
      noKnownCriticalIssue: record.noKnownCriticalIssue as boolean,
      reason: (record.reason as string).slice(0, 1024),
    },
  };
}

/** One claim outcome from one review outcome. */
export function referenceCodeReviewClaim(outcome: ReferenceCodeReviewOutcome, measuredAtMs: number): FactoryValidatorClaimOutcome {
  if (outcome.kind === "error") {
    return {
      id: REFERENCE_CODE_REVIEW_CLAIM_ID,
      verdict: "VALIDATOR_ERROR",
      decisive: false,
      summary: `${outcome.message} A reviewer that did not answer the rubric has not approved anything.`,
      reasonCode: outcome.code,
      evidence: [],
      measuredAtMs,
    };
  }
  const failed = REFERENCE_CODE_REVIEW_FIELDS.filter(field => !outcome.rubric[field]);
  if (failed.length > 0) {
    return {
      id: REFERENCE_CODE_REVIEW_CLAIM_ID,
      verdict: "FAIL",
      decisive: true,
      summary: `The supervised reviewer set ${failed.join(" and ")} to false: ${outcome.rubric.reason}`.slice(0, 2048),
      reasonCode: "review_rubric_not_satisfied",
      evidence: [],
      measuredAtMs,
    };
  }
  return {
    id: REFERENCE_CODE_REVIEW_CLAIM_ID,
    verdict: "PASS",
    decisive: true,
    summary: `The supervised reviewer set all three rubric fields true: ${outcome.rubric.reason}. This is probabilistic evidence from one model, not calibrated certainty.`.slice(0, 2048),
    reasonCode: "review_rubric_satisfied",
    evidence: [],
    measuredAtMs,
  };
}

