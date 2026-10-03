import { describe, expect, test } from "bun:test";

import {
  evaluationVerdict,
  readSemanticAnswer,
  ReferenceImageEvaluationError,
  rerunnableEvaluations,
  scoreSemanticQuorum,
  SEMANTIC_CLAIM_IDS,
  semanticClaimOutcome,
  semanticClaimReport,
  type SemanticEvaluation,
  type SemanticFields,
} from "./semantic-quorum.ts";

const CONFIGURATION = `sha256:${"c".repeat(64)}`;
const ALL_TRUE: SemanticFields = { oneOakTree: true, greenFoliage: true, plainWhiteBackground: true, noText: true };

function held(index: number, fields: Partial<SemanticFields> = {}): SemanticEvaluation {
  return { index, outcome: { kind: "fields", fields: { ...ALL_TRUE, ...fields }, raw: "{}" }, measuredAtMs: 1_000 + index };
}

function unusable(index: number, reasonCode = "evaluation.answer.unparsed"): SemanticEvaluation {
  return { index, outcome: { kind: "unusable", reasonCode, detail: "the evaluator answered nothing usable" }, measuredAtMs: 1_000 + index };
}

describe("reading one evaluator answer", () => {
  test("accepts exactly the four declared boolean fields", () => {
    const outcome = readSemanticAnswer('{"oneOakTree":true,"greenFoliage":true,"plainWhiteBackground":false,"noText":true}');
    expect(outcome.kind).toBe("fields");
    if (outcome.kind !== "fields") throw new Error("unreachable");
    expect(outcome.fields).toEqual({ oneOakTree: true, greenFoliage: true, plainWhiteBackground: false, noText: true });
  });

  test("accepts the fields in any order and ignores surrounding whitespace", () => {
    const outcome = readSemanticAnswer('\n  {"noText":false,"plainWhiteBackground":true,"greenFoliage":true,"oneOakTree":true}  \n');
    expect(outcome.kind).toBe("fields");
  });

  test("an empty answer is unusable rather than a denial", () => {
    const outcome = readSemanticAnswer("   ");
    expect(outcome).toMatchObject({ kind: "unusable", reasonCode: "evaluation.answer.empty" });
  });

  test("prose around the object is unusable", () => {
    const outcome = readSemanticAnswer('Here is my answer: {"oneOakTree":true,"greenFoliage":true,"plainWhiteBackground":true,"noText":true}');
    expect(outcome).toMatchObject({ kind: "unusable", reasonCode: "evaluation.answer.unparsed" });
  });

  test("an array or a bare value is unusable", () => {
    expect(readSemanticAnswer("[true,true,true,true]")).toMatchObject({ reasonCode: "evaluation.answer.not_object" });
    expect(readSemanticAnswer("true")).toMatchObject({ reasonCode: "evaluation.answer.not_object" });
    expect(readSemanticAnswer("null")).toMatchObject({ reasonCode: "evaluation.answer.not_object" });
  });

  test("a missing field is unusable and names what was asked", () => {
    const outcome = readSemanticAnswer('{"oneOakTree":true,"greenFoliage":true,"plainWhiteBackground":true}');
    expect(outcome).toMatchObject({ kind: "unusable", reasonCode: "evaluation.answer.fields" });
    if (outcome.kind !== "unusable") throw new Error("unreachable");
    expect(outcome.detail).toContain("noText");
  });

  test("an extra field is unusable, because the evaluator answered a different question", () => {
    const outcome = readSemanticAnswer('{"oneOakTree":true,"greenFoliage":true,"plainWhiteBackground":true,"noText":true,"confidence":0.9}');
    expect(outcome).toMatchObject({ reasonCode: "evaluation.answer.fields" });
  });

  test("a string in place of a boolean is unusable and never read as true", () => {
    const outcome = readSemanticAnswer('{"oneOakTree":"true","greenFoliage":true,"plainWhiteBackground":true,"noText":true}');
    expect(outcome).toMatchObject({ kind: "unusable", reasonCode: "evaluation.answer.not_boolean" });
    if (outcome.kind !== "unusable") throw new Error("unreachable");
    expect(outcome.detail).toContain("oneOakTree");
  });

  test("a null in place of a boolean is unusable", () => {
    expect(readSemanticAnswer('{"oneOakTree":null,"greenFoliage":true,"plainWhiteBackground":true,"noText":true}')).toMatchObject({
      reasonCode: "evaluation.answer.not_boolean",
    });
  });

  test("an unusable answer keeps a bounded copy of what was said", () => {
    const outcome = readSemanticAnswer("x".repeat(2_000));
    if (outcome.kind !== "unusable") throw new Error("unreachable");
    expect(outcome.raw?.length).toBe(512);
  });
});

describe("one evaluation's own verdict", () => {
  test("every field held is a pass", () => {
    expect(evaluationVerdict(held(0))).toBe("PASS");
  });

  test("any field denied is a fail", () => {
    expect(evaluationVerdict(held(0, { noText: false }))).toBe("FAIL");
    expect(evaluationVerdict(held(0, { oneOakTree: false }))).toBe("FAIL");
  });

  test("an unusable answer is a validator error, never a fail", () => {
    expect(evaluationVerdict(unusable(0))).toBe("VALIDATOR_ERROR");
  });

  test("a claim outcome names its contract claim and carries no evidence", () => {
    const outcome = semanticClaimOutcome(held(1, { greenFoliage: false }));
    expect(outcome.id).toBe(SEMANTIC_CLAIM_IDS[1]);
    expect(outcome.verdict).toBe("FAIL");
    expect(outcome.decisive).toBe(true);
    expect(outcome.summary).toContain("greenFoliage");
    expect(outcome.evidence).toEqual([]);
    expect(outcome.measuredAtMs).toBe(1_001);
  });

  test("an unusable evaluation is recorded as indecisive", () => {
    expect(semanticClaimOutcome(unusable(2)).decisive).toBe(false);
  });

  test("an index outside the three declared claims is refused", () => {
    expect(() => semanticClaimOutcome(held(3))).toThrow(ReferenceImageEvaluationError);
  });
});

describe("scoring the quorum", () => {
  test("three passing evaluations satisfy it", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), held(2)], CONFIGURATION);
    expect(quorum.satisfied).toBe(true);
    expect(quorum.reasonCode).toBe("quorum.passes.met");
    expect(quorum.passes).toBe(3);
  });

  test("two passes and one measured failure satisfy it", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), held(2, { plainWhiteBackground: false })], CONFIGURATION);
    expect(quorum.satisfied).toBe(true);
    expect(quorum.passes).toBe(2);
    expect(quorum.failures).toBe(1);
  });

  test("one pass and two failures fall below the threshold", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1, { noText: false }), held(2, { noText: false })], CONFIGURATION);
    expect(quorum.satisfied).toBe(false);
    expect(quorum.reasonCode).toBe("quorum.passes.below_threshold");
  });

  test("two passes and one unusable result do NOT satisfy it", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), unusable(2)], CONFIGURATION);
    expect(quorum.satisfied).toBe(false);
    expect(quorum.reasonCode).toBe("quorum.evaluations.indecisive");
    expect(quorum.passes).toBe(2);
    expect(quorum.unusable).toBe(1);
  });

  test("an indecisive result is reported before a threshold shortfall", () => {
    const quorum = scoreSemanticQuorum([held(0, { noText: false }), held(1, { noText: false }), unusable(2)], CONFIGURATION);
    expect(quorum.reasonCode).toBe("quorum.evaluations.indecisive");
  });

  test("fewer evaluations than the contract declares is refused even when all passed", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1)], CONFIGURATION);
    expect(quorum.satisfied).toBe(false);
    expect(quorum.reasonCode).toBe("quorum.evaluations.count");
  });

  test("more evaluations than the contract declares is refused", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), held(2), held(0)], CONFIGURATION);
    expect(quorum.reasonCode).toBe("quorum.evaluations.count");
  });

  test("three records that are really the same evaluation twice are refused", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), held(1)], CONFIGURATION);
    expect(quorum.satisfied).toBe(false);
    expect(quorum.reasonCode).toBe("quorum.evaluations.duplicate");
  });

  test("it tallies every field so a reader can see which one was denied", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1, { greenFoliage: false }), unusable(2)], CONFIGURATION);
    expect(quorum.fields).toEqual([
      { field: "oneOakTree", held: 2, denied: 0, unusable: 1 },
      { field: "greenFoliage", held: 1, denied: 1, unusable: 1 },
      { field: "plainWhiteBackground", held: 2, denied: 0, unusable: 1 },
      { field: "noText", held: 2, denied: 0, unusable: 1 },
    ]);
  });

  test("it records the shared provenance and never calls the agreement independent", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1), held(2)], CONFIGURATION);
    expect(quorum.commonProvenance).toEqual({ model: "claude-haiku-4-5-20251001", configurationDigest: CONFIGURATION, independent: false });
  });

  test("it carries one claim outcome per evaluation, whatever the verdict", () => {
    const quorum = scoreSemanticQuorum([held(0), held(1, { noText: false }), unusable(2)], CONFIGURATION);
    expect(quorum.claims.map(claim => claim.verdict)).toEqual(["PASS", "FAIL", "VALIDATOR_ERROR"]);
    expect(quorum.claims.map(claim => claim.id)).toEqual([...SEMANTIC_CLAIM_IDS]);
  });
});

describe("bounded reruns", () => {
  test("only an unusable evaluation is eligible", () => {
    expect(rerunnableEvaluations([held(0, { noText: false }), held(1), unusable(2)], 0, 2)).toEqual([2]);
  });

  test("a measured failure is never rerun, however many attempts remain", () => {
    expect(rerunnableEvaluations([held(0, { noText: false }), held(1, { noText: false }), held(2, { noText: false })], 0, 5)).toEqual([]);
  });

  test("nothing is eligible once the bound is spent", () => {
    expect(rerunnableEvaluations([unusable(0), unusable(1), unusable(2)], 2, 2)).toEqual([]);
  });

  test("several unusable evaluations are all eligible while the bound allows", () => {
    expect(rerunnableEvaluations([unusable(0), held(1), unusable(2)], 1, 2)).toEqual([0, 2]);
  });
});

describe("the guest-side claim report", () => {
  test("it names the strict claim schema and carries no provenance", () => {
    const report = semanticClaimReport([held(0), held(1), held(2)]);
    expect(report.schemaVersion).toBe("factory.validator-claims.v1");
    expect(report.claims).toHaveLength(3);
    expect(JSON.stringify(report)).not.toContain("provenance");
  });

  test("an empty report is refused rather than written", () => {
    expect(() => semanticClaimReport([])).toThrow(ReferenceImageEvaluationError);
  });
});
