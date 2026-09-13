/**
 * The e2e build wait must not count time parked behind the busy isolated
 * runner as build time, and must resume counting from zero once the runner
 * takes the operation again. Exercised here because the parked branch only
 * runs in CI when the boot-time bundled builds happen to be in flight.
 */
import { describe, expect, test } from "bun:test";
import { buildElapsedMs, nextBuildClock, parkedBehindBusyRunner } from "../../web/e2e/fixtures/extension-build-clock";

const busy = { code: "runner_busy", message: "The runner is busy; retry after the current build.", retryable: true, stage: "runner" } as const;
const parked = { state: "queued" as const, diagnostics: [busy] };
const fresh = { state: "queued" as const, diagnostics: [] };
const building = { state: "building" as const, diagnostics: [] };

describe("extension build clock", () => {
  test("only a queued operation with a retryable runner_busy diagnostic counts as parked", () => {
    expect(parkedBehindBusyRunner(parked)).toBe(true);
    expect(parkedBehindBusyRunner(fresh)).toBe(false);
    expect(parkedBehindBusyRunner(building)).toBe(false);
    expect(parkedBehindBusyRunner({ state: "queued", diagnostics: [{ ...busy, retryable: false }] })).toBe(false);
    expect(parkedBehindBusyRunner({ state: "building", diagnostics: [busy] })).toBe(false);
  });

  test("the build clock starts when the runner takes the operation and keeps its origin while it runs", () => {
    let clock = nextBuildClock({}, fresh, 1_000);
    expect(buildElapsedMs(clock, 1_000)).toBe(0);
    clock = nextBuildClock(clock, building, 5_000);
    expect(clock.buildStartedAt).toBe(1_000);
    expect(buildElapsedMs(clock, 61_000)).toBe(60_000);
  });

  test("parking resets the clock and a later claim restarts it from zero", () => {
    let clock = nextBuildClock({}, fresh, 1_000);
    clock = nextBuildClock(clock, parked, 2_000);
    expect(clock.buildStartedAt).toBeUndefined();
    expect(buildElapsedMs(clock, 300_000)).toBe(0);
    clock = nextBuildClock(clock, building, 300_000);
    expect(clock.buildStartedAt).toBe(300_000);
    expect(buildElapsedMs(clock, 330_000)).toBe(30_000);
  });
});
