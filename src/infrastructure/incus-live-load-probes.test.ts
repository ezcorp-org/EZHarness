import { expect, test } from "bun:test";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { exerciseIncusControlledLoads, type IncusLoadHealth,
  type IncusLoadProbeDependencies } from "./incus-live-load-probes";

const primary = { sandboxId: "primary", operationId: "primary-create" };
const small = { ...INCUS_PRESETS[0]!, limits: { ...INCUS_PRESETS[0]!.limits,
  memoryBytes: 128 * 1024 ** 2, cpuMillis: 500, pids: 32, diskBytes: 32 * 1024 ** 2,
} };
const health: IncusLoadHealth = {
  hostId: "xeon", hostAvailableBytes: 8 * 1024 ** 3, hostMemoryPressurePercent: 1,
  hostCpuPressurePercent: 1, hostDiskFreeBytes: 8 * 1024 ** 3,
  hostOomKills: 0, neighborSandboxId: "neighbor", neighborBootId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  neighborHeartbeat: true,
};

function probe(overrides: Partial<IncusLoadProbeDependencies> = {}) {
  const calls: string[] = [];
  const deps: IncusLoadProbeDependencies = {
    runGuest: async (handle, argv, timeoutMs) => {
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
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({
        attempted, observedLimit: resource === "disk" ? 0 : observedLimit,
        peak: resource === "disk" ? 28 : 1, limitEvents: resource === "disk" ? 0 : 1,
        childExit: resource === "memory" ? -9 : resource === "disk" ? 28 : 0,
        cleanupComplete: true,
      }) };
    },
    sampleHealth: async () => health,
    readRootQuota: async handle => ({ sandboxId: handle.sandboxId, bytes: small.limits.diskBytes }),
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
    runGuest: async () => { calls++; throw new Error("must not load"); },
    sampleHealth: async () => { calls++; return health; },
    readRootQuota: async () => { calls++; throw new Error("must not read"); },
  };
  await expect(exerciseIncusControlledLoads(primary, INCUS_PRESETS[0]!, deps))
    .rejects.toThrow("safety cap");
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
      runGuest: async () => { guestCalls++; throw new Error("must not run"); } }).run())
      .rejects.toThrow("baseline is unhealthy");
  }
  expect(guestCalls).toBe(0);
});

test("guest load cannot pass from configured limit without a measured hit", async () => {
  const example = probe({ runGuest: async (_handle, argv) => ({ exitCode: 0, stderr: "",
    stdout: JSON.stringify({ attempted: Number(argv[4]), observedLimit: small.limits.cpuMillis,
      peak: 1, limitEvents: 0, childExit: 0, cleanupComplete: true }) }) });
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
