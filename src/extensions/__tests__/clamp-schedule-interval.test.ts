/**
 * Coverage for the 5-minute interval floor in `clampSchedulePermission`.
 *
 * Regression: the old gate pattern-matched a fixed blocklist
 * (`* * * * *`, `*\/1..4 * * * *`) and let trivially-equivalent
 * minute-resolution crons through. The fix walks actual fire times with
 * the production cron engine and requires every consecutive gap >= 5 min.
 */
import { test, expect, describe } from "bun:test";
import { clampSchedulePermission } from "../clamp-permissions";
import type { ExtensionManifestV2 } from "../types";

type SchedulePerm = NonNullable<ExtensionManifestV2["permissions"]["schedule"]>;

function manifestSchedule(crons: string[]): SchedulePerm {
  return {
    crons,
    maxRunsPerDay: 24,
    maxRunDurationMs: 300_000,
    missedRunPolicy: "fire-once",
    maxRetries: 0,
  } as SchedulePerm;
}

/** A cron survives the gate iff it appears in the clamped grant. */
function survives(cron: string): boolean {
  const out = clampSchedulePermission(undefined, manifestSchedule([cron]));
  return !!out && (out.crons ?? []).includes(cron);
}

describe("schedule interval gate — sub-5-min equivalents are rejected", () => {
  const rejected = [
    "* * * * *", // every minute (old blocklist)
    "*/1 * * * *", // every minute
    "*/2 * * * *",
    "*/3 * * * *",
    "*/4 * * * *",
    "0-59 * * * *", // range form — every minute (old gate MISSED this)
    "0-4 * * * *", // five consecutive minutes
    "1,2,3 * * * *", // list form, 1-min spacing (old gate MISSED this)
    "*/1 * * * *", // step over wildcard == every minute
    "0,59 * * * *", // cross-hour wrap: :59 → next :00 is 1 min
    "0,3 * * * *", // 3-min gap within the hour
  ];
  for (const c of rejected) {
    test(`rejects ${JSON.stringify(c)}`, () => {
      expect(survives(c)).toBe(false);
    });
  }
});

describe("schedule interval gate — >= 5-min schedules pass", () => {
  const allowed = [
    "*/5 * * * *", // exactly 5 minutes — the floor
    "*/15 * * * *",
    "0,5,10 * * * *", // 5-min spacing
    "0 * * * *", // hourly (minute 0)
    "2 * * * *", // hourly at :02 — offset from the gate reference
    "1 0 * * *", // daily at 00:01 — offset minute (regression guard)
    "1-59/5 * * * *", // true 5-min cadence, offset by 1 (regression guard)
    "30 2 * * *", // daily
    "0 0 1 * *", // monthly
    "3 0 1 * *", // monthly, offset minute
    "0 0 1 1 *", // yearly (sparse — must not hang or false-reject)
    // `N/step` with a bare number is a SINGLE value in this engine
    // (not Vixie's N-max/step), so `0/1` is minute=[0] == hourly. The
    // daemon uses the same parser, so the gate correctly treats it safe.
    "0/1 * * * *",
  ];
  for (const c of allowed) {
    test(`allows ${JSON.stringify(c)}`, () => {
      expect(survives(c)).toBe(true);
    });
  }
});

describe("schedule interval gate — mixed list keeps only safe crons", () => {
  test("drops the sub-5-min cron, keeps the safe one", () => {
    const out = clampSchedulePermission(
      undefined,
      manifestSchedule(["0-59 * * * *", "*/15 * * * *"]),
    );
    expect(out?.crons).toEqual(["*/15 * * * *"]);
  });

  test("all-unsafe → schedule grant collapses to undefined", () => {
    const out = clampSchedulePermission(undefined, manifestSchedule(["1,2,3 * * * *"]));
    expect(out).toBeUndefined();
  });
});
