import { describe, expect, test } from "bun:test";

import type { FactoryValidatorClaimOutcome, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";

import { referenceImageLock } from "./lock.ts";
import { scoreSemanticQuorum, type SemanticEvaluation, type SemanticFields } from "./semantic-quorum.ts";
import {
  assessRound,
  assessVariant,
  REQUIRED_DETERMINISTIC_CLAIM_IDS,
  ReferenceImageVariantError,
  variantsFromCollect,
  type CollectedOutcome,
  type VariantRecord,
} from "./variants.ts";

const CONFIGURATION = `sha256:${"c".repeat(64)}`;
const SEEDS = referenceImageLock.generation.seeds;
const ALL_TRUE: SemanticFields = { oneOakTree: true, greenFoliage: true, plainWhiteBackground: true, noText: true };

function digestOf(label: string): string {
  return `sha256:${label.padEnd(64, "0").slice(0, 64).replace(/[^a-f0-9]/g, "a")}`;
}

function claims(overrides: Partial<Record<(typeof REQUIRED_DETERMINISTIC_CLAIM_IDS)[number], FactoryValidatorVerdict>> = {}): readonly FactoryValidatorClaimOutcome[] {
  return REQUIRED_DETERMINISTIC_CLAIM_IDS.map(id => ({
    id,
    verdict: overrides[id] ?? "PASS",
    decisive: true,
    summary: `${id} measured`,
    reasonCode: `${id}.measured`,
    evidence: [],
    measuredAtMs: 10,
  }));
}

function evaluations(fields: Partial<SemanticFields> = {}): readonly SemanticEvaluation[] {
  return [0, 1, 2].map(index => ({ index, outcome: { kind: "fields" as const, fields: { ...ALL_TRUE, ...fields }, raw: "{}" }, measuredAtMs: 20 + index }));
}

function passingQuorum(fields: Partial<SemanticFields> = {}) {
  return scoreSemanticQuorum(evaluations(fields), CONFIGURATION);
}

function variant(index: number, overrides: Partial<VariantRecord> = {}): VariantRecord {
  const generated = digestOf(`gen${index}`);
  const normalized = digestOf(`norm${index}`);
  return {
    index,
    seed: SEEDS[index] as number,
    generation: { outcome: "succeeded", digest: generated, bytes: 1_500_000, runtime: { torch: "2.12.0+rocm7.14.1" } },
    normalization: { digest: normalized, bytes: 1_400_000, sourceDigest: generated },
    deterministic: claims(),
    quorum: passingQuorum(),
    ...overrides,
  };
}

function round(overrides: Record<number, Partial<VariantRecord>> = {}): readonly VariantRecord[] {
  return SEEDS.map((_, index) => variant(index, overrides[index] ?? {}));
}

describe("assessing one variant", () => {
  test("a variant that satisfies everything is accepted and names the bytes to publish", () => {
    const assessment = assessVariant(variant(0));
    expect(assessment.status).toBe("accepted");
    expect(assessment.reasonCode).toBe("variant.accepted");
    expect(assessment.publishedDigest).toBe(digestOf("norm0"));
    expect(assessment.publishedBytes).toBe(1_400_000);
  });

  test("a seed that produced no image is rejected and stays visible", () => {
    const assessment = assessVariant(variant(1, { generation: { outcome: "failed", error: "GPU_OOM" } }));
    expect(assessment.status).toBe("rejected");
    expect(assessment.reasonCode).toBe("variant.generation.failed");
    expect(assessment.summary).toContain("GPU_OOM");
    expect(assessment.seed).toBe(SEEDS[1]);
  });

  test("a generated but unnormalized variant is unmeasured, not rejected", () => {
    const assessment = assessVariant(variant(0, { normalization: undefined, deterministic: undefined, quorum: undefined }));
    expect(assessment.status).toBe("unmeasured");
    expect(assessment.reasonCode).toBe("variant.normalization.missing");
  });

  test("normalizing bytes other than the generated ones is rejected", () => {
    const assessment = assessVariant(variant(0, { normalization: { digest: digestOf("normx"), bytes: 10, sourceDigest: digestOf("other") } }));
    expect(assessment.status).toBe("rejected");
    expect(assessment.reasonCode).toBe("variant.normalization.mismatch");
  });

  test("a failed byte-level claim rejects the variant and names it", () => {
    const assessment = assessVariant(variant(0, { deterministic: claims({ "png-dimensions-color": "FAIL" }) }));
    expect(assessment.status).toBe("rejected");
    expect(assessment.reasonCode).toBe("variant.claims.failed");
    expect(assessment.failedClaimIds).toEqual(["png-dimensions-color"]);
  });

  test("a recognized caption rejects the variant through the text claim", () => {
    const assessment = assessVariant(variant(0, { deterministic: claims({ "ocr-no-text": "FAIL" }) }));
    expect(assessment.failedClaimIds).toEqual(["ocr-no-text"]);
    expect(assessment.status).toBe("rejected");
  });

  test("a claim the validator could not measure leaves the variant unmeasured", () => {
    const assessment = assessVariant(variant(0, { deterministic: claims({ "ocr-no-text": "VALIDATOR_ERROR" }) }));
    expect(assessment.status).toBe("unmeasured");
    expect(assessment.reasonCode).toBe("variant.claims.unmeasured");
    expect(assessment.unmeasuredClaimIds).toEqual(["ocr-no-text"]);
  });

  test("an inconclusive claim is unmeasured rather than a failure", () => {
    expect(assessVariant(variant(0, { deterministic: claims({ "png-size": "INCONCLUSIVE" }) })).status).toBe("unmeasured");
  });

  test("a missing claim is unmeasured rather than assumed to pass", () => {
    const partial = claims().filter(claim => claim.id !== "png-no-extra-payload");
    const assessment = assessVariant(variant(0, { deterministic: partial }));
    expect(assessment.status).toBe("unmeasured");
    expect(assessment.unmeasuredClaimIds).toEqual(["png-no-extra-payload"]);
  });

  test("no deterministic report at all leaves every claim unmeasured", () => {
    const assessment = assessVariant(variant(0, { deterministic: undefined }));
    expect(assessment.unmeasuredClaimIds).toEqual([...REQUIRED_DETERMINISTIC_CLAIM_IDS]);
  });

  test("byte-level claims are decided before the semantic ones are consulted", () => {
    const assessment = assessVariant(variant(0, { deterministic: claims({ "png-size": "FAIL" }), quorum: undefined }));
    expect(assessment.reasonCode).toBe("variant.claims.failed");
  });

  test("a variant never evaluated semantically is unmeasured and names those claims", () => {
    const assessment = assessVariant(variant(0, { quorum: undefined }));
    expect(assessment.status).toBe("unmeasured");
    expect(assessment.reasonCode).toBe("variant.quorum.missing");
    expect(assessment.unmeasuredClaimIds).toEqual(["semantic-evaluation-1", "semantic-evaluation-2", "semantic-evaluation-3"]);
  });

  test("a denied semantic field rejects the variant", () => {
    const assessment = assessVariant(variant(0, { quorum: scoreSemanticQuorum(evaluations({ oneOakTree: false }), CONFIGURATION) }));
    expect(assessment.status).toBe("rejected");
    expect(assessment.reasonCode).toBe("quorum.passes.below_threshold");
    expect(assessment.failedClaimIds).toHaveLength(3);
  });

  test("an indecisive evaluator leaves the variant unmeasured, never rejected", () => {
    const indecisive = scoreSemanticQuorum(
      [
        { index: 0, outcome: { kind: "fields", fields: ALL_TRUE, raw: "{}" }, measuredAtMs: 1 },
        { index: 1, outcome: { kind: "fields", fields: ALL_TRUE, raw: "{}" }, measuredAtMs: 2 },
        { index: 2, outcome: { kind: "unusable", reasonCode: "evaluation.answer.empty", detail: "nothing" }, measuredAtMs: 3 },
      ],
      CONFIGURATION,
    );
    const assessment = assessVariant(variant(0, { quorum: indecisive }));
    expect(assessment.status).toBe("unmeasured");
    expect(assessment.unmeasuredClaimIds).toEqual(["semantic-evaluation-3"]);
  });
});

describe("selecting within a round", () => {
  test("the first accepted variant in input order is chosen", () => {
    const assessment = assessRound(round());
    expect(assessment.accepted?.index).toBe(0);
    expect(assessment.accepted?.seed).toBe(SEEDS[0]);
    expect(assessment.reasonCode).toBe("round.accepted");
  });

  test("a later variant is chosen only when every earlier one failed", () => {
    const assessment = assessRound(
      round({
        0: { deterministic: claims({ "ocr-no-text": "FAIL" }) },
        1: { generation: { outcome: "failed", error: "GPU_OOM" } },
      }),
    );
    expect(assessment.accepted?.index).toBe(2);
    expect(assessment.accepted?.seed).toBe(SEEDS[2]);
  });

  test("the last seed can be the published one", () => {
    const broken = { deterministic: claims({ "png-size": "FAIL" }) };
    const assessment = assessRound(round({ 0: broken, 1: broken, 2: broken }));
    expect(assessment.accepted?.index).toBe(3);
  });

  test("a later accepted variant never displaces an earlier one", () => {
    const assessment = assessRound(round());
    expect(assessment.variants.filter(entry => entry.status === "accepted")).toHaveLength(4);
    expect(assessment.accepted?.index).toBe(0);
  });

  test("every variant stays visible with its own verdict", () => {
    const assessment = assessRound(
      round({
        0: { generation: { outcome: "failed", error: "GPU_OOM" } },
        1: { deterministic: claims({ "png-dimensions-color": "FAIL" }) },
        2: { deterministic: claims({ "ocr-no-text": "VALIDATOR_ERROR" }) },
      }),
    );
    expect(assessment.variants).toHaveLength(4);
    expect(assessment.variants.map(entry => entry.status)).toEqual(["rejected", "rejected", "unmeasured", "accepted"]);
    expect(assessment.variants.map(entry => entry.seed)).toEqual([...SEEDS]);
  });

  test("a round where every variant was measured and none passed is rejected", () => {
    const broken = { deterministic: claims({ "png-size": "FAIL" }) };
    const assessment = assessRound(round({ 0: broken, 1: broken, 2: broken, 3: broken }));
    expect(assessment.accepted).toBeUndefined();
    expect(assessment.reasonCode).toBe("round.rejected");
  });

  test("a round holding an unmeasured variant is unfinished rather than rejected", () => {
    const broken = { deterministic: claims({ "png-size": "FAIL" }) };
    const assessment = assessRound(round({ 0: broken, 1: broken, 2: broken, 3: { deterministic: claims({ "png-size": "VALIDATOR_ERROR" }) } }));
    expect(assessment.accepted).toBeUndefined();
    expect(assessment.reasonCode).toBe("round.unmeasured");
    expect(assessment.summary).toContain("1 of 4");
  });

  test("a round with the wrong number of variants is refused", () => {
    expect(() => assessRound(round().slice(0, 3))).toThrow(ReferenceImageVariantError);
  });

  test("a round whose slots were reordered is refused rather than sorted", () => {
    const reordered = [...round()].reverse();
    expect(() => assessRound(reordered)).toThrow(/index/);
  });

  test("a round carrying a seed the lock does not record is refused", () => {
    const wrong = round().map((entry, index) => (index === 2 ? { ...entry, seed: 99 } : entry));
    expect(() => assessRound(wrong)).toThrow(/seed 99/);
  });
});

describe("reading a collect map's outcomes", () => {
  function succeeded(label: string): CollectedOutcome {
    return { outcome: "succeeded", value: { digest: digestOf(label), bytes: 1_000, runtime: { torch: "2.12.0" } } };
  }

  test("each slot keeps its input position and its seed", () => {
    const records = variantsFromCollect([succeeded("a"), succeeded("b"), succeeded("c"), succeeded("d")]);
    expect(records.map(record => record.index)).toEqual([0, 1, 2, 3]);
    expect(records.map(record => record.seed)).toEqual([...SEEDS]);
  });

  test("a failed slot is kept rather than dropped, so later seeds keep their positions", () => {
    const records = variantsFromCollect([{ outcome: "failed", error: "GPU_OOM" }, succeeded("b"), succeeded("c"), succeeded("d")]);
    expect(records).toHaveLength(4);
    expect(records[0]?.generation).toEqual({ outcome: "failed", error: "GPU_OOM" });
    expect(records[1]?.seed).toBe(SEEDS[1]);
  });

  test("a failed slot with no message still records why it failed", () => {
    const records = variantsFromCollect([{ outcome: "failed" }, succeeded("b"), succeeded("c"), succeeded("d")]);
    expect(records[0]?.generation).toEqual({ outcome: "failed", error: "MAP_ITEM_FAILED" });
  });

  test("a short or long outcome list is refused", () => {
    expect(() => variantsFromCollect([succeeded("a")])).toThrow(ReferenceImageVariantError);
    expect(() => variantsFromCollect([succeeded("a"), succeeded("b"), succeeded("c"), succeeded("d"), succeeded("e")])).toThrow(/yields 4/);
  });

  test("a slot that claims success and carries no image is refused", () => {
    expect(() => variantsFromCollect([{ outcome: "succeeded" }, succeeded("b"), succeeded("c"), succeeded("d")])).toThrow(/carries no image/);
  });

  test("the generation runtime each variant observed is retained", () => {
    const records = variantsFromCollect([succeeded("a"), succeeded("b"), succeeded("c"), succeeded("d")]);
    const first = records[0]?.generation;
    expect(first?.outcome).toBe("succeeded");
    if (first?.outcome !== "succeeded") throw new Error("unreachable");
    expect(first.runtime).toEqual({ torch: "2.12.0" });
  });
});
