import { describe, expect, test } from "bun:test";
import { type OpenDescriptor, RUNNER_FD_SETTLE_POLLS, runnerFdFailureEvidence, settleRunnerFds } from "./lib/shipping-runtime-resource-accounting";

const BASELINE = 25;

/** A fake /proc/<runner>/fd reader: one count per poll, then the last count forever. */
function fakeReader(counts: number[]): { read: () => Promise<number>; reads: () => number } {
  let reads = 0;
  return { read: async () => counts[Math.min(reads++, counts.length - 1)]!, reads: () => reads };
}

function countingPause(): { pause: () => Promise<void>; pauses: () => number } {
  let pauses = 0;
  return { pause: async () => { pauses++; }, pauses: () => pauses };
}

const descriptor = (fd: string, target: string, kind: OpenDescriptor["class"]): OpenDescriptor => ({ fd, target, class: kind });

describe("R4 runner FD settle", () => {
  test("a late close settles: baseline+1 for three polls, then the baseline", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE + 1, BASELINE + 1, BASELINE]);
    const pause = countingPause();
    // The strict check at base reads once; that first read is above the baseline.
    expect(await fakeReader([BASELINE + 1, BASELINE]).read()).not.toBe(BASELINE);
    const settle = await settleRunnerFds(reader.read, BASELINE, { maxPolls: 10, pause: pause.pause });
    expect(settle).toEqual({ baseline: BASELINE, remaining: BASELINE, polls: 4, maxPolls: 10 });
    expect(reader.reads()).toBe(4);
    expect(pause.pauses()).toBe(3);
  });

  test("an already settled count needs exactly one poll and no pause", async () => {
    const pause = countingPause();
    expect(await settleRunnerFds(fakeReader([BASELINE]).read, BASELINE, { maxPolls: 10, pause: pause.pause })).toEqual({ baseline: BASELINE, remaining: BASELINE, polls: 1, maxPolls: 10 });
    expect(pause.pauses()).toBe(0);
  });

  test("a leak never settles: the bound is a wait, the count above the baseline is returned unchanged", async () => {
    const reader = fakeReader([BASELINE + 1]);
    const pause = countingPause();
    const settle = await settleRunnerFds(reader.read, BASELINE, { maxPolls: 5, pause: pause.pause });
    expect(settle).toEqual({ baseline: BASELINE, remaining: BASELINE + 1, polls: 5, maxPolls: 5 });
    expect(reader.reads()).toBe(5);
    expect(pause.pauses()).toBe(4);
  });

  test("a count below the baseline is not a settle either", async () => {
    const settle = await settleRunnerFds(fakeReader([BASELINE - 1]).read, BASELINE, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.remaining).toBe(BASELINE - 1);
    expect(settle.polls).toBe(3);
  });

  test("oscillation settles only on equality: 26, 24, 26, then 25", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE - 1, BASELINE + 1, BASELINE]);
    const settle = await settleRunnerFds(reader.read, BASELINE, { maxPolls: 10, pause: countingPause().pause });
    expect(settle).toEqual({ baseline: BASELINE, remaining: BASELINE, polls: 4, maxPolls: 10 });
  });

  test("the default bound is 150 polls and it settles a late close", async () => {
    expect(RUNNER_FD_SETTLE_POLLS).toBe(150);
    const settle = await settleRunnerFds(fakeReader([BASELINE + 1, BASELINE]).read, BASELINE, { pause: countingPause().pause });
    expect(settle).toEqual({ baseline: BASELINE, remaining: BASELINE, polls: 2, maxPolls: RUNNER_FD_SETTLE_POLLS });
  });

  test("the default pause waits between polls and the settle still ends on equality", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE]);
    expect(await settleRunnerFds(reader.read, BASELINE, { maxPolls: 2 })).toEqual({ baseline: BASELINE, remaining: BASELINE, polls: 2, maxPolls: 2 });
    expect(reader.reads()).toBe(2);
  });

  test("bound 0 behaves as today: one strict read, no wait", async () => {
    const pause = countingPause();
    const reader = fakeReader([BASELINE + 1, BASELINE]);
    expect(await settleRunnerFds(reader.read, BASELINE, { maxPolls: 0, pause: pause.pause })).toEqual({ baseline: BASELINE, remaining: BASELINE + 1, polls: 1, maxPolls: 0 });
    expect(reader.reads()).toBe(1);
    expect(pause.pauses()).toBe(0);
  });

  test("a negative or fractional bound is refused", async () => {
    for (const maxPolls of [-1, 1.5, Number.NaN]) {
      await expect(settleRunnerFds(fakeReader([BASELINE]).read, BASELINE, { maxPolls, pause: countingPause().pause })).rejects.toThrow("whole number of polls");
    }
  });

  test("a permanent leak fails after the bound with the leaked descriptor's kind named", async () => {
    const baseline = [descriptor("3", "socket:[100]", "socket")];
    const observed = [...baseline, descriptor("4", "socket:[555]", "socket")];
    const settle = await settleRunnerFds(fakeReader([observed.length]).read, baseline.length, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.remaining).not.toBe(settle.baseline);
    expect(settle.polls).toBe(3);
    const evidence = runnerFdFailureEvidence(settle, baseline, observed);
    expect(evidence.extraDescriptors).toEqual([observed[1]!]);
    expect(evidence.extraDescriptorKinds).toEqual({ socket: 1, pipe: 0, anon: 0, path: 0, other: 0 });
  });

  test("the failure receipt names the kind of every descriptor that is not in the baseline snapshot", () => {
    const baseline = [descriptor("0", "/dev/null", "path"), descriptor("3", "socket:[100]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const observed = [...baseline, descriptor("5", "socket:[901]", "socket"), descriptor("6", "anon_inode:[eventfd]", "anon"), descriptor("7", "pipe:[902]", "pipe"), descriptor("8", "/tmp/run/store/lock", "path")];
    const settle = { baseline: 3, remaining: 7, polls: 150, maxPolls: 150 };
    expect(runnerFdFailureEvidence(settle, baseline, observed)).toEqual({
      settle,
      extraDescriptors: observed.slice(3),
      extraDescriptorKinds: { socket: 1, pipe: 1, anon: 1, path: 1, other: 0 },
      missingDescriptors: [],
    });
  });

  test("a reused fd number with a new target counts as extra, and a closed baseline descriptor is reported missing", () => {
    const baseline = [descriptor("3", "socket:[100]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const observed = [descriptor("3", "socket:[777]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const evidence = runnerFdFailureEvidence({ baseline: 2, remaining: 2, polls: 1, maxPolls: 150 }, baseline, observed);
    expect(evidence.extraDescriptors).toEqual([observed[0]!]);
    expect(evidence.extraDescriptorKinds).toEqual({ socket: 1, pipe: 0, anon: 0, path: 0, other: 0 });
    expect(evidence.missingDescriptors).toEqual([baseline[0]!]);
  });
});
