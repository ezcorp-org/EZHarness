/**
 * Pure bookkeeping for `waitForExtensionBuild` (extension-v4.ts), kept free of
 * Playwright so `src/__tests__/extension-build-clock.test.ts` can drive it.
 *
 * Build time is time the runner holds the operation (`building`,
 * `verifying`). Time in `queued` is not: the real server owns ONE isolated
 * runner and, right after the first administrator becomes active, builds
 * every bundled extension through it (src/extensions/bundled-bootstrap.ts);
 * a candidate build behind that chain is re-queued with a retryable
 * `runner_busy` diagnostic (src/extensions/v4/lifecycle.ts `failure()`), and
 * a fresh build is `queued` with no diagnostics until its first claim. Both
 * count against the spec's shared allowance, never against the build budget,
 * so the clock starts — and restarts — each time the operation leaves `queued`.
 */
import type { LifecycleOperation } from "../../../src/extensions/v4/types";

export interface BuildClock {
  /** When the runner last took the operation; undefined while queued. */
  readonly buildStartedAt?: number;
}

export function nextBuildClock(clock: BuildClock, operation: Pick<LifecycleOperation, "state">, now: number): BuildClock {
  if (operation.state === "queued") return {};
  return { buildStartedAt: clock.buildStartedAt ?? now };
}

/** Milliseconds the runner has held the operation; 0 while queued. */
export function buildElapsedMs(clock: BuildClock, now: number): number {
  return clock.buildStartedAt === undefined ? 0 : now - clock.buildStartedAt;
}
