import type { WorkspaceFiles } from "@ezcorp/extension-contract";

type Stage = (entries: readonly { manifestName: string; files: WorkspaceFiles; entrypoint: string }[]) => Promise<void>;

/**
 * Stages the built-in reference-code runner packages at boot (C05 "Install built-in runner
 * packages", W4H-26), only when factories are enabled. With factories off this returns before it
 * loads anything, so a factory-off boot is unchanged.
 */
export async function stageReferenceCodeRunnerPackages(enabled: boolean, stage: Stage): Promise<void> {
  if (!enabled) return;
  const { REFERENCE_CODE_RUNNER_PACKAGES, referenceCodeRunnerPackageFiles } = await import("./runner-packages");
  const { REFERENCE_CODE_GUEST_ENTRYPOINT } = await import("./guest");
  const entries = await Promise.all(REFERENCE_CODE_RUNNER_PACKAGES.map(async entry => ({
    manifestName: entry.manifestName, files: await referenceCodeRunnerPackageFiles(entry.manifestName), entrypoint: REFERENCE_CODE_GUEST_ENTRYPOINT,
  })));
  await stage(entries);
}
