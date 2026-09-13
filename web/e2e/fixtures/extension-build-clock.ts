/**
 * Pure bookkeeping for `waitForExtensionBuild` (extension-v4.ts), kept free of
 * Playwright so `src/__tests__/extension-build-clock.test.ts` can drive it.
 *
 * The real server owns ONE isolated runner and, right after the first
 * administrator becomes active, builds every bundled extension through it
 * (src/extensions/bundled-bootstrap.ts). A candidate build queued behind that
 * chain is parked as `queued` with a retryable `runner_busy` diagnostic and
 * re-claimed on a bounded backoff (src/extensions/v4/lifecycle.ts
 * `failure()` / `runnerBusyRetryMs`). Parking is not build time, so the build
 * clock starts — and restarts — each time the operation leaves that state.
 */
import type { LifecycleOperation } from "../../../src/extensions/v4/types";

export interface BuildClock {
  /** When the runner last took the operation; undefined while parked. */
  readonly buildStartedAt?: number;
}

/** Mirrors `retryableBusy` in src/extensions/v4/lifecycle.ts. */
export function parkedBehindBusyRunner(operation: Pick<LifecycleOperation, "state" | "diagnostics">): boolean {
  return operation.state === "queued" && operation.diagnostics.some((diagnostic) => diagnostic.code === "runner_busy" && diagnostic.retryable === true);
}

export function nextBuildClock(clock: BuildClock, operation: Pick<LifecycleOperation, "state" | "diagnostics">, now: number): BuildClock {
  if (parkedBehindBusyRunner(operation)) return {};
  return { buildStartedAt: clock.buildStartedAt ?? now };
}

/** Milliseconds the runner has held the operation; 0 while parked. */
export function buildElapsedMs(clock: BuildClock, now: number): number {
  return clock.buildStartedAt === undefined ? 0 : now - clock.buildStartedAt;
}
