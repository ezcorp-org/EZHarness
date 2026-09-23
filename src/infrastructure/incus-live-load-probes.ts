import type { SandboxPreset } from "@ezcorp/extension-contract";
import type { LiveCommandResult, LiveFixtureHandle, LiveLimitLoadFact } from "./incus-live-cases";

type Resource = LiveLimitLoadFact["resource"];

/** Absolute caps keep a mistaken preset or cgroup readback from stressing the host. */
const CAPS: Record<Resource, number> = {
  memory: 512 * 1024 * 1024,
  cpu: 2_000,
  pids: 64,
  disk: 256 * 1024 * 1024,
};
const ORDER: Resource[] = ["cpu", "memory", "pids", "disk"];
const TIMEOUT_MS = 10_000;

export interface IncusLoadHealth {
  /** Identity of the Xeon host, stable across every sample. */
  hostId: string;
  hostAvailableBytes: number;
  hostMemoryPressurePercent: number;
  hostCpuPressurePercent: number;
  hostDiskFreeBytes: number;
  hostOomKills: number;
  /** Independent, running fixture identity and a successful guest heartbeat. */
  neighborSandboxId: string;
  neighborBootId: string;
  neighborHeartbeat: boolean;
}

export interface IncusLoadProbeDependencies {
  /** This must use the protected exact-fixture guest transport. */
  runGuest: (handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number) => Promise<LiveCommandResult>;
  /** Read Xeon metrics and a different EZHarness-owned fixture over protected paths. */
  sampleHealth: (handle: LiveFixtureHandle) => Promise<IncusLoadHealth>;
  /** Read the exact fixture root-volume quota through pinned Incus GET. */
  readRootQuota: (handle: LiveFixtureHandle) => Promise<{ sandboxId: string; bytes: number }>;
}

export interface IncusLoadProbeResult {
  facts: LiveLimitLoadFact[];
  samples: Array<{ resource: Resource | "baseline"; phase: "before" | "during" | "after";
    health: IncusLoadHealth }>;
  readouts: Array<{ resource: Resource; attempted: number; observedLimit: number;
    metric: "cpu.usage_usec" | "memory.peak" | "pids.peak" | "disk.enospc";
    metricValue: number; limitEvents: number; childExit: number; cleanupComplete: boolean }>;
}

function fail(message: string): never {
  throw new Error(`Incus controlled load unsupported: ${message}`);
}

function requireProbe(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function finite(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function healthy(sample: IncusLoadHealth, baseline: IncusLoadHealth, primary: LiveFixtureHandle): boolean {
  return sample.hostId === baseline.hostId && sample.hostId.length > 0
    && finite(sample.hostAvailableBytes) && sample.hostAvailableBytes >= 2 * 1024 ** 3
    && Number.isFinite(sample.hostMemoryPressurePercent)
    && sample.hostMemoryPressurePercent >= 0 && sample.hostMemoryPressurePercent <= 20
    && Number.isFinite(sample.hostCpuPressurePercent)
    && sample.hostCpuPressurePercent >= 0 && sample.hostCpuPressurePercent <= 80
    && finite(sample.hostDiskFreeBytes) && sample.hostDiskFreeBytes >= 2 * 1024 ** 3
    && finite(sample.hostOomKills) && sample.hostOomKills === baseline.hostOomKills
    && sample.neighborSandboxId === baseline.neighborSandboxId
    && sample.neighborSandboxId !== primary.sandboxId
    && sample.neighborBootId === baseline.neighborBootId
    && /^[a-f0-9-]{36}$/.test(sample.neighborBootId)
    && sample.neighborHeartbeat === true;
}

/**
 * A separate child does the load. Python's finally block removes child processes
 * and test files. The parent script reads cgroup events after the child exits.
 * No shell, host path, or provider token is accepted from a caller.
 */
const GUEST_SCRIPT = String.raw`import json, os, pathlib, signal, subprocess, sys, time
kind, target_text = sys.argv[1:]
target = int(target_text)
cg = pathlib.Path('/sys/fs/cgroup')
def read(name): return (cg / name).read_text(encoding='ascii').strip()
def count(name, key):
    return int(next((line.split()[1] for line in read(name).splitlines() if line.startswith(key + ' ')), '0'))
before = count('cpu.stat', 'nr_throttled') if kind == 'cpu' else count('memory.events', 'oom_kill') if kind == 'memory' else count('pids.events', 'max') if kind == 'pids' else 0
script = r'''
import errno, os, pathlib, subprocess, sys, time
kind, target_text = sys.argv[1:]
target = int(target_text)
children = []
file = pathlib.Path('/workspace/.ezh-qualification-load-' + str(os.getpid()))
try:
    if kind == 'cpu':
        end = time.monotonic() + 3
        children = [subprocess.Popen([sys.executable, '-c', 'import time; end=time.monotonic()+3; x=0\nwhile time.monotonic()<end: x+=1']) for _ in range((target + 999)//1000)]
        for child in children: child.wait(timeout=5)
    elif kind == 'memory':
        chunks = []
        for _ in range((target + 1048575)//1048576):
            block = bytearray(1048576)
            block[:] = b'x' * len(block)
            chunks.append(block)
    elif kind == 'pids':
        for _ in range(target):
            try: children.append(subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)']))
            except OSError as error:
                if error.errno != errno.EAGAIN: raise
                break
    elif kind == 'disk':
        with file.open('wb', buffering=0) as stream:
            for _ in range((target + 1048575)//1048576):
                try: stream.write(b'x' * min(1048576, target - stream.tell()))
                except OSError as error:
                    if error.errno != errno.ENOSPC: raise
                    sys.exit(28)
finally:
    for child in children:
        if child.poll() is None: child.terminate()
    for child in children:
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=2)
    file.unlink(missing_ok=True)
'''
child = subprocess.Popen([sys.executable, '-c', script, kind, str(target)],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
try:
    child.wait(timeout=8)
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    child.wait(timeout=2)
    raise
if kind == 'cpu':
    quota, period = map(int, read('cpu.max').split())
    observed = quota * 1000 // period
    peak = count('cpu.stat', 'usage_usec')
    events = count('cpu.stat', 'nr_throttled') - before
elif kind == 'memory':
    observed = int(read('memory.max'))
    peak = int(read('memory.peak'))
    events = count('memory.events', 'oom_kill') - before
elif kind == 'pids':
    observed = int(read('pids.max'))
    peak = int(read('pids.peak'))
    events = count('pids.events', 'max') - before
else:
    observed = 0  # disk quota is independently read from Incus by the host
    peak = child.returncode
    events = 0
print(json.dumps({'attempted': target, 'observedLimit': observed, 'peak': peak,
    'limitEvents': events, 'childExit': child.returncode, 'cleanupComplete': True}))`;

/** Executes bounded loads. Every fact must be measured, with an independent neighbor. */
export async function exerciseIncusControlledLoads(
  primary: LiveFixtureHandle, preset: SandboxPreset, deps: IncusLoadProbeDependencies,
): Promise<IncusLoadProbeResult> {
  const limits = { memory: preset.limits.memoryBytes, cpu: preset.limits.cpuMillis,
    pids: preset.limits.pids, disk: preset.limits.diskBytes };
  // Reject before any load. The published 4 GiB / 20 GiB preset exceeds these
  // caps and must use a separate reviewed, safe qualification recipe.
  for (const resource of ORDER) {
    requireProbe(finite(limits[resource]) && limits[resource] > 0
      && limits[resource] < CAPS[resource], `${resource} limit exceeds the reviewed safety cap`);
  }
  const baseline = await deps.sampleHealth(primary);
  requireProbe(healthy(baseline, baseline, primary), "host or independent neighbor baseline is unhealthy");
  const samples: IncusLoadProbeResult["samples"] = [{ resource: "baseline", phase: "before", health: baseline }];
  const readouts: IncusLoadProbeResult["readouts"] = [];
  const facts: LiveLimitLoadFact[] = [];
  for (const resource of ORDER) {
    const attempted = limits[resource] + (resource === "cpu" ? 1_000 : resource === "pids" ? 1 : 1024 * 1024);
    requireProbe(attempted <= CAPS[resource], `${resource} attempted load exceeds the safety cap`);
    // Wait for both operations before assessing either result. An unhealthy
    // sample must never leave a still-running guest load unobserved.
    const [command, middle] = await Promise.allSettled([
      deps.runGuest(primary, ["python3", "-c", GUEST_SCRIPT,
        resource, String(attempted)], TIMEOUT_MS),
      new Promise<void>(resolve => setTimeout(resolve, 250)).then(() => deps.sampleHealth(primary)),
    ]);
    requireProbe(command.status === "fulfilled" && middle.status === "fulfilled",
      `${resource} guest load or in-flight health sample failed`);
    const result = command.value;
    samples.push({ resource, phase: "during", health: middle.value });
    requireProbe(healthy(middle.value, baseline, primary), `${resource} affected host or neighbor health`);
    requireProbe(result.stdout.length <= 4096 && result.stderr.length <= 4096
      && result.exitCode === 0, `${resource} guest probe failed`);
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(result.stdout); }
    catch { return fail(`${resource} guest readout is invalid`); }
    const followup = await deps.sampleHealth(primary);
    samples.push({ resource, phase: "after", health: followup });
    requireProbe(healthy(followup, baseline, primary), `${resource} affected host or neighbor health`);
    const diskQuota = resource === "disk" ? await deps.readRootQuota(primary) : null;
    const observedLimit = diskQuota?.bytes ?? parsed.observedLimit;
    requireProbe((!diskQuota || diskQuota.sandboxId === primary.sandboxId)
      && parsed.attempted === attempted && finite(observedLimit)
      && observedLimit > 0 && observedLimit <= limits[resource]
      && finite(parsed.peak) && finite(parsed.limitEvents)
      && parsed.cleanupComplete === true, `${resource} evidence is incomplete`);
    // A child killed by the cgroup is expected for memory; all other probes
    // must exit normally. CPU/PID require a measured cgroup throttle/hit.
    const childExit = parsed.childExit;
    const cgroupHit = Number(parsed.limitEvents) > 0;
    requireProbe(resource === "memory" ? cgroupHit && childExit === -9
      : resource === "cpu" || resource === "pids" ? cgroupHit && childExit === 0
        : childExit === 28, `${resource} containment was not observed`);
    const metric = resource === "cpu" ? "cpu.usage_usec"
      : resource === "memory" ? "memory.peak" : resource === "pids" ? "pids.peak" : "disk.enospc";
    readouts.push({ resource, attempted, observedLimit: Number(observedLimit),
      metric, metricValue: Number(parsed.peak), limitEvents: Number(parsed.limitEvents),
      childExit: Number(childExit), cleanupComplete: true });
    facts.push({ resource, attempted, observedLimit: Number(observedLimit),
      contained: true, neighborHealthy: true, hostHealthy: true });
  }
  return { facts, samples, readouts };
}
