import { FACTORY_LIMITS, type FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk";

/**
 * Turns a rejection into the one input an authorized repair may replace.
 *
 * `generate-private-candidate` declares exactly one repairable input, `remediation`, and the
 * kernel refuses a repair that touches any other binding. So this text is the entire channel
 * between "the contract said no" and "the next candidate is different", and what it contains
 * decides whether the next generation is a repair or a blind retry.
 *
 * It carries every unsatisfied claim, not the first one. A generator told only about the failing
 * test will fix the test and be rejected again for the secret it left in the same file, burning one
 * of the three generations the contract allows on information the rejection already had.
 *
 * Claims that could not be measured are listed separately and plainly. "The typecheck was not run
 * because the frozen install failed" is a different instruction from "the typecheck failed", and a
 * generator that confuses them edits the wrong file.
 */

/** The `remediation` port's declared maximum. A longer text is not a valid repair input. */
export const REFERENCE_CODE_REMEDIATION_LIMIT = 4096;

/** Total candidate generations this contract authorizes, including the first. */
export const REFERENCE_CODE_MAX_CANDIDATE_GENERATIONS = FACTORY_LIMITS.maxCandidateGenerations;

export interface ReferenceCodeRemediation {
  readonly text: string;
  readonly failedClaimIds: readonly string[];
  readonly unmeasuredClaimIds: readonly string[];
  readonly truncated: boolean;
}

function line(claim: FactoryValidatorClaimOutcome): string {
  return `- ${claim.id} (${claim.verdict}, ${claim.reasonCode}): ${claim.summary.replace(/\s+/g, " ").trim()}`;
}

/**
 * Seals the unsatisfied claims into a repair instruction.
 *
 * Only PASS satisfies a required claim, so everything else is reported. The text is truncated at
 * the port's limit rather than silently dropped, and the truncation is stated inside the text so
 * the generator knows it was not told everything.
 */
export function referenceCodeRemediation(claims: readonly FactoryValidatorClaimOutcome[]): ReferenceCodeRemediation {
  const unsatisfied = claims.filter(claim => claim.verdict !== "PASS");
  const failed = unsatisfied.filter(claim => claim.verdict === "FAIL");
  const unmeasured = unsatisfied.filter(claim => claim.verdict !== "FAIL");
  const sections: string[] = [];
  if (failed.length > 0) sections.push(["The protected contract rejected the previous candidate. These claims failed:", ...failed.map(line)].join("\n"));
  if (unmeasured.length > 0) {
    sections.push([
      failed.length > 0 ? "These claims could not be measured, so nothing is known about them:" : "The protected contract rejected the previous candidate. These claims could not be measured, so nothing is known about them:",
      ...unmeasured.map(line),
    ].join("\n"));
  }
  if (sections.length === 0) sections.push("The protected contract rejected the previous candidate, but reported no unsatisfied claim. Treat the candidate as unverified and rebuild it from the request.");
  sections.push("Fix every point above in one new candidate. Do not change a protected asset, and do not write outside the allowed paths.");

  const full = sections.join("\n\n");
  const truncated = full.length > REFERENCE_CODE_REMEDIATION_LIMIT;
  const notice = "\n… this list was truncated; re-read the repository and fix what you can see.";
  return {
    text: truncated ? `${full.slice(0, REFERENCE_CODE_REMEDIATION_LIMIT - notice.length)}${notice}` : full,
    failedClaimIds: failed.map(claim => claim.id),
    unmeasuredClaimIds: unmeasured.map(claim => claim.id),
    truncated,
  };
}

/**
 * Whether another candidate generation is still authorized.
 *
 * `maxRepairs` is what the definition declared and the three-generation ceiling is what the kernel
 * enforces; the smaller of the two governs, so a definition that declares more cannot buy more.
 */
export function referenceCodeRepairAuthorized(candidateGeneration: number, maxRepairs: number): boolean {
  return Math.min(maxRepairs, REFERENCE_CODE_MAX_CANDIDATE_GENERATIONS - 1) - candidateGeneration > 0;
}
