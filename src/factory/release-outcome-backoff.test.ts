import { expect, test } from "bun:test";
import { FACTORY_RELEASE_OUTCOME_BACKOFF_BASE_MS as BASE, FACTORY_RELEASE_OUTCOME_BACKOFF_CAP_MS as CAP, FactoryReleaseOutcomeBackoff } from "./release-outcome-backoff";

test("each try that cannot move a release doubles its wait, up to the cap", () => {
  let now = 0;
  const backoff = new FactoryReleaseOutcomeBackoff(() => now);
  expect(backoff.waiting("a")).toBe(false);
  expect(Array.from({ length: 9 }, () => backoff.defer("a"))).toEqual([BASE, 2 * BASE, 4 * BASE, 8 * BASE, 16 * BASE, 32 * BASE, CAP, CAP, CAP]);
  expect(backoff.waiting("a")).toBe(true);
  now += CAP - 1;
  expect(backoff.waiting("a")).toBe(true);
  now += 1;
  expect(backoff.waiting("a")).toBe(false);
});

test("a release that moves starts from the base again, and a wait over for a whole cap is forgotten", () => {
  let now = 0;
  const backoff = new FactoryReleaseOutcomeBackoff(() => now);
  backoff.defer("moved"); backoff.defer("moved");
  backoff.moved("moved");
  expect(backoff.defer("moved")).toBe(BASE);
  backoff.defer("gone");
  expect(backoff.size).toBe(2);
  now = BASE + CAP;
  // "gone" was never listed again: its wait ended a whole cap ago, so asking about any release forgets it.
  expect(backoff.waiting("other")).toBe(false);
  expect(backoff.size).toBe(0);
});

test("the default clock is the wall clock", () => {
  const backoff = new FactoryReleaseOutcomeBackoff();
  backoff.defer("a");
  expect(backoff.waiting("a")).toBe(true);
});
