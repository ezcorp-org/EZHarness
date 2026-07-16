// Coverage for the global loops kill switch (Loops EZ Mode Phase 2 safety
// primitive): the setting reader + its gates on the schedule daemon's cron
// claim (`tick`) and manual cron-fire (`fireNow`). The event-dispatcher gate
// line is covered by the existing dispatcher suite (it runs the gate on the
// not-engaged path).
//
// A mutable stub for `getSetting` drives the switch state without a DB — the
// gated code paths all return BEFORE any DB work when engaged.

import { test, expect, describe, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

let settingValue: unknown;
let shouldThrow = false;

mock.module("../db/queries/settings", () => ({
  async getSetting() {
    if (shouldThrow) throw new Error("db down");
    return settingValue;
  },
  async getAllSettings() { return {}; },
  async upsertSetting() {},
  async deleteSetting() { return false; },
  async isListingInstalled() { return false; },
}));

const { loopsKillSwitchEngaged, LOOPS_KILL_SWITCH_KEY } = await import(
  "../extensions/loops-kill-switch"
);
const { ScheduleDaemon } = await import("../extensions/schedule-daemon");

beforeEach(() => {
  settingValue = undefined;
  shouldThrow = false;
});

// Leave the stub in its benign default after every test — belt-and-braces so
// the mocked getSetting never reads back an engaged switch if this module's
// mock ever outlives the file (the CI runner isolates per file via
// scripts/test.sh, but the reset is free insurance).
afterEach(() => {
  settingValue = undefined;
  shouldThrow = false;
});

afterAll(() => {
  restoreModuleMocks();
});

describe("loopsKillSwitchEngaged", () => {
  test("stable key name", () => {
    expect(LOOPS_KILL_SWITCH_KEY).toBe("loops:kill_switch");
  });

  test("unset setting → not engaged (default off)", async () => {
    expect(await loopsKillSwitchEngaged()).toBe(false);
  });

  test("setting === true → engaged", async () => {
    settingValue = true;
    expect(await loopsKillSwitchEngaged()).toBe(true);
  });

  test("setting === false → not engaged", async () => {
    settingValue = false;
    expect(await loopsKillSwitchEngaged()).toBe(false);
  });

  test("a non-boolean truthy value does NOT engage (strict === true)", async () => {
    settingValue = "on";
    expect(await loopsKillSwitchEngaged()).toBe(false);
  });

  test("a getSetting error fails OPEN (not engaged — never freeze on a DB blip)", async () => {
    shouldThrow = true;
    expect(await loopsKillSwitchEngaged()).toBe(false);
  });
});

describe("ScheduleDaemon gates on the kill switch", () => {
  test("tick() claims + dispatches nothing while engaged (before any DB work)", async () => {
    settingValue = true;
    const daemon = new ScheduleDaemon({ skipLockfile: true });
    expect(await daemon.tick()).toEqual({ claimed: 0, dispatched: 0 });
  });

  test("fireNow() refuses a manual cron-fire while engaged", async () => {
    settingValue = true;
    const daemon = new ScheduleDaemon({ skipLockfile: true });
    expect(await daemon.fireNow("some-ext", "0 0 * * *")).toEqual({
      ok: false,
      reason: "loops-suspended",
    });
  });
});
