/**
 * The bundled-bootstrap deadline policy (W4H-11): a wait ends on NO PROGRESS, silence under a pending build's lease is
 * expected, the total is only a safety net sized from the measured hosted rate, and the verdict names every build that
 * did not verify. Every clock here is a number the test passes in.
 */
import { describe, expect, test } from "bun:test";
import { buildLimits } from "@ezcorp/extension-runner";
import type { InstallationState } from "../../src/extensions/v4/types";
import {
  BUNDLED_BOOTSTRAP_POLICY,
  type BundledBootstrapBuild,
  BundledBootstrapProgress,
  bundledBootstrapSafetyNetMs,
  describeBundledBootstrapVerdict,
  isPendingBuildState,
  latestBuild,
} from "./bundled-bootstrap-progress";

const AT = Date.parse("2026-10-05T22:45:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const build = (name: string, state: string | null, updatedAtMs: number | null = AT, leaseUntil: number | null = null): BundledBootstrapBuild => ({
  name,
  operationId: state === null ? null : `${name}-build`,
  state,
  updatedAt: updatedAtMs === null ? null : iso(updatedAtMs),
  leaseUntil,
});

describe("the named policy", () => {
  test("the lease term is the lifecycle's default build lease: the runner's build timeout plus 60 s", () => {
    expect(BUNDLED_BOOTSTRAP_POLICY.buildLeaseMs).toBe(buildLimits.timeoutMs + 60_000);
  });

  test("the safety net is every build at the slowest measured step plus one lease plus the stall limit", () => {
    expect(bundledBootstrapSafetyNetMs(28)).toBe(28 * 38_000 + 360_000 + 120_000);
    expect(bundledBootstrapSafetyNetMs(0)).toBe(480_000);
    expect(bundledBootstrapSafetyNetMs(2, { maxObservedStepMs: 10, buildLeaseMs: 5, stallMs: 1 })).toBe(26);
  });

  test("only queued, building and verifying are pending", () => {
    expect(["queued", "building", "verifying"].every(isPendingBuildState)).toBe(true);
    expect([null, "verified", "failed", "cancelled", "active"].some(isPendingBuildState)).toBe(false);
  });
});

describe("BundledBootstrapProgress", () => {
  test("a serial chain that needs longer than 360 s stays alive while each build moves (the hosted 28 at 13.2 s each)", () => {
    const names = Array.from({ length: 28 }, (_, index) => `ext-${index}`);
    const progress = new BundledBootstrapProgress(AT);
    let verdicts = 0;
    for (let step = 0; step <= 28; step += 1) {
      const now = AT + step * 13_200;
      const builds = names.map((name, index) => build(name, index < step ? "verified" : index === step ? "building" : "queued", index <= step ? now : AT));
      for (let poll = 0; poll < 13; poll += 1) if (progress.observe(builds, now + poll * 1_000)) verdicts += 1;
    }
    expect(28 * 13_200).toBeGreaterThan(360_000);
    expect(verdicts).toBe(0);
  });

  test("no state change for the stall limit ends the wait as a stall that names the stuck builds", () => {
    const progress = new BundledBootstrapProgress(AT);
    const builds = [build("scratchpad", "verified", AT - 5_000), build("task-tracking", "building", AT), build("ez-factory", "queued", AT)];
    expect(progress.observe(builds, AT)).toBeNull();
    expect(progress.observe(builds, AT + 119_999)).toBeNull();
    const verdict = progress.observe(builds, AT + 120_000);
    expect(verdict).toEqual({
      reason: "stalled",
      elapsedMs: 120_000,
      stallClockMs: 120_000,
      stallMs: 120_000,
      safetyNetMs: 3 * 38_000 + 360_000 + 120_000,
      lastProgressAt: iso(AT),
      verified: 1,
      builds: 3,
      unverified: [{ name: "task-tracking", state: "building", sinceTransitionMs: 120_000 }, { name: "ez-factory", state: "queued", sinceTransitionMs: 120_000 }],
    });
    expect(describeBundledBootstrapVerdict(verdict!)).toBe(
      `no build changed state for 120.0 s (stall limit 120.0 s); 1 of 3 verified after 120.0 s, last progress at ${iso(AT)}; not verified: task-tracking building for 120.0 s, ez-factory queued for 120.0 s`,
    );
  });

  test("the summary records the total, the stall clock's maximum and the net in force", () => {
    const progress = new BundledBootstrapProgress(AT);
    expect(progress.summary()).toEqual({ elapsedMs: 0, maxStallClockMs: 0, stallMs: 120_000, safetyNetMs: 0, lastProgressAt: iso(AT) });
    progress.observe([build("a", "queued")], AT + 5_000);
    progress.observe([build("a", "queued")], AT + 50_000);
    progress.observe([build("a", "verified", AT + 60_000)], AT + 60_000);
    expect(progress.summary()).toEqual({ elapsedMs: 60_000, maxStallClockMs: 45_000, stallMs: 120_000, safetyNetMs: 38_000 + 360_000 + 120_000, lastProgressAt: iso(AT + 60_000) });
  });

  test("a change resets the stall clock", () => {
    const progress = new BundledBootstrapProgress(AT);
    expect(progress.observe([build("a", "queued")], AT + 100_000)).toBeNull();
    expect(progress.observe([build("a", "building", AT + 110_000)], AT + 110_000)).toBeNull();
    expect(progress.observe([build("a", "building", AT + 110_000)], AT + 229_999)).toBeNull();
    expect(progress.observe([build("a", "building", AT + 110_000)], AT + 230_000)?.reason).toBe("stalled");
  });

  test("silence under a pending build's live lease is expected; the stall clock starts when the lease ends", () => {
    const leaseUntil = AT + 360_000;
    const progress = new BundledBootstrapProgress(AT);
    const builds = [build("orchestration", "building", AT, leaseUntil)];
    expect(progress.observe(builds, AT)).toBeNull();
    expect(progress.observe(builds, AT + 300_000)).toBeNull();
    expect(progress.observe(builds, leaseUntil + 119_999)).toBeNull();
    expect(progress.observe(builds, leaseUntil + 120_000)).toMatchObject({ reason: "stalled", stallClockMs: 120_000, elapsedMs: 480_000 });
  });

  test("a lease on a build that is no longer pending does not hold the wait open", () => {
    const progress = new BundledBootstrapProgress(AT);
    const builds = [build("done", "verified", AT, AT + 3_600_000), build("waiting", "queued", AT)];
    expect(progress.observe(builds, AT)).toBeNull();
    expect(progress.observe(builds, AT + 120_000)).toMatchObject({ reason: "stalled", unverified: [{ name: "waiting", state: "queued" }] });
  });

  test("builds that keep moving past the safety net end the wait as a safety-net verdict", () => {
    const policy = { maxObservedStepMs: 10_000, buildLeaseMs: 15_000, stallMs: 5_000 };
    const progress = new BundledBootstrapProgress(AT, policy);
    let verdict = null;
    let now = AT;
    for (let poll = 0; !verdict; poll += 1) {
      now = AT + poll * 5_000;
      verdict = progress.observe([build("slow", poll % 2 === 0 ? "building" : "verifying", now), build("next", null, null)], now);
    }
    expect(now - AT).toBe(2 * 10_000 + 20_000);
    expect(verdict).toMatchObject({ reason: "safety_net", safetyNetMs: 40_000, verified: 0, builds: 2 });
    expect(describeBundledBootstrapVerdict(verdict)).toBe(
      `the safety net of 40.0 s ran out while builds still progressed; 0 of 2 verified after 40.0 s, last progress at ${iso(now)}; not verified: slow building for 0.0 s, next no build`,
    );
  });

  test("a verdict with every build verified says so", () => {
    const progress = new BundledBootstrapProgress(AT, { maxObservedStepMs: 0, buildLeaseMs: 0, stallMs: 0 });
    const verdict = progress.observe([build("a", "verified")], AT);
    expect(verdict).toMatchObject({ reason: "stalled", verified: 1, builds: 1, unverified: [] });
    expect(describeBundledBootstrapVerdict(verdict!)).toEndWith("not verified: none");
  });
});

describe("latestBuild", () => {
  const operation = (id: string, kind: string, state: string, updatedAt: string, lease?: { holder: string; fence: number; until: number }) =>
    ({ id, kind, state, updatedAt, diagnostics: [], events: [], ...(lease ? { lease } : {}) });

  test("takes the newest build operation of an installation, with its lease", () => {
    const state = {
      operations: {
        first: operation("first", "build", "failed", "2026-10-05T22:00:00.000Z"),
        retry: operation("retry", "build", "building", "2026-10-05T22:01:00.000Z", { holder: "h", fence: 2, until: 42 }),
        older: operation("older", "build", "verified", "2026-10-05T21:59:00.000Z"),
        activate: operation("activate", "activate", "active", "2026-10-05T23:00:00.000Z"),
      },
    } as unknown as InstallationState;
    expect(latestBuild("ext", state)).toEqual({ name: "ext", operationId: "retry", state: "building", updatedAt: "2026-10-05T22:01:00.000Z", leaseUntil: 42 });
  });

  test("an installation without a build operation reads as no build", () => {
    const state = { operations: { activate: operation("activate", "activate", "active", "2026-10-05T23:00:00.000Z") } } as unknown as InstallationState;
    expect(latestBuild("ext", state)).toEqual({ name: "ext", operationId: null, state: null, updatedAt: null, leaseUntil: null });
    const leaseless = { operations: { only: operation("only", "build", "queued", "2026-10-05T23:00:00.000Z") } } as unknown as InstallationState;
    expect(latestBuild("ext", leaseless).leaseUntil).toBeNull();
  });
});
