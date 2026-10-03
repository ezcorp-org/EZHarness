import { describe, expect, test } from "bun:test";

import type { FactoryValidatorClaimOutcome, FactoryValidatorVerdict } from "@ezcorp/factory-sdk";

import { referenceImageLock, referenceImageLockDigest } from "./lock.ts";
import {
  REFERENCE_IMAGE_EVIDENCE_NAME,
  ReferenceImagePublicationError,
  referenceImageEvidence,
  referenceImagePublication,
  type ReferenceImagePublicationInput,
  type ReferenceImageRoundRecord,
} from "./publication.ts";
import { scoreSemanticQuorum, type SemanticEvaluation, type SemanticFields } from "./semantic-quorum.ts";
import { assessRound, REQUIRED_DETERMINISTIC_CLAIM_IDS, type VariantRecord } from "./variants.ts";

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

function quorum(fields: Partial<SemanticFields> = {}) {
  const evaluations: SemanticEvaluation[] = [0, 1, 2].map(index => ({
    index,
    outcome: { kind: "fields", fields: { ...ALL_TRUE, ...fields }, raw: "{}" },
    measuredAtMs: 20 + index,
  }));
  return scoreSemanticQuorum(evaluations, CONFIGURATION);
}

function variant(index: number, overrides: Partial<VariantRecord> = {}): VariantRecord {
  const generated = digestOf(`gen${index}`);
  return {
    index,
    seed: SEEDS[index] as number,
    generation: { outcome: "succeeded", digest: generated, bytes: 1_500_000, runtime: { torch: "2.12.0+rocm7.14.1" } },
    normalization: { digest: digestOf(`norm${index}`), bytes: 1_400_000, sourceDigest: generated },
    deterministic: claims(),
    quorum: quorum(),
    ...overrides,
  };
}

function roundRecord(round: number, prompt: string, overrides: Record<number, Partial<VariantRecord>> = {}): ReferenceImageRoundRecord {
  return { round, prompt, assessment: assessRound(SEEDS.map((_, index) => variant(index, overrides[index] ?? {}))) };
}

const FAILING = { deterministic: claims({ "ocr-no-text": "FAIL" as FactoryValidatorVerdict }) };

function input(overrides: Partial<ReferenceImagePublicationInput> = {}): ReferenceImagePublicationInput {
  return {
    materialOperationId: "operation-1",
    outputName: "tree.png",
    rounds: [roundRecord(1, "One green oak tree on a plain white background, no text.")],
    accepted: { objectName: "variant-0", version: 1, digest: digestOf("norm0"), bytes: 1_400_000 },
    evidence: { objectName: "evidence", version: 1, digest: digestOf("ev"), bytes: 4_000 },
    candidate: { objectName: "candidate", version: 1, digest: digestOf("cand"), bytes: 900 },
    ...overrides,
  };
}

describe("the evidence document", () => {
  test("it names the lock, the model revision, and the guest image", () => {
    const evidence = referenceImageEvidence(input());
    expect(evidence.lockDigest).toBe(referenceImageLockDigest());
    expect(evidence.model.revision).toBe(referenceImageLock.model.revision);
    expect(evidence.guestImage).toBe(referenceImageLock.runtime.guestImage);
    expect(evidence.generation.seeds).toEqual([...SEEDS]);
  });

  test("it names the accepted variant by round, seed, position, and bytes", () => {
    const evidence = referenceImageEvidence(input());
    expect(evidence.accepted).toEqual({ round: 1, seed: SEEDS[0] as number, index: 0, digest: digestOf("norm0"), bytes: 1_400_000 });
  });

  test("every variant of every round stays visible, including the failures", () => {
    const rounds = [
      roundRecord(1, "first prompt", { 0: FAILING, 1: FAILING, 2: FAILING, 3: FAILING }),
      roundRecord(2, "revised prompt", { 0: { generation: { outcome: "failed", error: "GPU_OOM" } } }),
    ];
    const evidence = referenceImageEvidence(input({ rounds, accepted: { objectName: "variant-1", version: 1, digest: digestOf("norm1"), bytes: 1_400_000 } }));
    expect(evidence.rounds).toHaveLength(2);
    expect(evidence.rounds[0]?.variants).toHaveLength(4);
    expect(evidence.rounds[0]?.variants.every(entry => entry.status === "rejected")).toBe(true);
    expect(evidence.rounds[0]?.variants[0]?.failedClaimIds).toEqual(["ocr-no-text"]);
    expect(evidence.rounds[1]?.variants[0]?.summary).toContain("GPU_OOM");
    expect(evidence.accepted.seed).toBe(SEEDS[1] as number);
  });

  test("it records the revised prompt the second round used", () => {
    const rounds = [roundRecord(1, "first prompt", { 0: FAILING, 1: FAILING, 2: FAILING, 3: FAILING }), roundRecord(2, "revised prompt")];
    const evidence = referenceImageEvidence(input({ rounds }));
    expect(evidence.rounds.map(entry => entry.prompt)).toEqual(["first prompt", "revised prompt"]);
  });

  test("it states that the three evaluations are not independent", () => {
    expect(referenceImageEvidence(input()).semanticProvenance).toEqual({ model: "claude-haiku-4-5-20251001", independent: false });
  });

  test("no recorded round at all is refused", () => {
    expect(() => referenceImageEvidence(input({ rounds: [] }))).toThrow(ReferenceImagePublicationError);
  });

  test("a final round that accepted nothing is refused", () => {
    const rounds = [roundRecord(1, "p", { 0: FAILING, 1: FAILING, 2: FAILING, 3: FAILING })];
    expect(() => referenceImageEvidence(input({ rounds }))).toThrow(/accepted no variant/);
  });

  test("a second round after an accepted first round is refused", () => {
    const rounds = [roundRecord(1, "first"), roundRecord(2, "second")];
    expect(() => referenceImageEvidence(input({ rounds }))).toThrow(/should never have run/);
  });

  test("publishing bytes other than the accepted ones is refused", () => {
    expect(() => referenceImageEvidence(input({ accepted: { objectName: "variant-0", version: 1, digest: digestOf("other"), bytes: 1_400_000 } }))).toThrow(
      /reference_image_publication_bytes|sealed material holds/,
    );
  });

  test("a byte count that disagrees with the accepted variant is refused", () => {
    expect(() => referenceImageEvidence(input({ accepted: { objectName: "variant-0", version: 1, digest: digestOf("norm0"), bytes: 7 } }))).toThrow(/bytes/);
  });
});

describe("the accepted publication", () => {
  test("it publishes the accepted image and the evidence document, sorted by name", () => {
    const publication = referenceImagePublication(input());
    expect(publication.files.map(file => file.name)).toEqual([REFERENCE_IMAGE_EVIDENCE_NAME, "tree.png"]);
    expect(publication.files.map(file => file.objectName)).toEqual(["evidence", "variant-0"]);
  });

  test("an output name that sorts before the evidence name still yields a sorted list", () => {
    const publication = referenceImagePublication(input({ outputName: "accepted.png" }));
    expect(publication.files.map(file => file.name)).toEqual(["accepted.png", REFERENCE_IMAGE_EVIDENCE_NAME]);
  });

  test("it names the producing operation and the candidate manifest", () => {
    const publication = referenceImagePublication(input());
    expect(publication.materialOperationId).toBe("operation-1");
    expect(publication.candidateObjectName).toBe("candidate");
    expect(publication.candidateVersion).toBe(1);
  });

  test("it satisfies the adapter's own validator", () => {
    expect(publicationKeys(referenceImagePublication(input()))).toEqual([
      "candidateObjectName",
      "candidateVersion",
      "files",
      "materialOperationId",
      "schemaVersion",
    ]);
  });

  test("an output name colliding with the evidence document is refused", () => {
    expect(() => referenceImagePublication(input({ outputName: REFERENCE_IMAGE_EVIDENCE_NAME }))).toThrow(/evidence document uses/);
  });

  test("an empty output name is refused", () => {
    expect(() => referenceImagePublication(input({ outputName: "   " }))).toThrow(ReferenceImagePublicationError);
  });

  test("an empty material operation is refused", () => {
    expect(() => referenceImagePublication(input({ materialOperationId: "" }))).toThrow(ReferenceImagePublicationError);
  });

  test("a version below one is refused by the adapter's validator", () => {
    expect(() => referenceImagePublication(input({ accepted: { objectName: "variant-0", version: 0, digest: digestOf("norm0"), bytes: 1_400_000 } }))).toThrow();
  });

  test("a round that accepted nothing never produces a publication", () => {
    const rounds = [roundRecord(1, "p", { 0: FAILING, 1: FAILING, 2: FAILING, 3: FAILING })];
    expect(() => referenceImagePublication(input({ rounds }))).toThrow(/accepted no variant/);
  });
});

function publicationKeys(value: object): string[] {
  return Object.keys(value).sort();
}
