/**
 * The e2e build wait must not count time queued — parked behind the busy
 * isolated runner, or simply not yet claimed — as build time, and must resume
 * counting from zero once the runner takes the operation again. Exercised
 * here because the parked branch only runs in CI when the boot-time bundled
 * builds happen to be in flight.
 */
import { describe, expect, test } from "bun:test";
import { buildElapsedMs, nextBuildClock } from "../../web/e2e/fixtures/extension-build-clock";

const queued = { state: "queued" as const };
const building = { state: "building" as const };
const verifying = { state: "verifying" as const };

describe("extension build clock", () => {
  test("a queued operation, claimed or not, accrues no build time", () => {
    const clock = nextBuildClock({}, queued, 1_000);
    expect(clock.buildStartedAt).toBeUndefined();
    expect(buildElapsedMs(clock, 300_000)).toBe(0);
  });

  test("the build clock starts when the runner takes the operation and keeps its origin through verification", () => {
    let clock = nextBuildClock({}, building, 5_000);
    expect(clock.buildStartedAt).toBe(5_000);
    clock = nextBuildClock(clock, verifying, 40_000);
    expect(clock.buildStartedAt).toBe(5_000);
    expect(buildElapsedMs(clock, 65_000)).toBe(60_000);
  });

  test("re-queueing resets the clock and a later claim restarts it from zero", () => {
    let clock = nextBuildClock({}, building, 1_000);
    clock = nextBuildClock(clock, queued, 2_000);
    expect(clock.buildStartedAt).toBeUndefined();
    expect(buildElapsedMs(clock, 300_000)).toBe(0);
    clock = nextBuildClock(clock, building, 300_000);
    expect(clock.buildStartedAt).toBe(300_000);
    expect(buildElapsedMs(clock, 330_000)).toBe(30_000);
  });
});
