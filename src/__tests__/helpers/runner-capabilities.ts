import type { RunnerCapabilities } from "@ezcorp/extension-contract";

/**
 * What a test runner reports when it stands for a runner that enforces the
 * process policy. The host refuses a non-shell start on a runner without it.
 */
export async function enforcingRunnerCapabilities(): Promise<RunnerCapabilities> {
  return { processSpawnEnforcement: true };
}
