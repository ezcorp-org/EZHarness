import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { setReadinessDiagnostic } from "../../readiness";

/** The readiness diagnostic built-in runner staging publishes under `detail.diagnostics` (W4H-26). */
export const REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC = "builtinRunnerPackages";

/** What one boot's staging of the built-in runner packages came to, by package. */
export type ReferenceCodeRunnerStaging =
  | { readonly state: "awaiting-administrator" }
  | { readonly state: "staged"; readonly staged: readonly string[]; readonly failed: readonly { readonly manifestName: string; readonly error: string }[] }
  | { readonly state: "failed"; readonly error: string };

type Stage = (entries: readonly { manifestName: string; files: WorkspaceFiles; entrypoint: string }[]) => Promise<ReferenceCodeRunnerStaging>;

/**
 * Stages the built-in reference-code runner packages at boot (C05 "Install built-in runner
 * packages", W4H-26), only when factories are enabled. With factories off this returns before it
 * loads anything, so a factory-off boot is unchanged. It never throws: the outcome, a failure
 * included, goes to `diagnose`, which the boot publishes in readiness by name, and the rest of the
 * boot's staging and wiring continue.
 */
export async function stageReferenceCodeRunnerPackages(enabled: boolean, stage: Stage, diagnose: (outcome: ReferenceCodeRunnerStaging) => void): Promise<void> {
  if (!enabled) return;
  let outcome: ReferenceCodeRunnerStaging;
  try {
    const { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } = await import("./runner-packages");
    const { REFERENCE_CODE_GUEST_ENTRYPOINT } = await import("./guest");
    const entries = await Promise.all(REFERENCE_CODE_RUNNER_PACKAGES.map(async entry => ({
      manifestName: entry.manifestName, files: await referenceCodeRunnerPackageFiles(entry.manifestName), entrypoint: REFERENCE_CODE_GUEST_ENTRYPOINT,
    })));
    outcome = await stage(entries);
  } catch (error) {
    outcome = { state: "failed", error: String(error) };
  }
  diagnose(outcome);
}

/**
 * The boot's diagnosis of a staging outcome: published in readiness under its name, so a boot with
 * no runners says so on /api/ready, and a whole-staging failure is also reported to the boot's log.
 */
export function referenceCodeRunnerStagingDiagnosis(report: (error: string) => void): (outcome: ReferenceCodeRunnerStaging) => void {
  return (outcome) => {
    setReadinessDiagnostic(REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, outcome);
    if (outcome.state === "failed") report(outcome.error);
  };
}
