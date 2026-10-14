import {
  FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION,
  type FactoryValidatorClaimReport,
} from "@ezcorp/factory-sdk";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { digestObject } from "../../extensions/v4/blobs";
import type { FactoryBroker, FactoryOperation } from "../../runtime/factory-execution";
import type { ReferenceCodeCandidate } from "./freeze";
import { parseReferenceCodeReview, REFERENCE_CODE_REVIEW_SYSTEM_PROMPT, referenceCodeReviewClaim, referenceCodeReviewPrompt, type ReferenceCodeReviewOutcome } from "./review-rules";
import type { ReferenceCodeFile, ReferenceCodeSnapshot } from "./snapshot";

/**
 * The tenth mandatory claim: a supervised review, in its own validator context.
 *
 * Separate is the operative word. This evaluator runs one model call with no tools, no filesystem,
 * no broker grant beyond the model itself, and no knowledge of what the deterministic checks
 * concluded, so its answer is independent of the process that produced the candidate. It is still
 * the same model family as the generator, and C10 says plainly what that means: its verdict is
 * probabilistic evidence, not calibrated certainty, and it is one required claim among ten rather
 * than a substitute for them.
 *
 * The rubric is strict in both directions. All three fields must be present and boolean and true
 * for a PASS. A missing field, an extra field, an unparseable answer, or a transport error is
 * VALIDATOR_ERROR — never a pass, and never a quiet FAIL either, because "the reviewer broke" and
 * "the reviewer objected" call for different operator actions.
 */

export {
  REFERENCE_CODE_REVIEW_CLAIM_ID,
  REFERENCE_CODE_REVIEW_FIELDS,
  type ReferenceCodeReviewField,
  REFERENCE_CODE_REVIEW_FILE_LIMIT,
  type ReferenceCodeReviewRubric,
  type ReferenceCodeReviewOutcome,
  REFERENCE_CODE_REVIEW_SYSTEM_PROMPT,
  referenceCodeReviewPrompt,
  parseReferenceCodeReview,
  referenceCodeReviewClaim,
} from "./review-rules";

export interface ReferenceCodeReviewInput {
  readonly candidate: ReferenceCodeCandidate;
  readonly snapshot: ReferenceCodeSnapshot;
  readonly files: readonly ReferenceCodeFile[];
  readonly issue: string;
  readonly broker: FactoryBroker;
  readonly attemptToken: string;
  readonly model: { readonly provider: string; readonly model: string };
  readonly now?: () => number;
  readonly operationPrefix?: string;
}

export interface ReferenceCodeReview {
  readonly report: FactoryValidatorClaimReport;
  readonly outcome: ReferenceCodeReviewOutcome;
  readonly promptDigest: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly model: { readonly provider: string; readonly model: string };
}

/**
 * Runs the supervised review and reports its one claim.
 *
 * A transport failure is caught and becomes a VALIDATOR_ERROR claim, because an evaluator that
 * could not be reached must not silently drop out of a ten-claim contract: `assurance.ts` treats a
 * missing required claim and an errored one differently, and only one of them is true here.
 */
export async function referenceCodeSupervisedReview(input: ReferenceCodeReviewInput): Promise<ReferenceCodeReview> {
  const now = input.now ?? Date.now;
  const prompt = referenceCodeReviewPrompt({
    issue: input.issue,
    snapshot: input.snapshot,
    files: input.files,
    changedPaths: input.candidate.changedPaths,
  });
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: 0 }];
  const promptDigest = `sha256:${digestObject({ systemPrompt: REFERENCE_CODE_REVIEW_SYSTEM_PROMPT, prompt })}`;
  const operation: FactoryOperation = {
    operationId: `${input.operationPrefix ?? "reference-code-review"}:${input.candidate.candidateGeneration}:1`,
    operationIndex: 1,
    kind: "model",
    requestDigest: digestObject({ promptDigest, candidate: input.candidate.commitSha }),
    state: "prepared",
  };

  let outcome: ReferenceCodeReviewOutcome;
  let usage = { inputTokens: 0, outputTokens: 0 };
  try {
    const stream = await input.broker.stream({
      attemptToken: input.attemptToken,
      operation,
      model: { id: input.model.model, provider: input.model.provider } as never,
      context: { systemPrompt: REFERENCE_CODE_REVIEW_SYSTEM_PROMPT, messages, tools: [] },
      options: {},
    });
    const message: AssistantMessage = await stream.result();
    usage = { inputTokens: message.usage?.input ?? 0, outputTokens: message.usage?.output ?? 0 };
    outcome = message.stopReason === "error" || message.stopReason === "aborted"
      ? { kind: "error", code: "review_transport_failed", message: message.errorMessage ?? message.stopReason }
      : parseReferenceCodeReview(message.content.filter(entry => entry.type === "text").map(entry => (entry as { text: string }).text).join("\n"));
  } catch (error) {
    outcome = { kind: "error", code: "review_transport_failed", message: String((error as Error).message).slice(0, 4000) };
  }

  return {
    report: { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: [referenceCodeReviewClaim(outcome, now())] },
    outcome,
    promptDigest,
    usage,
    model: input.model,
  };
}
