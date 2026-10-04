import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { exerciseIncusLimits, LIMIT_PROBE_SCRIPT, incusCpuLoadDiagnostic, IncusCpuLoadProofError, type IncusLimitProbeDependencies } from "./incus-live-limit-probe";

const preset = INCUS_PRESETS[0]!;
const handle = { sandboxId: "exact-fixture", operationId: "exact-operation" };
const cpuDetail = { throttledDelta: 3, elapsedMs: 4000, quotaMicros: 200000, periodMicros: 100000,
  cpusetCount: 2, affinityCount: 2, outsideCpuCount: 30, workerCount: 3, workerFailures: 0, workerCpuUsec: 7_000_000,
  usageDeltaUsec: 7_100_000, controlsUnchanged: true, affinityConfined: true };
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
        : resource === "cpu" ? { ...cpuDetail }
          : resource === "pids" ? { denialEventDelta: 1, spawned: observedLimit - 1 }
            : { errno: 122 };
      if (fault?.detail && resource === "cpu") Object.assign(detail, { throttledDelta: 0, cpusetCount: 3, affinityCount: 3 });;
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

test("whole-core effective cpuset proves confinement without a throttle event; inherited affinity does not", async () => {
  for (const [detail, accepted] of [
    [{ ...cpuDetail, throttledDelta: 0 }, true],
    [{ ...cpuDetail, throttledDelta: 0, cpusetCount: 3, affinityCount: 2 }, false],
    [{ ...cpuDetail, quotaMicros: 150000, throttledDelta: 0 }, false],
    [{ ...cpuDetail, workerFailures: 1 }, false],
    [{ ...cpuDetail, workerCount: 2 }, false],
    [{ ...cpuDetail, workerCpuUsec: 0 }, false],
    [{ ...cpuDetail, controlsUnchanged: false }, false],
    [{ ...cpuDetail, affinityConfined: false }, false],
    [{ ...cpuDetail, affinityCount: 3 }, false],
    [{ ...cpuDetail, usageDeltaUsec: 20_000_000 }, false],
    [{ ...cpuDetail, usageDeltaUsec: 8_300_000 }, false],
    [{ ...cpuDetail, usageDeltaUsec: 8_200_000, outsideCpuCount: 0, throttledDelta: 0 }, true],
    [{ ...cpuDetail, usageDeltaUsec: 1 }, false],
    [{ ...cpuDetail, elapsedMs: 2999 }, false],
    [{ ...cpuDetail, periodMicros: 0 }, false],
  ] as const) {
    const deps: IncusLimitProbeDependencies = {
      runGuest: async (_fixture, argv) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ resource: argv[3],
        attempted: Number(argv[4]), observedLimit: Number(argv[5]), contained: true,
        detail: argv[3] === "cpu" ? detail : argv[3] === "memory" ? { oomKillDelta: 1, childExit: -9 }
          : argv[3] === "pids" ? { denialEventDelta: 1, spawned: 1 } : { errno: 122 } }) }),
      hostHealthy: async () => true, neighborHealthy: async () => true,
      hostStorageFreeBytes: async () => preset.limits.diskBytes + 128 * 1024 * 1024,
    };
    const result = exerciseIncusLimits(handle, preset, facts, deps);
    if (accepted) expect(await result).toHaveLength(4);
    else await expect(result).rejects.toBeInstanceOf(IncusCpuLoadProofError);
  }
});
test("numeric CPU diagnostics remove guest text and reject malformed or out-of-bound values", () => {
  expect(incusCpuLoadDiagnostic({ ...cpuDetail, token: "secret", error: "private" })).toEqual(cpuDetail);
  for (const value of [null, [], {}, { ...cpuDetail, elapsedMs: -1 }, { ...cpuDetail, usageDeltaUsec: 1e15 },
    { ...cpuDetail, workerFailures: 0.1 }, { ...cpuDetail, controlsUnchanged: "true" }, { ...cpuDetail, affinityConfined: 1 }]) {
    expect(incusCpuLoadDiagnostic(value)).toBeNull();
  }
});

test("fractional quota needs throttling even when effective cpuset is its whole-core ceiling", async () => {
  const selected = { ...preset, limits: { ...preset.limits, cpuMillis: 1500 } };
  for (const throttledDelta of [0, 2]) {
    const deps: IncusLimitProbeDependencies = {
      runGuest: async (_fixture, argv) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({resource: argv[3],
        attempted: Number(argv[4]), observedLimit: Number(argv[5]), contained: true,
        detail: argv[3] === "cpu" ? { ...cpuDetail, quotaMicros: 150000, throttledDelta,
          workerCpuUsec: 5_000_000, usageDeltaUsec: 5_100_000 } : argv[3] === "memory" ? { oomKillDelta: 1, childExit: -9 }
          : argv[3] === "pids" ? { denialEventDelta: 1, spawned: 1 } : { errno: 122 } }) }),
      hostHealthy: async () => true, neighborHealthy: async () => true,
      hostStorageFreeBytes: async () => preset.limits.diskBytes + 128 * 1024 * 1024,
    };
    const result = exerciseIncusLimits(handle, selected, {...facts,cpuQuotaMillis:1500},deps);
    if (throttledDelta) expect(await result).toHaveLength(4);
    else await expect(result).rejects.toBeInstanceOf(IncusCpuLoadProofError);
  }
});

test("emitted script runs real workers with a deterministic kernel-cpuset boundary and no throttle events", () => {
  // Rootless CI does not delegate cpuset. This seam supplies the kernel mask
  // and intersection behavior; real worker execution/affinity/CPU time remain real.
  const bootstrap = String.raw`import json,os,pathlib,resource,time,sys
original_read=pathlib.Path.read_text
original_set=os.sched_setaffinity
allowed=set(sorted(os.sched_getaffinity(0))[:2])
if len(allowed)!=2: raise RuntimeError('test needs two available CPUs')
original_set(0,allowed)
def set_affinity(pid,requested): original_set(pid,set(requested)&allowed)
os.sched_setaffinity=set_affinity
def read(self,*args,**kwargs):
 name=str(self)
 if name=='/sys/fs/cgroup/cpuset.cpus.effective': return ','.join(map(str,sorted(allowed)))
 if name=='/sys/fs/cgroup/cpu.max': return '200000 100000'
 if name=='/sys/fs/cgroup/memory.max': return '536870912'
 if name=='/sys/fs/cgroup/pids.max': return '64'
 if name=='/sys/fs/cgroup/cpu.stat':
  children=resource.getrusage(resource.RUSAGE_CHILDREN)
  usage=int((children.ru_utime+children.ru_stime+time.process_time())*1000000)
  return 'usage_usec '+str(usage)+'\n'+'nr_throttled 0\n'
 return original_read(self,*args,**kwargs)
pathlib.Path.read_text=read
sys.argv=['probe','cpu','3000','2000']
exec(sys.argv_script)
`;
  const result = spawnSync("python3", ["-c", "import sys; sys.argv_script=sys.argv[1]; " + bootstrap, LIMIT_PROBE_SCRIPT],
    { encoding: "utf8", timeout: 30_000 });
  expect(result.status).toBe(0); expect(result.stderr).toBe("");
  const proof = JSON.parse(result.stdout);
  expect(proof.contained).toBe(true); expect(proof.detail.throttledDelta).toBe(0);
  expect(proof.detail.cpusetCount).toBe(2); expect(proof.detail.outsideCpuCount).toBeGreaterThanOrEqual(0); expect(proof.detail.affinityCount).toBe(2);
  expect(proof.detail.workerCount).toBe(3); expect(proof.detail.workerFailures).toBe(0);
  expect(proof.detail.workerCpuUsec).toBeGreaterThan(0);
  expect(proof.detail.controlsUnchanged).toBe(true); expect(proof.detail.affinityConfined).toBe(true);
});
