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
 child='import pathlib,sys,time\\npathlib.Path("/proc/self/oom_score_adj").write_text("500")\\na=[]\\nfor i in range(0,int(sys.argv[1]),16777216):\\n b=bytearray(min(16777216,int(sys.argv[1])-i))\\n for p in range(0,len(b),4096): b[p]=1\\n a.append(b)\\ntime.sleep(1)'
 result=subprocess.run([sys.executable,'-c',child,str(target)],timeout=70,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 after=event('memory.events','oom_kill')
 contained=result.returncode!=0 and after>before
 detail={'oomKillDelta':after-before,'childExit':result.returncode}
elif mode=='cpu':
 before=event('cpu.stat','nr_throttled'); start=time.monotonic()
 workers=[]
 try:
  for _ in range(max(2,math.ceil(target/1000))):
   workers.append(subprocess.Popen([sys.executable,'-c','import time\\ne=time.monotonic()+4\\nwhile time.monotonic()<e: pass'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
  for worker in workers: worker.wait(timeout=12)
 finally:
  for worker in workers:
   if worker.poll() is None: worker.kill()
  for worker in workers: worker.wait()
 elapsed=time.monotonic()-start; after=event('cpu.stat','nr_throttled')
 contained=after>before and elapsed>=3
 detail={'throttledDelta':after-before,'elapsedMs':round(elapsed*1000)}
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

function evidence(resource: Resource, detail: Record<string, unknown>, attempted: number): boolean {
  if (resource === "memory") return Number.isSafeInteger(detail.oomKillDelta) && Number(detail.oomKillDelta) > 0
    && Number.isSafeInteger(detail.childExit) && Number(detail.childExit) !== 0;
  if (resource === "cpu") return Number.isSafeInteger(detail.throttledDelta)
    && Number(detail.throttledDelta) > 0 && Number.isSafeInteger(detail.elapsedMs)
    && Number(detail.elapsedMs) >= 3000 && Number(detail.elapsedMs) <= TIMEOUT_MS;
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
    const run = await deps.runGuest(handle,
      ["python3", "-c", LIMIT_PROBE_SCRIPT, resource, String(attempted), String(limit)], TIMEOUT_MS);
    requireLimit(run.exitCode === 0 && run.stderr.length === 0 && run.stdout.length <= 4096,
      `${resource} load did not finish cleanly`);
    let proof: Record<string, unknown>;
    try { proof = JSON.parse(run.stdout); }
    catch { throw new Error(`Incus limit probe unavailable: ${resource} load returned invalid JSON`); }
    requireLimit(proof && typeof proof === "object" && !Array.isArray(proof)
      && proof.resource === resource && proof.attempted === attempted
      && proof.observedLimit === limit && proof.contained === true
      && proof.detail && typeof proof.detail === "object" && !Array.isArray(proof.detail)
      && evidence(resource, proof.detail as Record<string, unknown>, attempted),
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
