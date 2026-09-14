import type { FactoryValidatorClaimOutcome } from "@ezcorp/factory-sdk/types";
import { digestBytes } from "../../extensions/v4/digest";
import {
  referenceCodeAdvisoryFindings,
  referenceCodeBlockingAdvisories,
  referenceCodePathAllowed,
  referenceCodeSecretFindings,
  type ReferenceCodeAdvisoryFinding,
  type ReferenceCodeAdvisorySnapshot,
  type ReferenceCodeSecretFinding,
} from "./scans";
import type { ReferenceCodeFile, ReferenceCodeSnapshot } from "./snapshot";

/**
 * The four protected claims that need only the candidate's own bytes.
 *
 * They live apart from the five that run the repository's scripts for one concrete reason: an
 * isolated validator guest can compute these, and it cannot compute the others without a package
 * manager and a toolchain inside the sandbox. Keeping this module free of a workspace, a
 * subprocess, and the release adapter is what lets the guest ship the product's own validator
 * rather than a second copy written for the sandbox.
 *
 * They are also the claims that still stand when everything else fails. A candidate whose
 * disposable copy could not even be created has still leaked a credential or not, and an operator
 * reading that rejection should be told which.
 */

/** Claim ids the deterministic validator reports, in the order the contract lists them. */
export const REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS = Object.freeze([
  "frozen-install",
  "build",
  "typecheck",
  "declared-tests",
  "protected-fixtures",
  "dependency-advisory",
  "secret-scan",
  "allowed-paths",
  "protected-assets-unchanged",
] as const);

export type ReferenceCodeClaimId = (typeof REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS)[number];

/** The one shape every reference-code claim takes. A verdict is decisive only when it decided. */
export function referenceCodeClaimOutcome(
  id: ReferenceCodeClaimId,
  verdict: FactoryValidatorClaimOutcome["verdict"],
  reasonCode: string,
  summary: string,
  measuredAtMs: number,
): FactoryValidatorClaimOutcome {
  return { id, verdict, decisive: verdict === "PASS" || verdict === "FAIL", summary: summary.slice(0, 2048), reasonCode, evidence: [], measuredAtMs };
}

/**
 * The static claims: what the candidate's bytes say, before anything executes.
 *
 * These three need no workspace and no subprocess, so they are measured even when the disposable
 * copy cannot be made. A candidate that leaked a credential should be told so, not told that a
 * temporary directory could not be created.
 */
export function referenceCodeStaticClaims(input: {
  /** Paths the candidate changed against its snapshot. Passed rather than derived so an
   *  isolated guest can run these claims without carrying the freeze and its git machinery. */
  readonly changedPaths: readonly string[];
  readonly snapshot: ReferenceCodeSnapshot;
  readonly files: readonly ReferenceCodeFile[];
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly advisories: ReferenceCodeAdvisorySnapshot;
  readonly measuredAtMs: number;
}): {
  readonly claims: readonly FactoryValidatorClaimOutcome[];
  readonly advisoryFindings: readonly ReferenceCodeAdvisoryFinding[];
  readonly secretFindings: readonly ReferenceCodeSecretFinding[];
  readonly disallowedPaths: readonly string[];
  readonly changedProtectedPaths: readonly string[];
} {
  const { measuredAtMs } = input;
  const lock = input.files.find(file => file.path === input.snapshot.dependencyLockPath);
  const advisoryFindings = lock ? referenceCodeAdvisoryFindings(lock.content, input.advisories) : [];
  const blocking = referenceCodeBlockingAdvisories(advisoryFindings);
  const secretFindings = referenceCodeSecretFindings(input.files);
  const disallowedPaths = input.changedPaths.filter(path => !referenceCodePathAllowed(path, input.allowedPaths));

  const base = new Map(input.snapshot.files.map(file => [file.path, digestBytes(file.content)]));
  const after = new Map(input.files.map(file => [file.path, digestBytes(file.content)]));
  const changedProtectedPaths = input.protectedPaths.filter(path => base.get(path) !== after.get(path)).sort();

  const advisoryClaim = lock === undefined
    ? referenceCodeClaimOutcome("dependency-advisory", "INCONCLUSIVE", "lock_missing", `The candidate does not contain \`${input.snapshot.dependencyLockPath}\`, so no dependency set could be resolved.`, measuredAtMs)
    : blocking.length === 0
      ? referenceCodeClaimOutcome("dependency-advisory", "PASS", "no_blocking_advisory", `No high or critical advisory in the pinned ${input.advisories.source} snapshot of ${new Date(input.advisories.capturedAtMs).toISOString()} matches the resolved dependencies (${advisoryFindings.length} non-blocking match(es)).`, measuredAtMs)
      : referenceCodeClaimOutcome("dependency-advisory", "FAIL", "blocking_advisory", `Blocking advisories: ${blocking.map(finding => `${finding.advisoryId} (${finding.severity}) ${finding.package}@${finding.version}`).join("; ")}.`, measuredAtMs);

  const secretClaim = secretFindings.length === 0
    ? referenceCodeClaimOutcome("secret-scan", "PASS", "no_secret_finding", `The pinned secret rules matched nothing in ${input.files.length} file(s).`, measuredAtMs)
    : referenceCodeClaimOutcome("secret-scan", "FAIL", "secret_found", `Secret findings: ${secretFindings.map(finding => `${finding.ruleId} at ${finding.path}:${finding.line}`).join("; ")}. The matched text is deliberately not recorded.`, measuredAtMs);

  const pathClaim = disallowedPaths.length === 0
    ? referenceCodeClaimOutcome("allowed-paths", "PASS", "changes_within_allowed_paths", `All ${input.changedPaths.length} changed path(s) sit under ${input.allowedPaths.join(", ")}.`, measuredAtMs)
    : referenceCodeClaimOutcome("allowed-paths", "FAIL", "path_not_allowed", `Changed outside the request's allowed paths (${input.allowedPaths.join(", ")}): ${disallowedPaths.join(", ")}.`, measuredAtMs);

  const protectedClaim = changedProtectedPaths.length === 0
    ? referenceCodeClaimOutcome("protected-assets-unchanged", "PASS", "protected_assets_identical", `All ${input.protectedPaths.length} protected asset(s) are byte-identical to base ${input.snapshot.baseSha}.`, measuredAtMs)
    : referenceCodeClaimOutcome("protected-assets-unchanged", "FAIL", "protected_asset_changed", `Protected asset(s) changed or removed against base ${input.snapshot.baseSha}: ${changedProtectedPaths.join(", ")}.`, measuredAtMs);

  return { claims: [advisoryClaim, secretClaim, pathClaim, protectedClaim], advisoryFindings, secretFindings, disallowedPaths, changedProtectedPaths };
}
