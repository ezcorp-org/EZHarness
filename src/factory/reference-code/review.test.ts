import { describe, expect, test } from "bun:test";
import { validateFactoryValidatorClaimReport } from "@ezcorp/factory-sdk";
import { fakeReferenceCodeBroker, failingReferenceCodeBroker } from "../../__tests__/helpers/reference-code-broker-fake";
import { freezeReferenceCodeCandidate } from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import {
  parseReferenceCodeReview,
  referenceCodeReviewClaim,
  referenceCodeReviewPrompt,
  referenceCodeSupervisedReview,
  REFERENCE_CODE_REVIEW_CLAIM_ID,
  REFERENCE_CODE_REVIEW_FIELDS,
  REFERENCE_CODE_REVIEW_FILE_LIMIT,
  REFERENCE_CODE_REVIEW_SYSTEM_PROMPT,
  type ReferenceCodeReviewInput,
} from "./review";
import { sealReferenceCodeSnapshot } from "./snapshot";

const BASE = "a".repeat(39) + "1";
const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const NOW = Date.parse("2026-09-14T00:00:00.000Z");

const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: "b".repeat(39) + "2",
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});
const files = referenceCodeFixtureCandidate("accepted");
const candidate = freezeReferenceCodeCandidate({
  snapshot,
  files,
  repositoryId: 1,
  baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
  issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
  title: REFERENCE_CODE_FIXTURE_REQUEST.title,
  allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
  protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
  authoredAtSeconds: 1_760_000_000,
  candidateGeneration: 0,
});

function reviewInput(broker: ReferenceCodeReviewInput["broker"]): ReferenceCodeReviewInput {
  return { candidate, snapshot, files, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue, broker, attemptToken: "attempt-token", model: MODEL, now: () => NOW };
}

const APPROVAL = JSON.stringify({ matchesRequest: true, noUnrequestedEffect: true, noKnownCriticalIssue: true, reason: "Implements the requested slug rules and nothing else." });

describe("the supervised review claim", () => {
  test("passes only when all three rubric fields are true, and says the evidence is probabilistic", async () => {
    const review = await referenceCodeSupervisedReview(reviewInput(fakeReferenceCodeBroker([{ text: APPROVAL }])));
    expect(validateFactoryValidatorClaimReport(review.report).ok).toBe(true);
    const claim = review.report.claims[0]!;
    expect(claim.id).toBe(REFERENCE_CODE_REVIEW_CLAIM_ID);
    expect(claim.verdict).toBe("PASS");
    expect(claim.decisive).toBe(true);
    expect(claim.reasonCode).toBe("review_rubric_satisfied");
    expect(claim.summary).toContain("not calibrated certainty");
    expect(claim.measuredAtMs).toBe(NOW);
  });

  test("fails and names every field the reviewer set false", async () => {
    const answer = JSON.stringify({ matchesRequest: true, noUnrequestedEffect: false, noKnownCriticalIssue: false, reason: "It also rewrote the build script." });
    const review = await referenceCodeSupervisedReview(reviewInput(fakeReferenceCodeBroker([{ text: answer }])));
    const claim = review.report.claims[0]!;
    expect(claim.verdict).toBe("FAIL");
    expect(claim.reasonCode).toBe("review_rubric_not_satisfied");
    expect(claim.summary).toContain("noUnrequestedEffect and noKnownCriticalIssue");
    expect(claim.summary).toContain("rewrote the build script");
  });

  test("a reviewer that did not answer the rubric is an error, never a pass", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["", "review_empty"],
      ["not json at all", "review_unparseable"],
      ["[1,2]", "review_not_an_object"],
      ['{"matchesRequest": true}', "review_fields_unexpected"],
      ['{"matchesRequest":true,"noUnrequestedEffect":true,"noKnownCriticalIssue":true,"reason":"ok","extra":1}', "review_fields_unexpected"],
      ['{"matchesRequest":"yes","noUnrequestedEffect":true,"noKnownCriticalIssue":true,"reason":"ok"}', "review_field_not_boolean"],
      ['{"matchesRequest":true,"noUnrequestedEffect":true,"noKnownCriticalIssue":true,"reason":5}', "review_field_not_boolean"],
    ];
    for (const [answer, code] of cases) {
      const review = await referenceCodeSupervisedReview(reviewInput(fakeReferenceCodeBroker([{ text: answer }])));
      const claim = review.report.claims[0]!;
      expect(claim.verdict).toBe("VALIDATOR_ERROR");
      expect(claim.reasonCode).toBe(code);
      expect(claim.decisive).toBe(false);
      expect(claim.summary).toContain("has not approved anything");
    }
  });

  test("a transport failure and a provider error are both validator errors, not verdicts", async () => {
    const thrown = await referenceCodeSupervisedReview(reviewInput(failingReferenceCodeBroker("provider unreachable")));
    expect(thrown.report.claims[0]!.verdict).toBe("VALIDATOR_ERROR");
    expect(thrown.report.claims[0]!.reasonCode).toBe("review_transport_failed");
    expect(thrown.report.claims[0]!.summary).toContain("provider unreachable");

    const errored = await referenceCodeSupervisedReview(reviewInput(fakeReferenceCodeBroker([{ stopReason: "error", errorMessage: "overloaded" }])));
    expect(errored.report.claims[0]!.verdict).toBe("VALIDATOR_ERROR");
    expect(errored.report.claims[0]!.summary).toContain("overloaded");

    const aborted = await referenceCodeSupervisedReview(reviewInput(fakeReferenceCodeBroker([{ stopReason: "aborted" }])));
    expect(aborted.report.claims[0]!.verdict).toBe("VALIDATOR_ERROR");
  });

  test("a rejected candidate's own validator error claim still validates against the SDK schema", () => {
    const claim = referenceCodeReviewClaim({ kind: "error", code: "review_empty", message: "nothing" }, NOW);
    expect(validateFactoryValidatorClaimReport({ schemaVersion: "factory.validator-claims.v1", claims: [claim] }).ok).toBe(true);
  });
});

describe("the reviewer's separate context", () => {
  test("runs with no tools, one model call, and records its usage and prompt identity", async () => {
    const broker = fakeReferenceCodeBroker([{ text: APPROVAL, usage: { input: 1200, output: 40 } }]);
    const review = await referenceCodeSupervisedReview(reviewInput(broker));
    expect(broker.requests).toHaveLength(1);
    expect(broker.contexts[0]!.tools).toEqual([]);
    expect(broker.contexts[0]!.systemPrompt).toBe(REFERENCE_CODE_REVIEW_SYSTEM_PROMPT);
    expect(review.usage).toEqual({ inputTokens: 1200, outputTokens: 40 });
    expect(review.promptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(review.model).toEqual(MODEL);
    expect(broker.requests[0]!.operation.operationId).toBe("reference-code-review:0:1");
  });

  test("is shown only the changed files, before and after", () => {
    const prompt = referenceCodeReviewPrompt({ issue: "do the thing", snapshot, files, changedPaths: candidate.changedPaths });
    expect(prompt).toContain("Changed files (1):");
    expect(prompt).toContain("### src/slugify.ts");
    expect(prompt).toContain("slugify is not implemented");
    expect(prompt).toContain("words.join(\"-\")");
    expect(prompt).not.toContain("lockfileVersion");
  });

  test("shows an added file as absent before, and truncates a very large file", () => {
    const big = "x".repeat(REFERENCE_CODE_REVIEW_FILE_LIMIT + 500);
    const prompt = referenceCodeReviewPrompt({
      issue: "do the thing",
      snapshot,
      files: [...files, { path: "src/added.ts", mode: "100644", content: new TextEncoder().encode(big) }],
      changedPaths: ["src/added.ts"],
    });
    expect(prompt).toContain("Before:\n```\n(absent)");
    expect(prompt).toContain("… truncated …");
  });

  test("the rubric is exactly the three C10 fields", () => {
    expect([...REFERENCE_CODE_REVIEW_FIELDS]).toEqual(["matchesRequest", "noUnrequestedEffect", "noKnownCriticalIssue"]);
    const parsed = parseReferenceCodeReview(APPROVAL);
    expect(parsed.kind).toBe("decided");
    if (parsed.kind !== "decided") throw new Error("unreachable");
    expect(parsed.rubric.matchesRequest).toBe(true);
  });
});
