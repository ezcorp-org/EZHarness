/**
 * The one deadline policy for every observer of the bundled bootstrap: the production proofs
 * (scripts/lib/shipping-bootstrap-state.ts) and the real-server e2e setups
 * (web/e2e/fixtures/bundled-bootstrap.ts). Pure: no I/O, no clock of its own.
 *
 * The server builds the bundled extensions ONE AT A TIME through its single isolated runner (by
 * design: the runner's build limit is 1 and the bootstrap chains its builds). The time the chain
 * needs therefore grows with the number of builds and the speed of the host, and a fixed total
 * wall clock fails a healthy chain on a slower host (hosted run 37383355593: 27 of 28 verified at
 * a flat 360 s, the 28th building). A wait ends on NO PROGRESS instead: no build changed state for
 * `stallMs`, counted from the later of the last change and the latest lease of a pending build. A
 * lease is the lifecycle's own promise that its holder finishes the build or gives it back by
 * `until`, so silence under a lease is expected (after a restart the delivery proof waits a whole
 * lease out). The total is only a safety net, sized from the measured hosted 4-CPU rate.
 */
import type { InstallationState, LifecycleOperation } from "../../src/extensions/v4/types";

export type BundledBootstrapPolicy = {
  /** The slowest single build step measured on the hosted 4-CPU runner. */
  readonly maxObservedStepMs: number;
  /** The lifecycle's default build lease (src/extensions/v4/lifecycle.ts: the runner's build timeout plus 60 s). */
  readonly buildLeaseMs: number;
  /** No state change and no pending lease for this long is a stall. */
  readonly stallMs: number;
};

export const BUNDLED_BOOTSTRAP_POLICY: BundledBootstrapPolicy = Object.freeze({
  // Hosted run 37383355593 (4 CPUs), 54 serial builds: mean step 13.1 s and 13.2 s, slowest 37.6 s.
  maxObservedStepMs: 38_000,
  // packages/@ezcorp/extension-runner buildLimits.timeoutMs (300 s) + 60 s; bundled-bootstrap-progress.test.ts ties the two.
  buildLeaseMs: 360_000,
  // About three slowest steps: a gap between two builds longer than this has no explanation but a stall.
  stallMs: 120_000,
});

/** Safety net for the whole chain: every build at the slowest measured step, plus one lease waited out, plus the stall
 * limit, so a build stuck under its lease always ends as a named stall before the net. */
export function bundledBootstrapSafetyNetMs(builds: number, policy: BundledBootstrapPolicy = BUNDLED_BOOTSTRAP_POLICY): number {
  return builds * policy.maxObservedStepMs + policy.buildLeaseMs + policy.stallMs;
}

/** One bundled installation's build as an observer sees it; `state` is null before its build operation exists. */
export type BundledBootstrapBuild = {
  name: string;
  operationId: string | null;
  state: string | null;
  updatedAt: string | null;
  leaseUntil: number | null;
};

/** The installation's newest build operation (a retried bundled build gets a new operation). */
export function latestBuild(name: string, state: InstallationState): BundledBootstrapBuild {
  const build = Object.values(state.operations)
    .filter(({ kind }) => kind === "build")
    .reduce<LifecycleOperation | undefined>((latest, operation) => (!latest || operation.updatedAt > latest.updatedAt ? operation : latest), undefined);
  return { name, operationId: build?.id ?? null, state: build?.state ?? null, updatedAt: build?.updatedAt ?? null, leaseUntil: build?.lease?.until ?? null };
}

export type BundledBootstrapUnverifiedBuild = { name: string; state: string | null; sinceTransitionMs: number | null };

export type BundledBootstrapVerdict = {
  reason: "stalled" | "safety_net";
  elapsedMs: number;
  stallClockMs: number;
  stallMs: number;
  safetyNetMs: number;
  lastProgressAt: string;
  verified: number;
  builds: number;
  unverified: BundledBootstrapUnverifiedBuild[];
};

const PENDING_BUILD = new Set(["queued", "building", "verifying"]);

export function isPendingBuildState(state: string | null): boolean {
  return state !== null && PENDING_BUILD.has(state);
}

/** Tracks progress across polls. `observe` returns a verdict once the wait must end, else null. The safety net
 * follows the number of builds observed, so an observer that learns the count late (the e2e setups) needs no guess. */
export class BundledBootstrapProgress {
  private fingerprint: string | null = null;
  private lastProgressMs: number;
  private latestLeaseUntilMs = 0;

  constructor(
    readonly startedAtMs: number,
    readonly policy: BundledBootstrapPolicy = BUNDLED_BOOTSTRAP_POLICY,
  ) {
    this.lastProgressMs = startedAtMs;
  }

  observe(builds: readonly BundledBootstrapBuild[], nowMs: number): BundledBootstrapVerdict | null {
    const fingerprint = JSON.stringify(builds.map(({ name, operationId, state, updatedAt }) => [name, operationId, state, updatedAt]));
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.lastProgressMs = nowMs;
    }
    this.latestLeaseUntilMs = Math.max(0, ...builds.filter(({ state }) => isPendingBuildState(state)).map(({ leaseUntil }) => leaseUntil ?? 0));
    const elapsedMs = nowMs - this.startedAtMs;
    const safetyNetMs = bundledBootstrapSafetyNetMs(builds.length, this.policy);
    const stallClockMs = Math.max(0, nowMs - Math.max(this.lastProgressMs, this.latestLeaseUntilMs));
    const reason = stallClockMs >= this.policy.stallMs ? "stalled" : elapsedMs >= safetyNetMs ? "safety_net" : null;
    if (!reason) return null;
    const unverified = builds.filter(({ state }) => state !== "verified").map(({ name, state, updatedAt }) => ({
      name,
      state,
      sinceTransitionMs: updatedAt === null ? null : nowMs - Date.parse(updatedAt),
    }));
    return {
      reason,
      elapsedMs,
      stallClockMs,
      stallMs: this.policy.stallMs,
      safetyNetMs,
      lastProgressAt: new Date(this.lastProgressMs).toISOString(),
      verified: builds.length - unverified.length,
      builds: builds.length,
      unverified,
    };
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** One line that names why the wait ended and every build that did not verify. */
export function describeBundledBootstrapVerdict(verdict: BundledBootstrapVerdict): string {
  const cause = verdict.reason === "stalled"
    ? `no build changed state for ${seconds(verdict.stallClockMs)} (stall limit ${seconds(verdict.stallMs)})`
    : `the safety net of ${seconds(verdict.safetyNetMs)} ran out while builds still progressed`;
  const unverified = verdict.unverified.map(({ name, state, sinceTransitionMs }) =>
    `${name} ${state ?? "no build"}${sinceTransitionMs === null ? "" : ` for ${seconds(sinceTransitionMs)}`}`);
  return `${cause}; ${verdict.verified} of ${verdict.builds} verified after ${seconds(verdict.elapsedMs)}, last progress at ${verdict.lastProgressAt}; not verified: ${unverified.join(", ") || "none"}`;
}
