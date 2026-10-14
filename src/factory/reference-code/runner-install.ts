import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { setReadinessDiagnostic } from "../../readiness";

/** The readiness diagnostic built-in runner staging publishes under `detail.diagnostics` (W4H-26). */
export const REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC = "builtinRunnerPackages";

/**
 * The fixed reasons a staging failure is published under (W4H-26 N5). /api/ready is a probe route, so
 * a failure leaves the process as a stable code, one of these reasons and its fixed text; the raw
 * error, which can name paths and internal modules, stays in the server log.
 */
export const REFERENCE_CODE_RUNNER_STAGE_REASONS = Object.freeze({
  source_missing: "The runner package source could not be read from the installed product.",
  invalid_source: "The runner package source is not valid workspace data.",
  runner_unconfigured: "No extension runner is configured to build the runner package.",
  lifecycle_refused: "The extension lifecycle refused to stage the runner package.",
  owner_inactive: "The runner package installation is uninstalled or its owner is inactive; a person must review it.",
  unexpected: "The runner package could not be staged; the server log has the cause.",
});
export type ReferenceCodeRunnerStageReason = keyof typeof REFERENCE_CODE_RUNNER_STAGE_REASONS;

/** One staging failure as it is published: never the raw error. */
export interface ReferenceCodeRunnerStageFailure {
  readonly code: "factory_builtin_runner_stage_failed";
  readonly reason: ReferenceCodeRunnerStageReason;
  readonly message: string;
}

/** The marker a stager passes for an installation it must leave to a person. */
export const REFERENCE_CODE_RUNNER_OWNER_INACTIVE = Symbol("reference-code-runner-owner-inactive");

/** The fixed reason for one staging error. */
export function referenceCodeRunnerStageFailure(error: unknown): ReferenceCodeRunnerStageFailure {
  const reason: ReferenceCodeRunnerStageReason = error === REFERENCE_CODE_RUNNER_OWNER_INACTIVE ? "owner_inactive"
    : !(error instanceof Error) ? "unexpected"
    : (error as { code?: unknown }).code === "ENOENT" || error.message.startsWith("ENOENT") ? "source_missing"
    : error.name === "ContractError" ? "invalid_source"
    : error.name === "LifecycleError" ? ((error as { code?: unknown }).code === "runner_unconfigured" ? "runner_unconfigured" : "lifecycle_refused")
    : "unexpected";
  return { code: "factory_builtin_runner_stage_failed", reason, message: REFERENCE_CODE_RUNNER_STAGE_REASONS[reason] };
}

/** What one boot's staging of the built-in runner packages came to, by package, safe to publish. */
export type ReferenceCodeRunnerStaging =
  | { readonly state: "awaiting-administrator" }
  | { readonly state: "staged"; readonly staged: readonly string[]; readonly failed: readonly ({ readonly manifestName: string } & ReferenceCodeRunnerStageFailure)[] }
  | ({ readonly state: "failed" } & ReferenceCodeRunnerStageFailure);

type Stage = (entries: readonly { manifestName: string; files: WorkspaceFiles; entrypoint: string }[]) => Promise<ReferenceCodeRunnerStaging>;

/**
 * Stages the built-in reference-code runner packages at boot (C05 "Install built-in runner
 * packages", W4H-26), only when factories are enabled. With factories off this returns before it
 * loads anything, so a factory-off boot is unchanged. It never throws: the outcome, a failure
 * included, goes to `diagnose` (with the raw error for the log), which the boot publishes in
 * readiness by code and fixed reason, and the rest of the boot's staging and wiring continue.
 */
export async function stageReferenceCodeRunnerPackages(enabled: boolean, stage: Stage, diagnose: (outcome: ReferenceCodeRunnerStaging, raw?: unknown) => void): Promise<void> {
  if (!enabled) return;
  let outcome: ReferenceCodeRunnerStaging;
  let raw: unknown;
  try {
    const { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } = await import("./runner-packages");
    const { REFERENCE_CODE_GUEST_ENTRYPOINT } = await import("./guest");
    const entries = await Promise.all(REFERENCE_CODE_RUNNER_PACKAGES.map(async entry => ({
      manifestName: entry.manifestName, files: await referenceCodeRunnerPackageFiles(entry.manifestName), entrypoint: REFERENCE_CODE_GUEST_ENTRYPOINT,
    })));
    outcome = await stage(entries);
  } catch (error) {
    raw = error;
    outcome = { state: "failed", ...referenceCodeRunnerStageFailure(error) };
  }
  diagnose(outcome, raw);
}

/**
 * The boot's diagnosis of a staging outcome: published in readiness under its name, so a boot with
 * no runners says so on /api/ready, and a whole-staging failure is also reported to the boot's log.
 */
export function referenceCodeRunnerStagingDiagnosis(report: (error: string) => void): (outcome: ReferenceCodeRunnerStaging, raw?: unknown) => void {
  return (outcome, raw) => {
    setReadinessDiagnostic(REFERENCE_CODE_RUNNER_STAGING_DIAGNOSTIC, outcome);
    // The raw error goes to the server log only.
    if (outcome.state === "failed") report(String(raw));
  };
}
