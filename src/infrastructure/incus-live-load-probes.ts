import { sandboxPresetDigest, type SandboxPreset } from "@ezcorp/extension-contract";
import type { LiveCommandResult, LiveFixtureHandle, LiveLimitLoadFact } from "./incus-live-cases";

type Resource = LiveLimitLoadFact["resource"];

/** Absolute caps keep a mistaken preset or cgroup readback from stressing the host. */
const CAPS: Record<Resource, number> = {
  memory: 512 * 1024 * 1024,
  cpu: 2_000,
  pids: 64,
  disk: 256 * 1024 * 1024,
};
const HIGH_CAPS: Record<Resource, number> = {
  memory: 5 * 1024 ** 3,
  cpu: 8_000,
  pids: 1_200,
  disk: 24 * 1024 ** 3,
};
const HIGH_RAM_MARGIN = 8 * 1024 ** 3;
const HIGH_DISK_MARGIN = 16 * 1024 ** 3;
const HIGH_PID_MARGIN = 1_024;
const ORDER: Resource[] = ["cpu", "memory", "pids", "disk"];
const TIMEOUT_MS = 10_000;

export interface IncusLoadHealth {
  /** Identity of the Xeon host, stable across every sample. */
  hostId: string;
  hostAvailableBytes: number;
  hostMemoryPressurePercent: number;
  hostCpuPressurePercent: number;
  hostDiskFreeBytes: number;
  hostAvailablePids: number;
  hostOomKills: number;
  /** Independent, running fixture identity and a successful guest heartbeat. */
  neighborSandboxId: string;
  neighborBootId: string;
  neighborHeartbeat: boolean;
}

export interface IncusLoadProbeDependencies {
  /** Start a durable exact-fixture guest process and return its cancellable handle. */
  startGuestLoad: (handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number) => Promise<{
    wait: () => Promise<LiveCommandResult>;
    cancel: () => Promise<void>;
  }>;
  /** Read Xeon metrics and a different EZHarness-owned fixture over protected paths. */
  sampleHealth: (handle: LiveFixtureHandle) => Promise<IncusLoadHealth>;
  /** Read the exact fixture root-volume quota through pinned Incus GET. */
  readRootQuota: (handle: LiveFixtureHandle) => Promise<{ sandboxId: string; bytes: number }>;
  /** Independent post-load guest readback, required for every load. */
  verifyCleanup: (handle: LiveFixtureHandle, resource: Resource) => Promise<{
    filesAbsent: boolean; processesAbsent: boolean }>;
  /** Host-only operator approval lookup. Never pass an agent-supplied approval. */
  resolveApprovedBudget?: (binding: IncusLoadBudgetBinding) => Promise<IncusHighLoadBudget | null>;
}

export interface IncusLoadBudgetBinding {
  installationId: string;
  releaseId: string;
  connectionId: string;
  presetId: string;
  presetDigest: string;
  sandboxId: string;
}

export interface IncusHighLoadBudget {
  approvalId: string;
  approvedBy: string;
  expiresAt: string;
  binding: IncusLoadBudgetBinding;
  expectedLimits: Record<Resource, number>;
  maxAttempted: Record<Resource, number>;
  maxDeadlineMs: number;
}

export interface IncusLoadProbeOptions {
  /** Required only when the reviewed preset exceeds ordinary safety caps. */
  scope?: Omit<IncusLoadBudgetBinding, "presetId" | "presetDigest" | "sandboxId">;
  now?: () => number;
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
    && finite(sample.hostAvailablePids) && sample.hostAvailablePids >= 1_024
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
export const INCUS_LOAD_GUEST_SCRIPT = String.raw`import json, os, pathlib, signal, subprocess, sys, time
kind, target_text, timeout_text = sys.argv[1:]
target = int(target_text)
timeout = int(timeout_text)
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
            try: children.append(subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)']))
            except OSError as error:
                if error.errno != errno.EAGAIN: raise
                break
    elif kind == 'disk':
        with file.open('wb', buffering=0) as stream:
            for _ in range((target + 1048575)//1048576):
                try: stream.write(b'x' * min(1048576, target - stream.tell()))
                except OSError as error:
                    if error.errno not in (errno.ENOSPC, errno.EDQUOT): raise
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
    child.wait(timeout=timeout)
except subprocess.TimeoutExpired:
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try: os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        child.wait(timeout=2)
    pathlib.Path('/workspace/.ezh-qualification-load-' + str(child.pid)).unlink(missing_ok=True)
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
try:
    os.killpg(child.pid, 0)
    processes_absent = False
except ProcessLookupError:
    processes_absent = True
files_absent = not pathlib.Path('/workspace/.ezh-qualification-load-' + str(child.pid)).exists()
print(json.dumps({'attempted': target, 'observedLimit': observed, 'peak': peak,
    'limitEvents': events, 'childExit': child.returncode,
    'cleanupComplete': processes_absent and files_absent}))`;

function validBinding(binding: IncusLoadBudgetBinding): boolean {
  return Object.values(binding).every(value => typeof value === "string" && value.length > 0)
    && /^[a-f0-9]{64}$/.test(binding.presetDigest);
}

function approvedBudget(value: IncusHighLoadBudget | null, expected: IncusLoadBudgetBinding,
  limits: Record<Resource, number>, attempted: Record<Resource, number>, now: number): value is IncusHighLoadBudget {
  if (!value || !/^[A-Za-z0-9-]{8,128}$/.test(value.approvalId)
    || typeof value.approvedBy !== "string" || !value.approvedBy.trim()
    || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now
    || Date.parse(value.expiresAt) > now + 24 * 60 * 60 * 1000
    || !value.binding || !validBinding(value.binding)
    || Object.keys(expected).some(key => value.binding[key as keyof IncusLoadBudgetBinding]
      !== expected[key as keyof IncusLoadBudgetBinding])
    || !Number.isSafeInteger(value.maxDeadlineMs) || value.maxDeadlineMs < 10_000
    || value.maxDeadlineMs > 120_000) return false;
  return ORDER.every(resource => value.expectedLimits?.[resource] === limits[resource]
    && Number.isSafeInteger(value.maxAttempted?.[resource])
    && value.maxAttempted[resource] >= attempted[resource]
    && value.maxAttempted[resource] <= HIGH_CAPS[resource]);
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function monitoredLoad(primary: LiveFixtureHandle, resource: Resource, target: number,
  timeoutMs: number, high: boolean, baseline: IncusLoadHealth, deps: IncusLoadProbeDependencies,
  samples: IncusLoadProbeResult["samples"]): Promise<LiveCommandResult> {
  const childTimeout = high ? Math.floor((timeoutMs - 5_000) / 1_000) : 8;
  const job = await deps.startGuestLoad(primary, ["python3", "-c", INCUS_LOAD_GUEST_SCRIPT,
    resource, String(target), String(childTimeout)], timeoutMs);
  requireProbe(job && typeof job.wait === "function" && typeof job.cancel === "function",
    `${resource} cancellable guest process is unavailable`);
  let settled = false;
  const outcome = Promise.resolve().then(() => job.wait())
    .then(value => ({ value, error: null }), error => ({ value: null, error }))
    .finally(() => { settled = true; });
  const deadline = Date.now() + timeoutMs + 1_000;
  let first = true;
  let failure: unknown;
  let result: LiveCommandResult | null = null;
  try {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, first ? 250 : 1_000));
      first = false;
      const sample = await bounded(deps.sampleHealth(primary), 3_000,
        `${resource} host or neighbor sample timed out`);
      samples.push({ resource, phase: "during", health: sample });
      requireProbe(healthy(sample, baseline, primary), `${resource} affected host or neighbor health`);
      if (settled) break;
      requireProbe(Date.now() < deadline, `${resource} guest process exceeded its deadline`);
    }
    const completed = await outcome;
    if (completed.error) throw completed.error;
    result = completed.value;
  } catch (error) {
    failure = error;
    try {
      await bounded(job.cancel(), 3_000, `${resource} cancellation timed out`);
      await bounded(outcome, 3_000, `${resource} did not stop after cancellation`);
    } catch (cancelError) {
      failure = new AggregateError([error, cancelError], `${resource} load and cancellation failed`);
    }
  }
  try {
    const cleanup = await bounded(deps.verifyCleanup(primary, resource), 3_000,
      `${resource} cleanup readback timed out`);
    requireProbe(cleanup.filesAbsent && cleanup.processesAbsent, `${resource} cleanup readback failed`);
  } catch (cleanupError) {
    failure = failure
      ? new AggregateError([failure, cleanupError], `${resource} load and cleanup failed`) : cleanupError;
  }
  if (failure) throw failure;
  requireProbe(result, `${resource} guest result is unavailable`);
  return result;
}

/** Executes bounded loads. Every fact must be measured, with an independent neighbor. */
export async function exerciseIncusControlledLoads(
  primary: LiveFixtureHandle, preset: SandboxPreset, deps: IncusLoadProbeDependencies,
  options: IncusLoadProbeOptions = {},
): Promise<IncusLoadProbeResult> {
  const limits = { memory: preset.limits.memoryBytes, cpu: preset.limits.cpuMillis,
    pids: preset.limits.pids, disk: preset.limits.diskBytes };
  const attempted = { memory: limits.memory + 1024 * 1024, cpu: limits.cpu + 1_000,
    pids: limits.pids + 1, disk: limits.disk + 1024 * 1024 };
  const high = ORDER.some(resource => !finite(limits[resource]) || attempted[resource] > CAPS[resource]);
  let deadlineMs = TIMEOUT_MS;
  if (high) {
    const scope = options.scope;
    requireProbe(scope && deps.resolveApprovedBudget && deps.verifyCleanup,
      "high-load mode requires a host-owned operator approval and cleanup readback");
    const binding: IncusLoadBudgetBinding = { ...scope, presetId: preset.id,
      presetDigest: await sandboxPresetDigest(preset), sandboxId: primary.sandboxId };
    requireProbe(validBinding(binding), "high-load scope is invalid");
    const budget = await deps.resolveApprovedBudget(binding);
    requireProbe(approvedBudget(budget, binding, limits, attempted, (options.now ?? Date.now)()),
      "high-load approval is absent, stale, or bound to another fixture or limit");
    deadlineMs = budget.maxDeadlineMs;
  }
  for (const resource of ORDER) {
    requireProbe(finite(limits[resource]) && limits[resource] > 0
      && attempted[resource] <= (high ? HIGH_CAPS[resource] : CAPS[resource]),
    `${resource} limit exceeds the reviewed safety cap`);
  }
  const baseline = await deps.sampleHealth(primary);
  requireProbe(healthy(baseline, baseline, primary), "host or independent neighbor baseline is unhealthy");
  if (high) requireProbe(baseline.hostAvailableBytes >= attempted.memory + HIGH_RAM_MARGIN
    && baseline.hostDiskFreeBytes >= attempted.disk + HIGH_DISK_MARGIN
    && baseline.hostAvailablePids >= attempted.pids + HIGH_PID_MARGIN,
  "Xeon RAM, storage pool, or PID headroom is insufficient for approved load");
  const samples: IncusLoadProbeResult["samples"] = [{ resource: "baseline", phase: "before", health: baseline }];
  const readouts: IncusLoadProbeResult["readouts"] = [];
  const facts: LiveLimitLoadFact[] = [];
  for (const resource of ORDER) {
    const target = attempted[resource];
    const result = await monitoredLoad(primary, resource, target, deadlineMs, high,
      baseline, deps, samples);
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
      && parsed.attempted === target && finite(observedLimit)
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
    if (high) {
      requireProbe(followup.hostAvailableBytes >= HIGH_RAM_MARGIN
        && followup.hostDiskFreeBytes >= HIGH_DISK_MARGIN
        && followup.hostAvailablePids >= HIGH_PID_MARGIN,
      `${resource} left the host below its safety margin`);
    }
    const metric = resource === "cpu" ? "cpu.usage_usec"
      : resource === "memory" ? "memory.peak" : resource === "pids" ? "pids.peak" : "disk.enospc";
    readouts.push({ resource, attempted: target, observedLimit: Number(observedLimit),
      metric, metricValue: Number(parsed.peak), limitEvents: Number(parsed.limitEvents),
      childExit: Number(childExit), cleanupComplete: true });
    facts.push({ resource, attempted: target, observedLimit: Number(observedLimit),
      contained: true, neighborHealthy: true, hostHealthy: true });
  }
  return { facts, samples, readouts };
}
