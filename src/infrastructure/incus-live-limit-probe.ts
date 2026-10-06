import type { SandboxPreset } from "@ezcorp/extension-contract";
import type { LiveCommandResult, LiveEnforcementFacts, LiveFixtureHandle, LiveLimitLoadFact } from "./incus-live-cases";

type Resource = LiveLimitLoadFact["resource"];

export interface IncusLimitProbeDependencies {
  /** Calls the protected, exact-fixture process transport. */
  runGuest: (handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number) => Promise<LiveCommandResult>;
  /** Reads the neighbor through the pinned Incus API and runs a guest canary. */
  neighborHealthy: () => Promise<boolean>;
  /** Checks the pinned Incus management endpoint from the host. */
  hostHealthy: () => Promise<boolean>;
  /** Reads available bytes from the Incus host storage pool, not guest statvfs. */
  hostStorageFreeBytes: () => Promise<number>;
}

function requireLimit(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus limit probe unavailable: ${message}`);
}

// The process supervisor gives this script a hard 110-second deadline. Every
// child has a shorter lifetime; an interrupted parent cannot leave a lasting
// load. The disk file is unlinked before allocation, even if the guest exits.
export const LIMIT_PROBE_SCRIPT = `import errno,json,math,os,pathlib,signal,subprocess,sys,time
cg=pathlib.Path('/sys/fs/cgroup')
mode=sys.argv[1]; target=int(sys.argv[2]); limit=int(sys.argv[3])
def number(name):
 return int((cg/name).read_text(encoding='ascii').strip())
def event(name,key):
 return int(dict(line.split() for line in (cg/name).read_text(encoding='ascii').splitlines()).get(key,'0'))
def cpu():
 q,p=(cg/'cpu.max').read_text(encoding='ascii').split()
 return int(int(q)*1000/int(p))
def observed():
 return {'memory':number('memory.max'),'cpu':cpu(),'pids':number('pids.max'),'disk':limit}[mode]
actual=observed()
if actual!=limit or target<=actual: raise RuntimeError('observed limit changed')
contained=False; detail={}
if mode=='memory':
 before=event('memory.events','oom_kill')
 child='import mmap,pathlib,sys,time\\npathlib.Path("/proc/self/oom_score_adj").write_text("500")\\nwith mmap.mmap(-1,int(sys.argv[1]),flags=mmap.MAP_PRIVATE|mmap.MAP_ANONYMOUS) as region:\\n for offset in range(0,len(region),mmap.PAGESIZE): region[offset]=1\\n time.sleep(1)'
 result=subprocess.run([sys.executable,'-c',child,str(target)],timeout=70,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 after=event('memory.events','oom_kill')
 contained=result.returncode!=0 and after>before
 detail={'oomKillDelta':after-before,'childExit':result.returncode}
elif mode=='cpu':
 def cpus(text):
  values=set()
  for part in text.strip().split(','):
   span=[int(value) for value in part.split('-')]
   values.update(range(span[0],span[-1]+1))
  if not values or len(values)>4096: raise RuntimeError('invalid effective cpuset')
  return values
 def cpuset(): return cpus((cg/'cpuset.cpus.effective').read_text(encoding='ascii'))
 placement=cpuset(); online=cpus(pathlib.Path('/sys/devices/system/cpu/online').read_text(encoding='ascii')); quota_text=(cg/'cpu.max').read_text(encoding='ascii').strip()
 quota,period=map(int,quota_text.split()); original=os.sched_getaffinity(0)
 start=time.monotonic(); before=event('cpu.stat','nr_throttled'); usage_before=event('cpu.stat','usage_usec')
 workers=[]; failures=0; worker_cpu=0; confined=False
 try:
  # lxcfs may expose only the cpuset. outsideCpuCount records whether this
  # request includes an outside CPU; confinement does not imply a denied enlargement.
  os.sched_setaffinity(0,online)
  granted=os.sched_getaffinity(0); confined=bool(granted) and granted<=placement
  for _ in range(max(2,math.ceil(target/1000))):
   workers.append(subprocess.Popen([sys.executable,'-c','import time\\nstart=time.process_time_ns(); e=time.monotonic()+4\\nwhile time.monotonic()<e: pass\\nprint((time.process_time_ns()-start)//1000)'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL))
  for worker in workers:
   output,_=worker.communicate(timeout=12)
   value=int(output.strip()) if len(output)<=32 and output.strip().isdigit() else 0
   failures+=int(worker.returncode!=0 or value<=0); worker_cpu+=value
 finally:
  for worker in workers:
   if worker.poll() is None: worker.kill()
  for worker in workers: worker.wait()
  os.sched_setaffinity(0,original)
 after=event('cpu.stat','nr_throttled'); usage=event('cpu.stat','usage_usec')-usage_before
 elapsed=time.monotonic()-start
 unchanged=quota_text==(cg/'cpu.max').read_text(encoding='ascii').strip() and placement==cpuset()
 bounded=usage>0 and usage<=quota*(math.ceil(elapsed*1000000/period)+1)
 placement_proof=limit%1000==0 and len(placement)*1000<=limit and confined
 contained=unchanged and failures==0 and worker_cpu>0 and bounded and elapsed>=3 and (after>before or placement_proof)
 detail={'throttledDelta':after-before,'elapsedMs':math.ceil(elapsed*1000),'quotaMicros':quota,'periodMicros':period,'cpusetCount':len(placement),'affinityCount':len(granted),'outsideCpuCount':len(online-placement),'workerCount':len(workers),'workerFailures':failures,'workerCpuUsec':worker_cpu,'usageDeltaUsec':usage,'controlsUnchanged':unchanged,'affinityConfined':confined}
elif mode=='pids':
 before=event('pids.events','max'); children=[]; denied=False
 try:
  for _ in range(target):
   try: pid=os.fork()
   except OSError as exc:
    denied=exc.errno==errno.EAGAIN
    break
   if pid==0:
    time.sleep(15); os._exit(0)
   children.append(pid)
 finally:
  for pid in children:
   try: os.kill(pid,signal.SIGKILL)
   except ProcessLookupError: pass
  for pid in children:
   try: os.waitpid(pid,0)
   except ChildProcessError: pass
 after=event('pids.events','max'); contained=denied and after>before
 detail={'denialEventDelta':after-before,'spawned':len(children)}
elif mode=='disk':
 import tempfile
 fd,path=tempfile.mkstemp(prefix='.ezh-limit-',dir='/workspace')
 os.unlink(path)
 denied=False; code=0
 try:
  try: os.posix_fallocate(fd,0,target)
  except OSError as exc:
   code=exc.errno; denied=code in (errno.ENOSPC,errno.EDQUOT)
 finally: os.close(fd)
 contained=denied; detail={'errno':code}
else: raise RuntimeError('invalid resource')
print(json.dumps({'resource':mode,'attempted':target,'observedLimit':actual,'contained':contained,'detail':detail},separators=(',',':')))
`;

const TIMEOUT_MS = 110_000;
const RESOURCES: readonly Resource[] = ["memory", "cpu", "pids", "disk"];

/** Only the finite load identity crosses qualification's diagnostic boundary. */
export function incusLimitResource(value: unknown): Resource | null {
  return RESOURCES.find(resource => resource === value) ?? null;
}
export class IncusLimitLoadFailure extends Error {
  readonly resource: Resource;
  #failure: unknown;
  constructor(resource: Resource, failure: unknown) {
    super("Incus limit load failed");
    const selected = incusLimitResource(resource);
    requireLimit(selected, "invalid load diagnostic resource");
    this.resource = selected;
    this.#failure = failure;
  }
  failure(): unknown { return this.#failure; }
}

export interface IncusCpuLoadDiagnostic {
  throttledDelta: number; elapsedMs: number; quotaMicros: number; periodMicros: number;
  cpusetCount: number; affinityCount: number; outsideCpuCount: number; workerCount: number; workerFailures: number;
  workerCpuUsec: number; usageDeltaUsec: number; controlsUnchanged: boolean; affinityConfined: boolean;
}
const CPU_NUMBERS = ["throttledDelta", "elapsedMs", "quotaMicros", "periodMicros", "cpusetCount", "affinityCount", "outsideCpuCount", "workerCount", "workerFailures", "workerCpuUsec", "usageDeltaUsec"] as const;
/** Closed numeric fields only; never return arbitrary guest stdout or error text. */
export function incusCpuLoadDiagnostic(value: unknown): IncusCpuLoadDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!CPU_NUMBERS.every(key => Number.isSafeInteger(input[key]) && Number(input[key]) >= 0 && Number(input[key]) <= 1_000_000_000_000)
    || typeof input.controlsUnchanged !== "boolean" || typeof input.affinityConfined !== "boolean") return null;
  return Object.fromEntries([...CPU_NUMBERS, "controlsUnchanged", "affinityConfined"].map(key => [key, input[key]])) as unknown as IncusCpuLoadDiagnostic;
}
export class IncusCpuLoadProofError extends Error {
  constructor(readonly diagnostic: IncusCpuLoadDiagnostic | null) { super("Incus limit probe unavailable: cpu load did not prove containment"); }
}
function cpuEvidence(detail: Record<string, unknown>, limit: number, attempted: number): boolean {
  const value = incusCpuLoadDiagnostic(detail);
  if (!value?.controlsUnchanged || !value.affinityConfined || value.periodMicros <= 0 || value.quotaMicros <= 0) return false;
  const budgetMillis = value.quotaMicros * 1000 / value.periodMicros;
  if (budgetMillis !== limit) return false;
  const placementProof = Number.isInteger(budgetMillis / 1000) && value.cpusetCount * 1000 <= budgetMillis;
  // An arbitrarily aligned window intersects at most ceil(window/period)+1 periods.
  const ceiling = value.quotaMicros * (Math.ceil(value.elapsedMs * 1000 / value.periodMicros) + 1);
  return value.elapsedMs >= 3000 && value.elapsedMs <= TIMEOUT_MS && value.workerCount === Math.max(2, Math.ceil(attempted / 1000))
    && value.workerFailures === 0 && value.workerCpuUsec > 0 && value.usageDeltaUsec >= value.workerCpuUsec
    && value.usageDeltaUsec <= ceiling && value.cpusetCount > 0 && value.affinityCount > 0
    && value.affinityCount <= value.cpusetCount && (value.throttledDelta > 0 || placementProof);
}

function evidence(resource: Resource, detail: Record<string, unknown>, attempted: number, limit: number): boolean {
  if (resource === "memory") return Number.isSafeInteger(detail.oomKillDelta) && Number(detail.oomKillDelta) > 0
    && Number.isSafeInteger(detail.childExit) && Number(detail.childExit) !== 0;
  if (resource === "cpu") return cpuEvidence(detail, limit, attempted);
  if (resource === "pids") return Number.isSafeInteger(detail.denialEventDelta)
    && Number(detail.denialEventDelta) > 0 && Number.isSafeInteger(detail.spawned)
    && Number(detail.spawned) >= 0 && Number(detail.spawned) < attempted;
  return detail.errno === 28 || detail.errno === 122;
}

function observed(resource: Resource, facts: LiveEnforcementFacts): number {
  return resource === "memory" ? facts.memoryMaxBytes : resource === "cpu" ? facts.cpuQuotaMillis
    : resource === "pids" ? facts.pidsMax : facts.rootQuotaBytes;
}

function requested(resource: Resource, preset: SandboxPreset): number {
  const bound = reviewed(resource, preset);
  const margin = resource === "memory" || resource === "disk" ? 16 * 1024 * 1024
    : resource === "cpu" ? 1_000 : 1;
  requireLimit(Number.isSafeInteger(bound) && Number.isSafeInteger(bound + margin), `${resource} request is unsafe`);
  return bound + margin;
}

function reviewed(resource: Resource, preset: SandboxPreset): number {
  return resource === "memory" ? preset.limits.memoryBytes : resource === "cpu" ? preset.limits.cpuMillis
    : resource === "pids" ? preset.limits.pids : preset.limits.diskBytes;
}

/** Performs real over-limit guest loads and independently rechecks host and neighbor after each. */
export async function exerciseIncusLimits(handle: LiveFixtureHandle, preset: SandboxPreset,
  facts: LiveEnforcementFacts, deps: IncusLimitProbeDependencies): Promise<LiveLimitLoadFact[]> {
  const result: LiveLimitLoadFact[] = [];
  for (const resource of RESOURCES) {
    const limit = observed(resource, facts);
    const attempted = requested(resource, preset);
    requireLimit(Number.isSafeInteger(limit) && limit > 0 && limit <= reviewed(resource, preset)
      && attempted > limit,
      `${resource} observed limit or requested load is invalid`);
    requireLimit(await deps.hostHealthy() && await deps.neighborHealthy(),
      `host or neighbor was unhealthy before ${resource} load`);
    const poolFreeBefore = resource === "disk" ? await deps.hostStorageFreeBytes() : null;
    if (resource === "disk") requireLimit(Number.isSafeInteger(poolFreeBefore)
      && poolFreeBefore! > attempted + 32 * 1024 * 1024,
    "host storage pool has insufficient independent free space for the quota probe");
    let run: LiveCommandResult;
    try {
      run = await deps.runGuest(handle,
        ["python3", "-c", LIMIT_PROBE_SCRIPT, resource, String(attempted), String(limit)], TIMEOUT_MS);
    } catch (error) { throw new IncusLimitLoadFailure(resource, error); }
    requireLimit(run.exitCode === 0 && run.stderr.length === 0 && run.stdout.length <= 4096,
      `${resource} load did not finish cleanly`);
    let proof: Record<string, unknown>;
    try { proof = JSON.parse(run.stdout); }
    catch { throw new Error(`Incus limit probe unavailable: ${resource} load returned invalid JSON`); }
    if (resource === "cpu" && (proof?.contained !== true || !cpuEvidence(proof.detail as Record<string, unknown>, limit, attempted))) {
      throw new IncusCpuLoadProofError(incusCpuLoadDiagnostic(proof?.detail));
    }
    requireLimit(proof && typeof proof === "object" && !Array.isArray(proof)
      && proof.resource === resource && proof.attempted === attempted
      && proof.observedLimit === limit && proof.contained === true
      && proof.detail && typeof proof.detail === "object" && !Array.isArray(proof.detail)
      && evidence(resource, proof.detail as Record<string, unknown>, attempted, limit),
    `${resource} load did not prove containment`);
    const hostHealthy = await deps.hostHealthy();
    const neighborHealthy = await deps.neighborHealthy();
    requireLimit(hostHealthy && neighborHealthy, `${resource} load affected host or neighbor`);
    if (resource === "disk") {
      const poolFreeAfter = await deps.hostStorageFreeBytes();
      requireLimit(Number.isSafeInteger(poolFreeAfter) && poolFreeAfter > attempted
        && poolFreeBefore! - poolFreeAfter <= 64 * 1024 * 1024,
      "host storage pool did not recover after the quota probe");
    }
    result.push({ resource, attempted, observedLimit: limit, contained: true, hostHealthy, neighborHealthy });
  }
  return result;
}
