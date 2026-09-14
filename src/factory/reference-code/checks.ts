import {
  FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION,
  type FactoryValidatorClaimOutcome,
  type FactoryValidatorClaimReport,
} from "@ezcorp/factory-sdk";
import { referenceCodeClaimOutcome, referenceCodeStaticClaims, type ReferenceCodeClaimId } from "./static-claims";
import type { ReferenceCodeCandidate } from "./freeze";
import {
  REFERENCE_CODE_ADVISORY_SNAPSHOT,
  type ReferenceCodeAdvisoryFinding,
  type ReferenceCodeAdvisorySnapshot,
  type ReferenceCodeSecretFinding,
} from "./scans";
import type { ReferenceCodeFile, ReferenceCodeSnapshot } from "./snapshot";
import {
  materializeReferenceCodeWorkspace,
  ReferenceCodeProcessRunner,
  ReferenceCodeWorkspaceError,
  type ReferenceCodeCommandResult,
  type ReferenceCodeCommandRunner,
} from "./workspace";

/**
 * The nine deterministic protected claims of `reference.code.v1`.
 *
 * Every claim is measured, and every claim is reported, including the ones that could not be
 * measured. That is the difference between a rejection an operator can repair and a rejection that
 * says "something failed": `assurance.ts` collects the whole failure list into one receipt, and the
 * bounded repair is only as good as the list it is handed.
 *
 * A command that cannot run is never silently a pass and never silently a fail. If the frozen
 * install does not succeed, the build, typecheck, and test claims are INCONCLUSIVE and say so,
 * because nothing about them was actually observed. Per C10 an INCONCLUSIVE required claim does not
 * satisfy the contract, so this is strictly more honest than guessing, not more lenient.
 *
 * The tenth claim, `supervised-review`, is deliberately not here. It is a separate validator in a
 * separate context with no tool or publish grant, and mixing it into this report would let one
 * process both run the candidate's code and judge it.
 */

export { REFERENCE_CODE_DETERMINISTIC_CLAIM_IDS, referenceCodeStaticClaims, type ReferenceCodeClaimId } from "./static-claims";

export const REFERENCE_CODE_CHECK_TIMEOUTS = Object.freeze({
  install: 300_000,
  build: 300_000,
  typecheck: 300_000,
  test: 600_000,
});

export interface ReferenceCodeChecksInput {
  readonly candidate: ReferenceCodeCandidate;
  readonly snapshot: ReferenceCodeSnapshot;
  /** The complete candidate tree. Its digest must equal the frozen candidate's. */
  readonly files: readonly ReferenceCodeFile[];
  readonly allowedPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  /** The fixture-specific protected tests, run on their own so their result is its own claim. */
  readonly protectedTestPaths: readonly string[];
  readonly advisories?: ReferenceCodeAdvisorySnapshot;
  readonly runner?: ReferenceCodeCommandRunner;
  readonly now?: () => number;
  readonly workspacePrefix?: string;
}

export interface ReferenceCodeChecksReport {
  readonly report: FactoryValidatorClaimReport;
  /** Everything a reader needs to reproduce a verdict, kept out of the claim payload. */
  readonly commands: readonly ReferenceCodeCommandResult[];
  readonly advisoryFindings: readonly ReferenceCodeAdvisoryFinding[];
  readonly secretFindings: readonly ReferenceCodeSecretFinding[];
  readonly disallowedPaths: readonly string[];
  readonly changedProtectedPaths: readonly string[];
  readonly verifiedWorkspaceDigest: string | null;
}

/** A command's verdict: exit zero passes, any other exit fails, a timeout is its own reason. */
function commandOutcome(id: ReferenceCodeClaimId, result: ReferenceCodeCommandResult, measuredAtMs: number): FactoryValidatorClaimOutcome {
  if (result.timedOut) {
    return referenceCodeClaimOutcome(id, "INCONCLUSIVE", "command_timed_out", `\`${result.command.join(" ")}\` was killed after ${result.durationMs} ms without reporting a result.`, measuredAtMs);
  }
  if (result.exitCode === 0) {
    return referenceCodeClaimOutcome(id, "PASS", "command_exit_zero", `\`${result.command.join(" ")}\` exited 0 in ${result.durationMs} ms.`, measuredAtMs);
  }
  const tail = result.output.trim().split("\n").slice(-12).join("\n");
  return referenceCodeClaimOutcome(id, "FAIL", "command_exit_nonzero", `\`${result.command.join(" ")}\` exited ${result.exitCode}.\n${tail}`, measuredAtMs);
}

/** Claims that describe a command that never ran, because its prerequisite failed. */
function unmeasured(ids: readonly ReferenceCodeClaimId[], reason: string, measuredAtMs: number): FactoryValidatorClaimOutcome[] {
  return ids.map(id => referenceCodeClaimOutcome(id, "INCONCLUSIVE", "prerequisite_failed", reason, measuredAtMs));
}

/**
 * Runs every deterministic protected claim and reports all nine.
 *
 * Order is chosen so a reader can follow it: the static claims first, because they are about the
 * candidate itself; then the frozen install, because everything after it depends on it; then build,
 * typecheck, the declared suite, and the fixture's own protected tests. The disposable copy is
 * always removed, including when a check throws.
 */
export async function referenceCodeProtectedChecks(input: ReferenceCodeChecksInput): Promise<ReferenceCodeChecksReport> {
  const now = input.now ?? Date.now;
  const advisories = input.advisories ?? REFERENCE_CODE_ADVISORY_SNAPSHOT;
  const runner = input.runner ?? new ReferenceCodeProcessRunner();
  const measuredAtMs = now();
  const statics = referenceCodeStaticClaims({
    changedPaths: input.candidate.changedPaths,
    snapshot: input.snapshot,
    files: input.files,
    allowedPaths: input.allowedPaths,
    protectedPaths: input.protectedPaths,
    advisories,
    measuredAtMs,
  });

  const dynamicIds: readonly ReferenceCodeClaimId[] = ["frozen-install", "build", "typecheck", "declared-tests", "protected-fixtures"];
  const commands: ReferenceCodeCommandResult[] = [];
  let dynamicClaims: FactoryValidatorClaimOutcome[];
  let verifiedWorkspaceDigest: string | null = null;

  let workspace: Awaited<ReturnType<typeof materializeReferenceCodeWorkspace>> | undefined;
  try {
    workspace = await materializeReferenceCodeWorkspace({
      files: input.files,
      expectedDigest: input.candidate.filesDigest,
      protectedPaths: input.protectedPaths,
      prefix: input.workspacePrefix,
    });
  } catch (error) {
    if (!(error instanceof ReferenceCodeWorkspaceError)) throw error;
    const reason = `The disposable validation copy could not be prepared: ${error.code}${error.detail ? ` (${error.detail})` : ""}.`;
    return {
      report: { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: [...statics.claims, ...unmeasured(dynamicIds, reason, now())] },
      commands,
      advisoryFindings: statics.advisoryFindings,
      secretFindings: statics.secretFindings,
      disallowedPaths: statics.disallowedPaths,
      changedProtectedPaths: statics.changedProtectedPaths,
      verifiedWorkspaceDigest: null,
    };
  }

  try {
    verifiedWorkspaceDigest = workspace.verifiedDigest;
    const cwd = workspace.root;
    const install = await runner.run(["bun", "install", "--frozen-lockfile", "--no-progress"], { cwd, timeoutMs: REFERENCE_CODE_CHECK_TIMEOUTS.install });
    commands.push(install);
    const installClaim = commandOutcome("frozen-install", install, now());
    if (installClaim.verdict !== "PASS") {
      const reason = `The frozen dependency installation did not succeed, so nothing downstream of it was measured (\`${install.command.join(" ")}\` exited ${install.exitCode}).`;
      dynamicClaims = [installClaim, ...unmeasured(["build", "typecheck", "declared-tests", "protected-fixtures"], reason, now())];
    } else {
      const build = await runner.run(["bun", "run", "build"], { cwd, timeoutMs: REFERENCE_CODE_CHECK_TIMEOUTS.build });
      const typecheck = await runner.run(["bun", "run", "typecheck"], { cwd, timeoutMs: REFERENCE_CODE_CHECK_TIMEOUTS.typecheck });
      const tests = await runner.run(["bun", "run", "test"], { cwd, timeoutMs: REFERENCE_CODE_CHECK_TIMEOUTS.test });
      const fixtures = await runner.run(["bun", "test", ...input.protectedTestPaths], { cwd, timeoutMs: REFERENCE_CODE_CHECK_TIMEOUTS.test });
      commands.push(build, typecheck, tests, fixtures);
      dynamicClaims = [
        installClaim,
        commandOutcome("build", build, now()),
        commandOutcome("typecheck", typecheck, now()),
        commandOutcome("declared-tests", tests, now()),
        commandOutcome("protected-fixtures", fixtures, now()),
      ];
    }
    // A script that rewrote its own protected assertions invalidates every claim measured after it.
    try { await workspace.assertProtectedUnchanged(); }
    catch (error) {
      if (!(error instanceof ReferenceCodeWorkspaceError)) throw error;
      const reason = `A check command modified a protected asset in the disposable copy (${error.detail ?? "unknown path"}), so no measured result from this run is trustworthy.`;
      dynamicClaims = unmeasured(dynamicIds, reason, now());
    }
  } finally {
    await workspace.dispose();
  }

  return {
    report: { schemaVersion: FACTORY_VALIDATOR_CLAIMS_SCHEMA_VERSION, claims: [...statics.claims, ...dynamicClaims] },
    commands,
    advisoryFindings: statics.advisoryFindings,
    secretFindings: statics.secretFindings,
    disallowedPaths: statics.disallowedPaths,
    changedProtectedPaths: statics.changedProtectedPaths,
    verifiedWorkspaceDigest,
  };
}
