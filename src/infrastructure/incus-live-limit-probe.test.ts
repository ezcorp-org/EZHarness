import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { INCUS_PRESETS } from "../../extensions/incus-sandbox/manifest";
import { exerciseIncusLimits, LIMIT_PROBE_SCRIPT, IncusLimitLoadFailure, incusLimitResource, incusCpuLoadDiagnostic, IncusCpuLoadProofError, type IncusLimitProbeDependencies } from "./incus-live-limit-probe";

const preset = INCUS_PRESETS[0]!;
const memoryPath = `ezh-memory-probe-${"a".repeat(64)}`;
const memoryDetail = { oomKillDelta: 1, childExit: -9, controlMappedBytes: 217088, controlLockedBytes: 217088, payloadLockedBytes: 0 };
const handle = { sandboxId: "exact-fixture", operationId: "exact-operation" };
const cpuDetail = { throttledDelta: 3, elapsedMs: 4000, quotaMicros: 200000, periodMicros: 100000,
  cpusetCount: 2, affinityCount: 2, outsideCpuCount: 30, workerCount: 3, workerFailures: 0, workerCpuUsec: 7_000_000,
  usageDeltaUsec: 7_100_000, controlsUnchanged: true, affinityConfined: true };
const facts = { memoryMaxBytes: preset.limits.memoryBytes, cpuQuotaMillis: preset.limits.cpuMillis,
  pidsMax: preset.limits.pids, rootQuotaBytes: preset.limits.diskBytes,
  privateNetworkProbeBlocked: true, unprivilegedUidMap: true };

function harness(fault?: { resource?: string; detail?: boolean; neighbor?: boolean; host?: boolean;
  pool?: "full" | "leak"; thrownResource?: string; thrown?: unknown; memory?: "no-oom" | "zero-exit"; nativeDetail?: Record<string, unknown>; stage?: "failure" | "path" }) {
  const calls: string[] = [];
  const poolFreeBytes = preset.limits.diskBytes + 128 * 1024 * 1024;
  const deps: IncusLimitProbeDependencies = {
    prepareMemoryLoad: async () => {
      if (fault?.stage === "failure") throw new Error("stage refused");
      return fault?.stage === "path" ? "../unowned" : memoryPath;
    },
    runGuest: async (fixture, argv, timeout) => {
      expect(fixture).toEqual(handle);
      expect(argv.slice(0, 3)).toEqual(["python3", "-c", LIMIT_PROBE_SCRIPT]);
      expect(timeout).toBe(110_000);
      const resource = argv[3]!;
      calls.push(resource);
      if (fault?.thrownResource === resource) throw fault.thrown;
      const attempted = Number(argv[4]);
      const observedLimit = Number(argv[5]);
      if (resource === "memory") expect(attempted).toBe(preset.limits.memoryBytes + 16 * 1024 * 1024);
      const detail = resource === "memory" ? { ...memoryDetail }
        : resource === "cpu" ? { ...cpuDetail }
          : resource === "pids" ? { denialEventDelta: 1, spawned: observedLimit - 1 }
            : { errno: 122 };
      if (resource === "memory" && fault?.nativeDetail) Object.assign(detail, fault.nativeDetail);
      if (resource === "memory" && fault?.memory) Object.assign(detail,
        fault.memory === "no-oom" ? { oomKillDelta: 0 } : { childExit: 0 });
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

const memoryParentBootstrap = String.raw`import json,os,pathlib,shutil,subprocess,sys,tempfile
from unittest.mock import patch
source=sys.argv[1]; page=os.sysconf('SC_PAGE_SIZE'); target=65537; events=iter([0,1]); fault=sys.argv[3] if len(sys.argv)>3 else 'none'; calls=[]
control={'phase':'control','mappedBytes':217088,'lockedBytes':217088,'pageBytes':page,'targetBytes':target}
mapped={'phase':'mapped','address':'0x1000','lockedBytes':217088,'payloadLockedBytes':0}
def read(path,*args,**kwargs):
 name=path.name
 if name=='memory.max': return '65536'
 if name=='cpu.max': return '200000 100000'
 if name=='pids.max': return '1024'
 if name=='memory.events': return 'oom_kill '+str(next(events))
 raise AssertionError(name)
def child(argv,**kwargs):
 calls.append('child')
 fd=kwargs['pass_fds'][0]
 if fault=='replacement': path.unlink();path.write_bytes(b'changed')
 assert os.fstat(fd).st_size==59704
 assert argv==['/proc/self/fd/'+str(fd),str(target)]
 assert kwargs=={'pass_fds':(fd,),'timeout':70,'stdout':subprocess.PIPE,'stderr':subprocess.PIPE}
 assert os.fstat(fd).st_size==59704
 if fault=='locked': mapped['payloadLockedBytes']=4096
 if fault=='unstable': mapped['lockedBytes']=4096
 return subprocess.CompletedProcess(argv,-9,(json.dumps(control)+'\n'+json.dumps(mapped)+'\n').encode(),b'')
with tempfile.TemporaryDirectory() as directory:
 path=pathlib.Path(directory)/('ezh-memory-probe-'+('a'*64));shutil.copyfile(sys.argv[2],path);path.chmod(0o700)
 if fault=='mode': path.chmod(0o600)
 if fault=='digest':
  data=bytearray(path.read_bytes());data[-1]^=1;path.write_bytes(data)
 if fault=='size': path.write_bytes(b'short')
 if fault=='symlink': path.unlink();path.symlink_to(sys.argv[2])
 if fault=='hardlink': os.link(path,str(path)+'-alias')
 with patch.object(pathlib.Path,'read_text',read),patch.object(subprocess,'run',child),patch.object(sys,'argv',['probe','memory',str(target),'65536',str(path)]):
  try: exec(compile(source,'<actual-parent>','exec'),{})
  except (RuntimeError,OSError) as error:
   if fault not in ('mode','digest','size','symlink','hardlink','locked','unstable'): raise
   assert len(calls)==int(fault in ('locked','unstable'))
   print('refused:'+fault)`;

test("actual generated memory parent validates native control and unlocked payload before OOM proof", () => {
  const result = spawnSync("python3", ["-c", memoryParentBootstrap, LIMIT_PROBE_SCRIPT, new URL("./incus-guest/memory-stress.x86_64.bin", import.meta.url).pathname], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ resource: "memory", attempted: 65537, observedLimit: 65536,
    contained: true, detail: memoryDetail });
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

test("memory pressure without an OOM kill or a nonzero child exit remains a failed qualification", async () => {
  for (const memory of ["no-oom", "zero-exit"] as const) {
    const value = harness({ memory });
    await expect(value.run()).rejects.toThrow("memory load did not prove containment");
    expect(value.calls).toEqual(["host", "neighbor", "memory"]);
  }
});

test("an observed limit above the reviewed preset denies before any load", async () => {
  let invoked = false;
  await expect(exerciseIncusLimits(handle, preset, { ...facts, memoryMaxBytes: preset.limits.memoryBytes + 1 }, {
    prepareMemoryLoad: async () => { invoked = true; throw new Error("must not stage"); },
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
    prepareMemoryLoad: async () => memoryPath,
      runGuest: async (_fixture, argv) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ resource: argv[3],
        attempted: Number(argv[4]), observedLimit: Number(argv[5]), contained: true,
        detail: argv[3] === "cpu" ? detail : argv[3] === "memory" ? { ...memoryDetail }
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
    prepareMemoryLoad: async () => memoryPath,
      runGuest: async (_fixture, argv) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({resource: argv[3],
        attempted: Number(argv[4]), observedLimit: Number(argv[5]), contained: true,
        detail: argv[3] === "cpu" ? { ...cpuDetail, quotaMicros: 150000, throttledDelta,
          workerCpuUsec: 5_000_000, usageDeltaUsec: 5_100_000 } : argv[3] === "memory" ? { ...memoryDetail }
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

test("each failed load preserves only its finite resource and privately keeps the original failure", async () => {
  const secret = new Error("secret-canary credentials stdio");
  for (const resource of ["memory", "cpu", "pids", "disk"] as const) {
    let failure: unknown;
    try { await harness({ thrownResource: resource, thrown: secret }).run(); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(IncusLimitLoadFailure);
    expect((failure as IncusLimitLoadFailure).resource).toBe(resource);
    expect((failure as IncusLimitLoadFailure).failure()).toBe(secret);
    expect(JSON.stringify(failure)).not.toContain("secret-canary");
  }
  expect(incusLimitResource("secret-canary")).toBeNull();
  expect(() => new IncusLimitLoadFailure("secret-canary" as "memory", secret)).toThrow("invalid load diagnostic resource");
});


test("native stage failure or an unsafe staged path cannot start a memory process", async () => {
  for (const stage of ["failure", "path"] as const) {
    const value = harness({ stage });
    await expect(value.run()).rejects.toBeInstanceOf(IncusLimitLoadFailure);
    expect(value.calls).toEqual(["host", "neighbor"]);
  }
});

test("native memory acceptance rejects locked payloads, unbounded control and non-OOM exits", async () => {
  for (const nativeDetail of [{ childExit: 137 }, { controlLockedBytes: 0 }, { controlLockedBytes: 1.5 },
    { controlMappedBytes: 1048577 }, { controlMappedBytes: 1 }, { controlMappedBytes: 1.5 },
    { payloadLockedBytes: 1 }]) {
    await expect(harness({ nativeDetail }).run()).rejects.toThrow("memory load did not prove containment");
  }
});


test("actual memory parent rejects unverified inodes and changed lock frames before accepting a load", () => {
  const binary = new URL("./incus-guest/memory-stress.x86_64.bin", import.meta.url).pathname;
  for (const fault of ["mode", "digest", "size", "symlink", "hardlink", "locked", "unstable"]) {
    const result = spawnSync("python3", ["-c", memoryParentBootstrap, LIMIT_PROBE_SCRIPT, binary, fault], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`refused:${fault}`);
  }
  const replacement = spawnSync("python3", ["-c", memoryParentBootstrap, LIMIT_PROBE_SCRIPT, binary, "replacement"], { encoding: "utf8" });
  expect(replacement.status).toBe(0);
  expect(JSON.parse(replacement.stdout).contained).toBe(true);
});


test("actual descriptor-launched native leaf cannot pass memory enforcement merely by completing allocation", () => {
  const bootstrap = `import os,pathlib,shutil,sys,tempfile
from unittest.mock import patch
source=sys.argv[1]; events=iter([0,1])
def read(path,*args,**kwargs):
 if path.name=='memory.max': return '65536'
 if path.name=='cpu.max': return '200000 100000'
 if path.name=='pids.max': return '1024'
 if path.name=='memory.events': return 'oom_kill '+str(next(events))
 raise AssertionError(path.name)
with tempfile.TemporaryDirectory() as directory:
 path=pathlib.Path(directory)/('ezh-memory-probe-'+('a'*64));shutil.copyfile(sys.argv[2],path);path.chmod(0o700)
 with patch.object(pathlib.Path,'read_text',read),patch.object(sys,'argv',['probe','memory','65537','65536',str(path)]):
  exec(compile(source,'<actual-native-parent>','exec'),{})`;
  const result = spawnSync("python3", ["-c", bootstrap, LIMIT_PROBE_SCRIPT,
    new URL("./incus-guest/memory-stress.x86_64.bin", import.meta.url).pathname], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const proof = JSON.parse(result.stdout);
  expect(proof.contained).toBe(false);
  expect(proof.detail.childExit).toBe(0);
  expect(proof.detail.controlLockedBytes).toBeGreaterThan(0);
  expect(proof.detail.controlMappedBytes).toBeLessThanOrEqual(1048576);
  expect(proof.detail.payloadLockedBytes).toBe(0);
});
