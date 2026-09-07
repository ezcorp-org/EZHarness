export const MINIMUM_DURATION_CYCLES = 10;

export type ResourceRunConfig =
  | { mode: "cycles"; maximumCycles: number }
  | { mode: "duration"; maximumCycles: number; requestedMinimumDurationMs: number };

function positiveInteger(value: string | undefined, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  return parsed;
}

/** The normal suite remains ten bounded cycles. A soak opts into elapsed time
 * and keeps applying real lifecycle work until it reaches that duration. */
export function resourceRunConfig(env: Record<string, string | undefined> = process.env): ResourceRunConfig {
  const duration = env.EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS;
  if (duration === undefined || duration === "") {
    if (env.EZ_RUNTIME_RESOURCE_MAX_CYCLES !== undefined) throw new Error("EZ_RUNTIME_RESOURCE_MAX_CYCLES requires EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS.");
    return { mode: "cycles", maximumCycles: positiveInteger(env.EZ_RUNTIME_RESOURCE_CYCLES ?? "10", "EZ_RUNTIME_RESOURCE_CYCLES", 3, 20) };
  }
  if (env.EZ_RUNTIME_RESOURCE_CYCLES !== undefined) throw new Error("EZ_RUNTIME_RESOURCE_CYCLES cannot be combined with duration soak mode.");
  return {
    mode: "duration",
    requestedMinimumDurationMs: positiveInteger(duration, "EZ_RUNTIME_RESOURCE_MIN_DURATION_SECONDS", 30 * 60, 24 * 60 * 60) * 1_000,
    // A hard cycle ceiling prevents a very fast target from looping forever.
    maximumCycles: positiveInteger(env.EZ_RUNTIME_RESOURCE_MAX_CYCLES ?? "1440", "EZ_RUNTIME_RESOURCE_MAX_CYCLES", MINIMUM_DURATION_CYCLES, 5_000),
  };
}


/** A duration run must reach its wall-clock target AND leave four post-warm
 * samples after the six-cycle cache warm-up. */
export function resourceRunReachedTarget(config: ResourceRunConfig, actualDurationMs: number, completedCycles: number): boolean {
  return config.mode === "duration"
    && actualDurationMs >= config.requestedMinimumDurationMs
    && completedCycles >= MINIMUM_DURATION_CYCLES;
}
