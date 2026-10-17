import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type OpenDescriptor, RUNNER_FD_SETTLE_POLLS, runnerFdFailureEvidence, settleRunnerFds } from "./lib/shipping-runtime-resource-accounting";

const BASELINE = 25;

/** A fake /proc reader with stable identities: one snapshot per poll. */
function fakeReader(counts: number[]): { read: () => Promise<OpenDescriptor[]>; reads: () => number } {
  let reads = 0;
  return { read: async () => descriptorSnapshot(counts[Math.min(reads++, counts.length - 1)]!), reads: () => reads };
}

function countingPause(): { pause: () => Promise<void>; pauses: () => number } {
  let pauses = 0;
  return { pause: async () => { pauses++; }, pauses: () => pauses };
}

const descriptor = (fd: string, target: string, kind: OpenDescriptor["class"]): OpenDescriptor => ({ fd, target, class: kind });
const descriptorSnapshot = (count: number): OpenDescriptor[] => Array.from({ length: count }, (_, index) => descriptor(String(index), `pipe:[${index}]`, "pipe"));
const BASELINE_DESCRIPTORS = descriptorSnapshot(BASELINE);

/** Replay the real consumer's verdict, without starting its production stack. */
async function replayResourceVerdict(select: (line: string) => boolean, after: Record<string, unknown>, baseline: Record<string, unknown>, evidence: { extraDescriptors: OpenDescriptor[]; missingDescriptors: OpenDescriptor[] } = { extraDescriptors: [], missingDescriptors: [] }): Promise<void> {
  const source = readFileSync(new URL("./verify-shipping-runtime-resources.ts", import.meta.url), "utf8");
  const statement = source.split("\n").find(line => line.trimStart().startsWith("if (") && line.includes("failResourceCheck") && select(line));
  if (!statement) throw new Error("Actual resource verdict is absent");
  const bindings = { after, baseline, failResourceCheck: async (_cycle: number, reason: string) => { throw new Error(reason); }, cycle: 10, fdSnapshot: {}, runnerFdFailureEvidence: () => evidence, runnerFdSettle: {}, runnerBaselineDescriptors: [], processFdSnapshot: async () => ({ descriptors: [] }), runnerPid: "recorded-runner", runnerFdEvidence: { ...evidence, missingRequiredDescriptors: evidence.missingDescriptors.filter(item => item.class !== "socket") }, appConnectionsBeforeSse: 1 };
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  await new AsyncFunction(...Object.keys(bindings), statement)(...Object.values(bindings));
}

async function replayRunnerVerdict(baseline: number, remaining: number, evidence: { extraDescriptors: OpenDescriptor[]; missingDescriptors: OpenDescriptor[] }): Promise<void> {
  await replayResourceVerdict(line => line.includes("runnerFds") || line.includes("runnerFdEvidence"), { runnerFds: remaining }, { runnerFds: baseline }, evidence);
}

describe("R4 actual runner resource verdict", () => {
  test("hosted cycle 10 accepts closed baseline sockets without retained descriptors", async () => {
    // Run 38996403897/job117290814557: raw counts 26 -> 23; the separately
    // captured identity delta had no additions and these two closed sockets.
    await expect(replayRunnerVerdict(26, 23, {
      extraDescriptors: [],
      missingDescriptors: [descriptor("26", "socket:[89210]", "socket"), descriptor("28", "socket:[111843]", "socket")],
    })).resolves.toBeUndefined();
  });

  test("a new socket cannot hide behind an unchanged total descriptor count", async () => {
    await expect(replayRunnerVerdict(26, 26, {
      extraDescriptors: [descriptor("26", "socket:[new-leak]", "socket")],
      missingDescriptors: [descriptor("26", "socket:[closed-baseline]", "socket")],
    })).rejects.toThrow();
  });

  test("a new socket cannot hide behind a smaller total descriptor count", async () => {
    await expect(replayRunnerVerdict(26, 23, {
      extraDescriptors: [descriptor("26", "socket:[new-leak]", "socket")],
      missingDescriptors: [descriptor("26", "socket:[closed-baseline]", "socket")],
    })).rejects.toThrow();
  });

  test("missing non-socket baseline handles still fail the actual consumer", async () => {
    for (const missing of [descriptor("3", "anon_inode:[eventfd]", "anon"), descriptor("3", "pipe:[baseline]", "pipe"), descriptor("3", "/tmp/baseline", "path"), descriptor("3", "memfd:baseline", "other")]) {
      await expect(replayRunnerVerdict(26, 23, { extraDescriptors: [], missingDescriptors: [missing] })).rejects.toThrow();
    }
  });

  test("the actual owned-container and established-TCP leak guards remain strict", async () => {
    await expect(replayResourceVerdict(line => line.includes("after.runnerContainers"), { runnerContainers: 1 }, {})).rejects.toThrow("retained 1 owned runner containers");
    await expect(replayResourceVerdict(line => line.includes("after.appEstablishedTcpConnections"), { appEstablishedTcpConnections: 2 }, {})).rejects.toThrow("exceeded its pre-SSE count");
  });

  test("the real snapshot reader rejects a missing or non-Bun process after traversal", async () => {
    const source = readFileSync(new URL("./verify-shipping-runtime-resources.ts", import.meta.url), "utf8");
    const body = source.match(/async function runnerFdSnapshot\([^\n]*\):[^\n]*\{([\s\S]*?)\n\}/)?.[1];
    if (!body) throw new Error("Actual runner snapshot reader is absent");
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const read = new AsyncFunction("pid", "readFile", "processFdSnapshot", body);
    const processExited = new Error("ENOENT: owned process exited");
    await expect(read("recorded", async () => { throw processExited; }, async () => ({ descriptors: [] }))).rejects.toBe(processExited);
    await expect(read("recorded", async () => "python\n", async () => ({ descriptors: [] }))).rejects.toThrow("not the Bun runner process");
    await expect(read("recorded", async () => "bun\n", async () => ({ descriptors: BASELINE_DESCRIPTORS }))).resolves.toBe(BASELINE_DESCRIPTORS);
  });
});

describe("R4 runner FD settle", () => {
  test("a late close settles: baseline+1 for three polls, then the baseline", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE + 1, BASELINE + 1, BASELINE]);
    const pause = countingPause();
    // The strict check at base reads once; that first read is above the baseline.
    expect(await fakeReader([BASELINE + 1, BASELINE]).read()).not.toHaveLength(BASELINE);
    const settle = await settleRunnerFds(reader.read, BASELINE_DESCRIPTORS, { maxPolls: 10, pause: pause.pause });
    expect(settle).toMatchObject({ baseline: BASELINE, remaining: BASELINE, polls: 4, maxPolls: 10 });
    expect(reader.reads()).toBe(4);
    expect(pause.pauses()).toBe(3);
  });

  test("an already settled snapshot needs exactly one poll and no pause", async () => {
    const pause = countingPause();
    expect(await settleRunnerFds(fakeReader([BASELINE]).read, BASELINE_DESCRIPTORS, { maxPolls: 10, pause: pause.pause })).toMatchObject({ baseline: BASELINE, remaining: BASELINE, polls: 1, maxPolls: 10 });
    expect(pause.pauses()).toBe(0);
  });

  test("a leak never settles: the bound is a wait, the count above the baseline is returned unchanged", async () => {
    const reader = fakeReader([BASELINE + 1]);
    const pause = countingPause();
    const settle = await settleRunnerFds(reader.read, BASELINE_DESCRIPTORS, { maxPolls: 5, pause: pause.pause });
    expect(settle).toMatchObject({ baseline: BASELINE, remaining: BASELINE + 1, polls: 5, maxPolls: 5 });
    expect(reader.reads()).toBe(5);
    expect(pause.pauses()).toBe(4);
  });

  test("missing non-socket baseline handles stay fail-closed", async () => {
    const settle = await settleRunnerFds(fakeReader([BASELINE - 1]).read, BASELINE_DESCRIPTORS, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.remaining).toBe(BASELINE - 1);
    expect(settle.polls).toBe(3);
  });

  test("a non-socket count drop does not settle before original identities return", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE - 1, BASELINE + 1, BASELINE]);
    const settle = await settleRunnerFds(reader.read, BASELINE_DESCRIPTORS, { maxPolls: 10, pause: countingPause().pause });
    expect(settle).toMatchObject({ baseline: BASELINE, remaining: BASELINE, polls: 4, maxPolls: 10 });
  });

  test("the default bound is 150 polls and it settles a late close", async () => {
    expect(RUNNER_FD_SETTLE_POLLS).toBe(150);
    const settle = await settleRunnerFds(fakeReader([BASELINE + 1, BASELINE]).read, BASELINE_DESCRIPTORS, { pause: countingPause().pause });
    expect(settle).toMatchObject({ baseline: BASELINE, remaining: BASELINE, polls: 2, maxPolls: RUNNER_FD_SETTLE_POLLS });
  });

  test("the default pause waits between snapshots until the new handle closes", async () => {
    const reader = fakeReader([BASELINE + 1, BASELINE]);
    expect(await settleRunnerFds(reader.read, BASELINE_DESCRIPTORS, { maxPolls: 2 })).toMatchObject({ baseline: BASELINE, remaining: BASELINE, polls: 2, maxPolls: 2 });
    expect(reader.reads()).toBe(2);
  });

  test("bound 0 takes one snapshot without forgiving retained handles", async () => {
    const pause = countingPause();
    const reader = fakeReader([BASELINE + 1, BASELINE]);
    expect(await settleRunnerFds(reader.read, BASELINE_DESCRIPTORS, { maxPolls: 0, pause: pause.pause })).toMatchObject({ baseline: BASELINE, remaining: BASELINE + 1, polls: 1, maxPolls: 0 });
    expect(reader.reads()).toBe(1);
    expect(pause.pauses()).toBe(0);
  });

  test("a negative or fractional bound is refused", async () => {
    for (const maxPolls of [-1, 1.5, Number.NaN]) {
      await expect(settleRunnerFds(fakeReader([BASELINE]).read, BASELINE_DESCRIPTORS, { maxPolls, pause: countingPause().pause })).rejects.toThrow("whole number of polls");
    }
  });

  test("a permanent leak fails after the bound with the leaked descriptor's kind named", async () => {
    const baseline = [descriptor("3", "socket:[100]", "socket")];
    const observed = [...baseline, descriptor("4", "socket:[555]", "socket")];
    const settle = await settleRunnerFds(async () => observed, baseline, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.remaining).not.toBe(settle.baseline);
    expect(settle.polls).toBe(3);
    const evidence = runnerFdFailureEvidence(settle, baseline);
    expect(evidence.extraDescriptors).toEqual([observed[1]!]);
    expect(evidence.extraDescriptorKinds).toEqual({ socket: 1, pipe: 0, anon: 0, path: 0, other: 0 });
  });

  test("the failure receipt names the kind of every descriptor that is not in the baseline snapshot", () => {
    const baseline = [descriptor("0", "/dev/null", "path"), descriptor("3", "socket:[100]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const observed = [...baseline, descriptor("5", "socket:[901]", "socket"), descriptor("6", "anon_inode:[eventfd]", "anon"), descriptor("7", "pipe:[902]", "pipe"), descriptor("8", "/tmp/run/store/lock", "path")];
    const settle = { baseline: 3, remaining: 7, polls: 150, maxPolls: 150, descriptors: observed };
    expect(runnerFdFailureEvidence(settle, baseline)).toEqual({
      settle,
      extraDescriptors: observed.slice(3),
      extraDescriptorKinds: { socket: 1, pipe: 1, anon: 1, path: 1, other: 0 },
      missingDescriptors: [],
      missingRequiredDescriptors: [],
    });
  });

  test("a reused fd number with a new target counts as extra, and a closed baseline descriptor is reported missing", () => {
    const baseline = [descriptor("3", "socket:[100]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const observed = [descriptor("3", "socket:[777]", "socket"), descriptor("4", "pipe:[200]", "pipe")];
    const evidence = runnerFdFailureEvidence({ baseline: 2, remaining: 2, polls: 1, maxPolls: 150, descriptors: observed }, baseline);
    expect(evidence.extraDescriptors).toEqual([observed[0]!]);
    expect(evidence.extraDescriptorKinds).toEqual({ socket: 1, pipe: 0, anon: 0, path: 0, other: 0 });
    expect(evidence.missingDescriptors).toEqual([baseline[0]!]);
  });

  test("no descriptor family can hide a leak behind closed baseline handles", async () => {
    const baseline = [descriptor("3", "socket:[baseline]", "socket"), descriptor("4", "pipe:[baseline]", "pipe")];
    for (const leaked of [descriptor("3", "socket:[leak]", "socket"), descriptor("3", "pipe:[leak]", "pipe"), descriptor("3", "anon_inode:[eventpoll]", "anon"), descriptor("3", "/tmp/leak", "path"), descriptor("3", "memfd:leak", "other")]) {
      const settle = await settleRunnerFds(async () => [leaked], baseline, { maxPolls: 3, pause: countingPause().pause });
      expect(settle.polls).toBe(3);
      expect(settle.remaining).toBe(1);
      expect(runnerFdFailureEvidence(settle, baseline).extraDescriptors).toEqual([leaked]);
    }
  });

  test("closing only baseline sockets is safe and recorded in the same snapshot", async () => {
    const socket = descriptor("3", "socket:[baseline]", "socket");
    const pipe = descriptor("4", "pipe:[baseline]", "pipe");
    const settle = await settleRunnerFds(async () => [pipe], [socket, pipe], { maxPolls: 3, pause: countingPause().pause });
    expect(settle.polls).toBe(1);
    expect(settle.remaining).toBe(1);
    expect(runnerFdFailureEvidence(settle, [socket, pipe]).missingRequiredDescriptors).toEqual([]);
    expect(runnerFdFailureEvidence(settle, [socket, pipe]).missingDescriptors).toEqual([socket]);
  });

  test("same-count replacement, duplicate handles, and changed backing inodes never settle", async () => {
    const first = { ...descriptor("3", "/tmp/file", "path"), device: "8", inode: "1" };
    const baseline = [first, descriptor("4", "socket:[baseline]", "socket")];
    for (const observed of [[first, descriptor("4", "socket:[leak]", "socket")], [first, { ...first, fd: "4" }], [{ ...first, inode: "2" }, baseline[1]!]]) {
      const settle = await settleRunnerFds(async () => observed, baseline, { maxPolls: 3, pause: countingPause().pause });
      expect(settle.polls).toBe(3);
      expect(runnerFdFailureEvidence(settle, baseline).extraDescriptors).toHaveLength(1);
      expect(settle.descriptors).toBe(observed);
    }
  });

  test("ambiguous anonymous handles cannot use a lower count to hide replacement", async () => {
    // Distinct Linux eventfds share readlink target AND stat device/inode.
    // Without their fdinfo identity, losing any baseline instance must fail closed.
    const baseline = [descriptor("3", "anon_inode:[eventfd]", "anon"), descriptor("4", "anon_inode:[eventfd]", "anon")];
    const observed = [descriptor("5", "anon_inode:[eventfd]", "anon")];
    const settle = await settleRunnerFds(async () => observed, baseline, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.polls).toBe(3);
    expect(runnerFdFailureEvidence(settle, baseline).missingDescriptors).toHaveLength(1);
    expect(runnerFdFailureEvidence(settle, baseline).missingRequiredDescriptors).toHaveLength(1);
  });

  test("unchanged identities may move fd numbers, but a missing process cannot settle", async () => {
    const baseline = [descriptor("3", "socket:[baseline]", "socket")];
    const observed = [{ ...baseline[0]!, fd: "8" }];
    const settle = await settleRunnerFds(async () => observed, baseline, { maxPolls: 3, pause: countingPause().pause });
    expect(settle.polls).toBe(1);
    expect(runnerFdFailureEvidence(settle, baseline).extraDescriptors).toEqual([]);
    const gone = new Error("ENOENT: owned runner exited");
    await expect(settleRunnerFds(async () => { throw gone; }, baseline)).rejects.toBe(gone);
  });
});
