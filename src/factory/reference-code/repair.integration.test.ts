import { describe, expect, test } from "bun:test";
import { referenceCodeV1 } from "@ezcorp/factory-sdk";
import type { FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk";
import { fakeReferenceCodeBroker } from "../../__tests__/helpers/reference-code-broker-fake";
import { referenceCodeProtectedChecks } from "./checks";
import { freezeReferenceCodeCandidate, type ReferenceCodeCandidate } from "./freeze";
import { generateReferenceCodeCandidate } from "./generate";
import { REFERENCE_CODE_ACCEPTED_SLUGIFY, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import {
  referenceCodeRemediation,
  referenceCodeRepairAuthorized,
  REFERENCE_CODE_MAX_CANDIDATE_GENERATIONS,
  REFERENCE_CODE_REMEDIATION_LIMIT,
} from "./remediation";
import { sealReferenceCodeSnapshot, type ReferenceCodeFile } from "./snapshot";

/**
 * Bounded repair, driven through the real generator, the real freeze, and the real checks.
 *
 * The model itself is scripted, because a run has to reach a specific rejection on a specific
 * generation to prove the bound, and a real model cannot be asked to fail in a chosen way. Every
 * other leg is the product's own: the generator applies real tool calls to a real tree, the freeze
 * derives real git identities, and the nine claims run the real Bun and TypeScript toolchain.
 *
 * What it must show: a rejection produces a NEW candidate rather than a retry of the old one, every
 * mandatory claim is measured again on that new candidate, evidence does not carry across a
 * generation, and the third generation is the last one the contract authorizes.
 */

const BASE = "a".repeat(39) + "1";
const MODEL = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
const PROTECTED_TESTS = ["test/slugify.protected.test.ts"];

const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: "b".repeat(39) + "2",
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});

/** Returns the requested case instead of a slug: the golden assertion fails. */
const WRONG_OUTPUT = `/** Turns a title into a URL slug. */
export function slugify(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, "-");
}
`;

/** Correct output, and a credential the scanner must refuse. */
const LEAKY = `const TELEMETRY_KEY = "${["sk", "ant", "api03"].join("-")}-UmVwYWlyRml4dHVyZU5vdEFSZWFsS2V5QUFBQQAA-ZmFrZQAA";
${REFERENCE_CODE_ACCEPTED_SLUGIFY.replace("const words", "void TELEMETRY_KEY;\n  const words")}`;

function write(content: string) {
  return [
    { toolCalls: [{ id: "w", name: "write_file", arguments: { path: "src/slugify.ts", content } }] },
    { toolCalls: [{ id: "f", name: "finish", arguments: { summary: "Updated slugify." } }] },
  ];
}

async function generation(candidateGeneration: number, remediation: string, content: string): Promise<{
  readonly files: readonly ReferenceCodeFile[];
  readonly candidate: ReferenceCodeCandidate;
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  readonly prompt: string;
}> {
  const broker = fakeReferenceCodeBroker(write(content));
  const generated = await generateReferenceCodeCandidate({
    snapshot, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    remediation, candidateGeneration, broker, attemptToken: "repair-attempt", model: MODEL,
  });
  const candidate = freezeReferenceCodeCandidate({
    snapshot, files: generated.files, repositoryId: 1,
    baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
    issue: REFERENCE_CODE_FIXTURE_REQUEST.issue, title: REFERENCE_CODE_FIXTURE_REQUEST.title,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    authoredAtSeconds: 1_760_000_000, candidateGeneration,
  });
  const checks = await referenceCodeProtectedChecks({
    candidate, snapshot, files: generated.files,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    protectedTestPaths: PROTECTED_TESTS,
    workspacePrefix: `ezcorp-w10-repair-${candidateGeneration}-`,
  });
  const prompt = ((broker.contexts[0]!.messages[0]!.content) as Array<{ text: string }>)[0]!.text;
  return { files: generated.files, candidate, claims: checks.report.claims, prompt };
}

function unsatisfied(claims: readonly FactoryValidatorClaimOutcome[]): readonly string[] {
  return claims.filter(claim => claim.verdict !== "PASS").map(claim => claim.id).sort();
}

describe("bounded repair through three candidate generations", () => {
  test("each rejection produces a new tree whose every mandatory claim is measured again", async () => {
    // Generation 0 — wrong output. The declared suite and the fixture tests both refuse it.
    const first = await generation(0, "", WRONG_OUTPUT);
    expect(unsatisfied(first.claims)).toEqual(["declared-tests", "protected-fixtures"]);
    expect(first.prompt).not.toContain("was rejected");
    const acceptanceNode = referenceCodeV1.graph.nodes.find(node => node.id === "acceptance");
    const declaredRepairs = acceptanceNode && "maxRepairs" in acceptanceNode ? acceptanceNode.maxRepairs ?? 0 : 0;
    expect(referenceCodeRepairAuthorized(0, declaredRepairs)).toBe(true);

    // The rejection is sealed into the one input a repair may replace.
    const firstRemediation = referenceCodeRemediation(first.claims);
    expect(firstRemediation.failedClaimIds).toEqual(["declared-tests", "protected-fixtures"]);
    expect(firstRemediation.text.length).toBeLessThanOrEqual(REFERENCE_CODE_REMEDIATION_LIMIT);

    // Generation 1 — correct output, and a leaked credential. A different claim refuses it.
    const second = await generation(1, firstRemediation.text, LEAKY);
    expect(second.prompt).toContain("A previous candidate was rejected");
    expect(second.prompt).toContain("declared-tests");
    expect(unsatisfied(second.claims)).toEqual(["secret-scan"]);
    expect(second.candidate.treeSha).not.toBe(first.candidate.treeSha);
    expect(second.candidate.commitSha).not.toBe(first.candidate.commitSha);
    // Every claim was measured again, not carried over from the generation that was rejected.
    expect(second.claims).toHaveLength(first.claims.length);
    expect(second.claims.every(claim => claim.measuredAtMs >= first.claims[0]!.measuredAtMs)).toBe(true);
    expect(referenceCodeRepairAuthorized(1, 2)).toBe(true);

    // Generation 2 — the accepted candidate. All nine deterministic claims pass.
    const secondRemediation = referenceCodeRemediation(second.claims);
    expect(secondRemediation.failedClaimIds).toEqual(["secret-scan"]);
    const third = await generation(2, secondRemediation.text, REFERENCE_CODE_ACCEPTED_SLUGIFY);
    expect(third.prompt).toContain("secret-scan");
    expect(unsatisfied(third.claims)).toEqual([]);
    expect(third.candidate.treeSha).not.toBe(second.candidate.treeSha);

    // And the third generation is the last one this contract authorizes.
    expect(referenceCodeRepairAuthorized(2, 2)).toBe(false);
    expect(REFERENCE_CODE_MAX_CANDIDATE_GENERATIONS).toBe(3);
  }, 900_000);

  test("the pack's declared bound is exactly three total candidate generations", () => {
    const acceptance = referenceCodeV1.graph.nodes.find(node => node.id === "acceptance");
    expect(acceptance?.kind).toBe("acceptance");
    expect(acceptance && "maxRepairs" in acceptance ? acceptance.maxRepairs : undefined).toBe(2);
    const generator = referenceCodeV1.graph.nodes.find(node => node.id === "generate-private-candidate");
    expect(generator && "repairableInputs" in generator ? generator.repairableInputs : undefined).toEqual(["remediation"]);
    expect(generator && "maxIterations" in generator ? generator.maxIterations : undefined).toBe(12);
    // Two authorized repairs after the first candidate is three candidate generations in total.
    expect([0, 1, 2].map(value => referenceCodeRepairAuthorized(value, 2))).toEqual([true, true, false]);
  });

  test("a declared bound larger than the kernel's ceiling still stops at three", () => {
    expect([0, 1, 2, 3].map(value => referenceCodeRepairAuthorized(value, 99))).toEqual([true, true, false, false]);
  });
});

describe("what a rejection tells the next generation", () => {
  test("reports every unsatisfied claim, not the first one", () => {
    const claims: FactoryValidatorClaimOutcome[] = [
      { id: "build", verdict: "PASS", decisive: true, summary: "ok", reasonCode: "command_exit_zero", evidence: [], measuredAtMs: 1 },
      { id: "declared-tests", verdict: "FAIL", decisive: true, summary: "two assertions failed", reasonCode: "command_exit_nonzero", evidence: [], measuredAtMs: 1 },
      { id: "secret-scan", verdict: "FAIL", decisive: true, summary: "anthropic-api-key at src/a.ts:1", reasonCode: "secret_found", evidence: [], measuredAtMs: 1 },
    ];
    const remediation = referenceCodeRemediation(claims);
    expect(remediation.failedClaimIds).toEqual(["declared-tests", "secret-scan"]);
    expect(remediation.text).toContain("two assertions failed");
    expect(remediation.text).toContain("anthropic-api-key at src/a.ts:1");
    expect(remediation.text).not.toContain("- build");
    expect(remediation.truncated).toBe(false);
  });

  test("separates a claim that failed from a claim that was never measured", () => {
    const claims: FactoryValidatorClaimOutcome[] = [
      { id: "frozen-install", verdict: "FAIL", decisive: true, summary: "lockfile drift", reasonCode: "command_exit_nonzero", evidence: [], measuredAtMs: 1 },
      { id: "typecheck", verdict: "INCONCLUSIVE", decisive: false, summary: "the install did not succeed", reasonCode: "prerequisite_failed", evidence: [], measuredAtMs: 1 },
    ];
    const remediation = referenceCodeRemediation(claims);
    expect(remediation.failedClaimIds).toEqual(["frozen-install"]);
    expect(remediation.unmeasuredClaimIds).toEqual(["typecheck"]);
    expect(remediation.text).toContain("These claims failed:");
    expect(remediation.text).toContain("could not be measured, so nothing is known about them:");
  });

  test("says so when only unmeasured claims remain, and when nothing was reported at all", () => {
    const unmeasuredOnly = referenceCodeRemediation([
      { id: "supervised-review", verdict: "VALIDATOR_ERROR", decisive: false, summary: "the reviewer's provider is not ready", reasonCode: "review_provider_not_ready", evidence: [], measuredAtMs: 1 },
    ]);
    expect(unmeasuredOnly.failedClaimIds).toEqual([]);
    expect(unmeasuredOnly.text).toContain("The protected contract rejected the previous candidate. These claims could not be measured");

    const silent = referenceCodeRemediation([
      { id: "build", verdict: "PASS", decisive: true, summary: "ok", reasonCode: "command_exit_zero", evidence: [], measuredAtMs: 1 },
    ]);
    expect(silent.text).toContain("reported no unsatisfied claim");
    expect(silent.text).toContain("Treat the candidate as unverified");
  });

  test("truncates at the repairable input's declared limit and says it was truncated", () => {
    const claims: FactoryValidatorClaimOutcome[] = Array.from({ length: 40 }, (_, index) => ({
      id: `claim-${index}`, verdict: "FAIL" as const, decisive: true,
      summary: "a very long explanation ".repeat(12), reasonCode: "command_exit_nonzero", evidence: [], measuredAtMs: 1,
    }));
    const remediation = referenceCodeRemediation(claims);
    expect(remediation.truncated).toBe(true);
    expect(remediation.text.length).toBeLessThanOrEqual(REFERENCE_CODE_REMEDIATION_LIMIT);
    expect(remediation.text).toContain("this list was truncated");
  });
});
