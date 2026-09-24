import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { exerciseIncusLimits, LIMIT_PROBE_SCRIPT, type IncusLimitProbeDependencies } from "./incus-live-limit-probe";

const preset = INCUS_PRESETS[0]!;
const handle = { sandboxId: "exact-fixture", operationId: "exact-operation" };
const facts = { memoryMaxBytes: preset.limits.memoryBytes, cpuQuotaMillis: preset.limits.cpuMillis,
  pidsMax: preset.limits.pids, rootQuotaBytes: preset.limits.diskBytes,
  privateNetworkProbeBlocked: true, unprivilegedUidMap: true };

function harness(fault?: { resource?: string; detail?: boolean; neighbor?: boolean; host?: boolean;
  pool?: "full" | "leak" }) {
  const calls: string[] = [];
  const poolFreeBytes = preset.limits.diskBytes + 128 * 1024 * 1024;
  const deps: IncusLimitProbeDependencies = {
    runGuest: async (fixture, argv, timeout) => {
      expect(fixture).toEqual(handle);
      expect(argv.slice(0, 3)).toEqual(["python3", "-c", LIMIT_PROBE_SCRIPT]);
      expect(timeout).toBeLessThanOrEqual(120_000);
      const resource = argv[3]!;
      calls.push(resource);
      const attempted = Number(argv[4]);
      const observedLimit = Number(argv[5]);
      const detail = resource === "memory" ? { oomKillDelta: 1, childExit: -9 }
        : resource === "cpu" ? { throttledDelta: 3, elapsedMs: 4000 }
          : resource === "pids" ? { denialEventDelta: 1, spawned: observedLimit - 1 }
            : { errno: 122 };
      if (fault?.detail && resource === "cpu") detail.throttledDelta = 0;
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({
        resource: fault?.resource === resource ? "forged" : resource,
        attempted, observedLimit, contained: true, detail,
      }) };
    },
    neighborHealthy: async () => {
      calls.push("neighbor");
      return fault?.neighbor !== false;
    },
    hostHealthy: async () => {
      calls.push("host");
      return fault?.host !== false;
    },
    hostStorageFreeBytes: async () => {
      calls.push("pool");
      return fault?.pool === "full" ? preset.limits.diskBytes
        : fault?.pool === "leak" && calls.filter(call => call === "pool").length === 2
          ? poolFreeBytes - 96 * 1024 * 1024 : poolFreeBytes;
    },
  };
  return { calls, run: () => exerciseIncusLimits(handle, preset, facts, deps) };
}

test("real load script compiles before a fixture can run it", () => {
  const result = spawnSync("python3", ["-c", "import sys; compile(sys.argv[1], '<probe>', 'exec')", LIMIT_PROBE_SCRIPT],
    { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
});

test("four resource loads require kernel evidence and healthy host and neighbor readbacks", async () => {
  const value = harness();
  const results = await value.run();
  expect(results.map(result => result.resource)).toEqual(["memory", "cpu", "pids", "disk"]);
  for (const result of results) {
    expect(result.attempted).toBeGreaterThan(preset.limits[`${result.resource === "cpu" ? "cpuMillis"
      : result.resource === "memory" ? "memoryBytes" : result.resource === "disk" ? "diskBytes" : "pids"}`]);
    expect(result.contained && result.hostHealthy && result.neighborHealthy).toBe(true);
  }
  expect(value.calls.filter(call => call === "host")).toHaveLength(8);
  expect(value.calls.filter(call => call === "neighbor")).toHaveLength(8);
  expect(value.calls.filter(call => call === "pool")).toHaveLength(2);
});

test("missing kernel evidence, forged identity, or unhealthy neighbor denies qualification", async () => {
  await expect(harness({ detail: true }).run()).rejects.toThrow("cpu load did not prove containment");
  await expect(harness({ resource: "memory" }).run()).rejects.toThrow("memory load did not prove containment");
  await expect(harness({ neighbor: false }).run()).rejects.toThrow("unhealthy before memory load");
  await expect(harness({ host: false }).run()).rejects.toThrow("unhealthy before memory load");
});

test("an observed limit above the reviewed preset denies before any load", async () => {
  let invoked = false;
  await expect(exerciseIncusLimits(handle, preset, { ...facts, memoryMaxBytes: preset.limits.memoryBytes + 1 }, {
    runGuest: async () => { invoked = true; throw new Error("must not run"); },
    neighborHealthy: async () => true, hostHealthy: async () => true,
    hostStorageFreeBytes: async () => preset.limits.diskBytes + 128 * 1024 * 1024,
  })).rejects.toThrow("memory observed limit or requested load is invalid");
  expect(invoked).toBe(false);
});

test("disk quota denial needs independent host pool headroom and recovered pool space", async () => {
  await expect(harness({ pool: "full" }).run()).rejects.toThrow("insufficient independent free space");
  await expect(harness({ pool: "leak" }).run()).rejects.toThrow("did not recover");
});
