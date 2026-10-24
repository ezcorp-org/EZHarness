import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxPresetDigest } from "@ezcorp/extension-contract";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { exerciseIncusControlledLoads, INCUS_LOAD_GUEST_SCRIPT, type IncusLoadHealth,
  type IncusHighLoadBudget, type IncusLoadProbeDependencies } from "./incus-live-load-probes";

const primary = { sandboxId: "primary", operationId: "primary-create" };
const small = { ...INCUS_PRESETS[0]!, limits: { ...INCUS_PRESETS[0]!.limits,
  memoryBytes: 128 * 1024 ** 2, cpuMillis: 500, pids: 32, diskBytes: 32 * 1024 ** 2,
} };
const health: IncusLoadHealth = {
  hostId: "xeon", hostAvailableBytes: 8 * 1024 ** 3, hostMemoryPressurePercent: 1,
  hostCpuPressurePercent: 1, hostDiskFreeBytes: 8 * 1024 ** 3,
  hostAvailablePids: 10_000,
  hostOomKills: 0, neighborSandboxId: "neighbor", neighborBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  neighborHeartbeat: true,
};

function probe(overrides: Partial<IncusLoadProbeDependencies> = {}) {
  const calls: string[] = [];
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async (handle, argv, timeoutMs) => {
      expect(handle).toEqual(primary);
      expect(argv.slice(0, 2)).toEqual(["python3", "-c"]);
      expect(timeoutMs).toBe(10_000);
      const compiled = Bun.spawnSync({ cmd: ["python3", "-c",
        "import ast,sys; tree=ast.parse(sys.argv[1]); "
        + "inner=next(n.value.value for n in ast.walk(tree) if isinstance(n,ast.Assign) "
        + "and any(isinstance(t,ast.Name) and t.id=='script' for t in n.targets)); ast.parse(inner)",
      argv[2]!] });
      expect(compiled.exitCode).toBe(0);
      const resource = argv[3]!;
      calls.push(resource);
      const attempted = Number(argv[4]);
      const observedLimit = resource === "memory" ? small.limits.memoryBytes
        : resource === "pids" ? small.limits.pids : small.limits.cpuMillis;
      const result = { exitCode: 0, stderr: "", stdout: JSON.stringify({
        attempted, observedLimit: resource === "disk" ? 0 : observedLimit,
        peak: resource === "disk" ? 28 : 1, limitEvents: resource === "disk" ? 0 : 1,
        childExit: resource === "memory" ? -9 : resource === "disk" ? 28 : 0,
        cleanupComplete: true,
      }) };
      return { wait: async () => result, cancel: async () => {} };
    },
    sampleHealth: async () => health,
    readRootQuota: async handle => ({ sandboxId: handle.sandboxId, bytes: small.limits.diskBytes }),
    verifyCleanup: async () => ({ filesAbsent: true, processesAbsent: true }),
    ...overrides,
  };
  return { calls, run: () => exerciseIncusControlledLoads(primary, small, deps) };
}

test("returns raw measured load, host, and neighbor evidence for each resource", async () => {
  const example = probe();
  const result = await example.run();
  expect(example.calls).toEqual(["cpu", "memory", "pids", "disk"]);
  expect(result.facts).toHaveLength(4);
  expect(result.facts.every(item => item.attempted > item.observedLimit
    && item.contained && item.hostHealthy && item.neighborHealthy)).toBe(true);
  expect(result.samples).toHaveLength(9);
  expect(result.readouts.map(item => item.resource)).toEqual(["cpu", "memory", "pids", "disk"]);
  expect(result.readouts[3]?.observedLimit).toBe(small.limits.diskBytes);
});

test("published preset is refused before any resource load", async () => {
  let calls = 0;
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async () => { calls++; throw new Error("must not load"); },
    sampleHealth: async () => { calls++; return health; },
    readRootQuota: async () => { calls++; throw new Error("must not read"); },
    verifyCleanup: async () => { calls++; throw new Error("must not verify"); },
  };
  await expect(exerciseIncusControlledLoads(primary, INCUS_PRESETS[0]!, deps))
    .rejects.toThrow("operator approval");
  expect(calls).toBe(0);
});

test("missing independent neighbor and host pressure stop the probe", async () => {
  let guestCalls = 0;
  for (const bad of [
    { ...health, neighborSandboxId: primary.sandboxId },
    { ...health, hostAvailableBytes: 1 },
    { ...health, hostMemoryPressurePercent: 21 },
  ]) {
    await expect(probe({ sampleHealth: async () => bad,
      startGuestLoad: async () => { guestCalls++; throw new Error("must not run"); } }).run())
      .rejects.toThrow("baseline is unhealthy");
  }
  expect(guestCalls).toBe(0);
});

test("guest load cannot pass from configured limit without a measured hit", async () => {
  const example = probe({ startGuestLoad: async (_handle, argv) => ({
    wait: async () => ({ exitCode: 0, stderr: "",
      stdout: JSON.stringify({ attempted: Number(argv[4]), observedLimit: small.limits.cpuMillis,
        peak: 1, limitEvents: 0, childExit: 0, cleanupComplete: true }) }),
    cancel: async () => {},
  }) });
  await expect(example.run()).rejects.toThrow("cpu containment was not observed");
});

test("host OOM, neighbor restart, and wrong root quota identity fail closed", async () => {
  for (const after of [{ ...health, hostOomKills: 1 },
    { ...health, neighborBootId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }]) {
    let count = 0;
    await expect(probe({ sampleHealth: async () => ++count === 1 ? health : after }).run())
      .rejects.toThrow("affected host or neighbor health");
  }
  await expect(probe({ readRootQuota: async () => ({ sandboxId: "other", bytes: small.limits.diskBytes }) }).run())
    .rejects.toThrow("disk evidence is incomplete");
});

const highScope = { installationId: "installation", releaseId: "release", connectionId: "connection" };

async function highProbe(overrides: Partial<IncusLoadProbeDependencies> = {},
  approvalOverride: Partial<IncusHighLoadBudget> = {}) {
  const preset = INCUS_PRESETS[0]!;
  const binding = { ...highScope, presetId: preset.id,
    presetDigest: await sandboxPresetDigest(preset), sandboxId: primary.sandboxId };
  const limits = { memory: preset.limits.memoryBytes, cpu: preset.limits.cpuMillis,
    pids: preset.limits.pids, disk: preset.limits.diskBytes };
  const budget: IncusHighLoadBudget = { approvalId: "reviewed-1234", approvedBy: "operator",
    expiresAt: "2026-09-23T23:00:00.000Z", binding, expectedLimits: limits,
    maxAttempted: { memory: limits.memory + 1024 ** 2, cpu: limits.cpu + 1_000,
      pids: limits.pids + 1, disk: limits.disk + 1024 ** 2 }, maxDeadlineMs: 120_000,
    ...approvalOverride };
  const calls: string[] = [];
  const highHealth = { ...health, hostAvailableBytes: 48 * 1024 ** 3,
    hostDiskFreeBytes: 80 * 1024 ** 3 };
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async (_handle, argv, timeoutMs) => {
      const resource = argv[3]!;
      calls.push(resource);
      expect(timeoutMs).toBe(120_000);
      expect(argv[5]).toBe("115");
      const result = { exitCode: 0, stderr: "", stdout: JSON.stringify({ attempted: Number(argv[4]),
        observedLimit: resource === "disk" ? 0 : limits[resource as keyof typeof limits],
        peak: resource === "disk" ? 28 : 1,
        limitEvents: resource === "disk" ? 0 : 1,
        childExit: resource === "memory" ? -9 : resource === "disk" ? 28 : 0,
        cleanupComplete: true }) };
      return { wait: async () => result, cancel: async () => {} };
    },
    sampleHealth: async () => highHealth,
    readRootQuota: async () => ({ sandboxId: primary.sandboxId, bytes: limits.disk }),
    verifyCleanup: async () => ({ filesAbsent: true, processesAbsent: true }),
    resolveApprovedBudget: async () => budget,
    ...overrides,
  };
  return { calls, run: () => exerciseIncusControlledLoads(primary, preset, deps,
    { scope: highScope, now: () => Date.parse("2026-09-23T22:00:00.000Z") }) };
}

test("high-load mode requires host-owned approval and exact fixture binding", async () => {
  const absent = await highProbe({ resolveApprovedBudget: async () => null });
  await expect(absent.run()).rejects.toThrow("approval is absent");
  expect(absent.calls).toHaveLength(0);
  const wrong = await highProbe({}, { binding: { ...highScope, presetId: INCUS_PRESETS[0]!.id,
    presetDigest: "a".repeat(64), sandboxId: "other" } });
  await expect(wrong.run()).rejects.toThrow("bound to another fixture");
  expect(wrong.calls).toHaveLength(0);
  const stale = await highProbe({}, { expiresAt: "2026-09-23T21:59:59.000Z" });
  await expect(stale.run()).rejects.toThrow("approval is absent");
  const tooBroad = await highProbe({}, { maxAttempted: { memory: 6 * 1024 ** 3,
    cpu: 8_000, pids: 1_200, disk: 24 * 1024 ** 3 } });
  await expect(tooBroad.run()).rejects.toThrow("approval is absent");
});

test("high-load mode rejects insufficient measured Xeon RAM, pool space, or PIDs", async () => {
  for (const bad of [
    { ...health, hostAvailableBytes: 8 * 1024 ** 3, hostDiskFreeBytes: 80 * 1024 ** 3 },
    { ...health, hostAvailableBytes: 48 * 1024 ** 3, hostDiskFreeBytes: 25 * 1024 ** 3 },
    { ...health, hostAvailableBytes: 48 * 1024 ** 3, hostDiskFreeBytes: 80 * 1024 ** 3,
      hostAvailablePids: 1_500 },
  ]) {
    const example = await highProbe({ sampleHealth: async () => bad });
    await expect(example.run()).rejects.toThrow("headroom is insufficient");
    expect(example.calls).toHaveLength(0);
  }
});

test("high-load mode rejects failed post-load cleanup readback", async () => {
  const example = await highProbe({ verifyCleanup: async () => ({ filesAbsent: false, processesAbsent: true }) });
  await expect(example.run()).rejects.toThrow("cleanup readback failed");
  expect(example.calls).toEqual(["cpu"]);
});

test("exact reviewed high-load budget passes bounded fake transport and raw readback", async () => {
  const example = await highProbe();
  const result = await example.run();
  expect(example.calls).toEqual(["cpu", "memory", "pids", "disk"]);
  expect(result.facts).toHaveLength(4);
  expect(result.facts[3]?.attempted).toBeGreaterThan(20 * 1024 ** 3);
  expect(result.readouts[3]?.metric).toBe("disk.enospc");
  expect(result.samples).toHaveLength(9);
});

test("a timed-out disk load removes its private test file", () => {
  const root = mkdtempSync(join(tmpdir(), "ezh-load-timeout-"));
  try {
    const script = INCUS_LOAD_GUEST_SCRIPT.replaceAll("/workspace", root)
      .replace("finally:\n    for child in children:", "    time.sleep(3)\nfinally:\n    for child in children:");
    const result = Bun.spawnSync({ cmd: ["python3", "-c", script, "disk", "1048576", "1"],
      stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EDQUOT is a measured disk containment event with cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "ezh-load-edquot-"));
  try {
    const script = INCUS_LOAD_GUEST_SCRIPT.replaceAll("/workspace", root)
      .replace("stream.write(b'x' * min(1048576, target - stream.tell()))",
        "(_ for _ in ()).throw(OSError(errno.EDQUOT, 'quota'))");
    const result = Bun.spawnSync({ cmd: ["python3", "-c", script, "disk", "1048576", "8"],
      stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const raw = JSON.parse(result.stdout.toString());
    expect(raw.childExit).toBe(28);
    expect(raw.cleanupComplete).toBe(true);
    expect(readdirSync(root)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unhealthy neighbor cancels the in-flight guest load promptly", async () => {
  let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
  let cancelled = false;
  let sample = 0;
  const deps = {
    startGuestLoad: async () => ({
      wait: async () => new Promise<{ exitCode: number; stdout: string; stderr: string }>(resolve => {
        finish = resolve;
      }),
      cancel: async () => { cancelled = true; finish({ exitCode: 1, stdout: "", stderr: "" }); },
    }),
    sampleHealth: async () => ++sample === 1 ? health : { ...health, neighborHeartbeat: false },
    readRootQuota: async () => ({ sandboxId: primary.sandboxId, bytes: small.limits.diskBytes }),
    verifyCleanup: async () => ({ filesAbsent: true, processesAbsent: true }),
  };
  const run = exerciseIncusControlledLoads(primary, small, deps);
  const observed = run.catch(error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 450));
    expect(cancelled).toBe(true);
  } finally {
    if (!cancelled) finish({ exitCode: 1, stdout: "", stderr: "" });
    expect(String(await observed)).toContain("affected host or neighbor health");
  }
});

test("a failed health sample still cancels and checks cleanup", async () => {
  let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
  let cancelled = 0;
  let cleanup = 0;
  let samples = 0;
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async () => ({
      wait: async () => new Promise(resolve => { finish = resolve; }),
      cancel: async () => { cancelled++; finish({ exitCode: 1, stdout: "", stderr: "" }); },
    }),
    sampleHealth: async () => { if (++samples === 1) return health; throw new Error("Xeon sample failed"); },
    readRootQuota: async () => ({ sandboxId: primary.sandboxId, bytes: small.limits.diskBytes }),
    verifyCleanup: async () => { cleanup++; return { filesAbsent: false, processesAbsent: false }; },
  };
  await expect(exerciseIncusControlledLoads(primary, small, deps)).rejects.toThrow("load and cleanup failed");
  expect(cancelled).toBe(1);
  expect(cleanup).toBe(1);
});

test("failed cancellation is reported and cleanup is still checked", async () => {
  let cleanup = 0;
  let samples = 0;
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async () => ({
      wait: async () => new Promise(() => {}),
      cancel: async () => { throw new Error("cancel channel lost"); },
    }),
    sampleHealth: async () => ++samples === 1 ? health : { ...health, neighborHeartbeat: false },
    readRootQuota: async () => ({ sandboxId: primary.sandboxId, bytes: small.limits.diskBytes }),
    verifyCleanup: async () => { cleanup++; return { filesAbsent: true, processesAbsent: true }; },
  };
  await expect(exerciseIncusControlledLoads(primary, small, deps))
    .rejects.toThrow("load and cancellation failed");
  expect(cleanup).toBe(1);
});

test("a guest that ignores its own deadline is canceled by the host", async () => {
  let finish!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
  let cancelled = 0;
  const deps: IncusLoadProbeDependencies = {
    startGuestLoad: async () => ({
      wait: async () => new Promise(resolve => { finish = resolve; }),
      cancel: async () => { cancelled++; finish({ exitCode: 1, stdout: "", stderr: "" }); },
    }),
    sampleHealth: async () => health,
    readRootQuota: async () => ({ sandboxId: primary.sandboxId, bytes: small.limits.diskBytes }),
    verifyCleanup: async () => ({ filesAbsent: true, processesAbsent: true }),
  };
  await expect(exerciseIncusControlledLoads(primary, small, deps))
    .rejects.toThrow("guest process exceeded its deadline");
  expect(cancelled).toBe(1);
}, 20_000);
