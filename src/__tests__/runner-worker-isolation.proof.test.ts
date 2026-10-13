/**
 * Release proof: the extension runner's worker isolation.
 *
 * Since #246 every extension and MCP server runs in a runner worker (rootless
 * Podman), not on the app host. This proof replaces the old host "Stage 2"
 * namespace proof in the shipping suite (`namespace` proof). It drives the
 * production `PodmanRunner` container argv and checks, from inside a worker:
 *
 *   - network:  only `lo`; a raw TCP connect and a UDP send to the internet fail
 *   - seccomp:  a syscall outside the deny-by-default profile (add_key) fails
 *               with ENOSYS, while an allowed one (getpid) works
 *   - fs:       the image root is read-only (a world-writable dir gets EROFS)
 *   - privilege: uid 65534, no capabilities, no-new-privileges
 *   - cgroups:  memory and PID limits are the requested ones
 *   - processes: a worker without the shell grant ("deny") cannot start a
 *               process but can start a thread; an "allow" worker can start one
 *   - parent:   the shim that spawned the worker is non-dumpable after the spawn
 *               (PR_GET_DUMPABLE is 0), so the worker is refused a read-only
 *               open of /proc/<ppid>/mem. This is a permission check only: the
 *               proof opens read-only, closes at once, and never reads or writes.
 *               Both arms make the shim PR_SET_PTRACER_ANY, as Yama scope 0
 *               would, so the refusal comes from the non-dumpable shim alone.
 *
 * Each live control has a FAULT ARM: the same probe through a podman wrapper
 * that drops one flag must show the weakness (the proof can go red), and the
 * runner's own fail-closed startup must refuse that weakened runner.
 *
 * Live parts need rootless Podman with the pinned runner image, so they run
 * only with EZCORP_RUNNER_ISOLATION_PROOF=1 (the shipping suite's `namespace`
 * proof). The argv and fail-closed startup checks below run everywhere, with
 * a recording fake `podman`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PodmanRunner, buildLimits, executionLimits, filesDigest, provisionToolchain, type PodmanRunnerOptions } from "@ezcorp/extension-runner";
import type { ProcessSpawnPolicy } from "@ezcorp/extension-contract";
import { source } from "../../packages/@ezcorp/extension-runner/tests/helpers";
import { BUN_SHIM_UNDUMPABLE } from "../../packages/@ezcorp/extension-runner/src/spawn-guard";

const liveEnabled = process.env.EZCORP_RUNNER_ISOLATION_PROOF === "1";
if (!liveEnabled) console.warn("[runner-isolation-proof] live arms SKIPPED: set EZCORP_RUNNER_ISOLATION_PROOF=1 on a host with rootless Podman");

const SECCOMP_PROFILE = resolve(import.meta.dir, "../../packages/@ezcorp/extension-runner/seccomp.json");
const LIMITS = { ...executionLimits, memoryBytes: 256 * 1024 ** 2, pids: 48, timeoutMs: 60_000 };
const ENOSYS = 38;

/** Runs inside the worker as `bun -e`; prints one JSON observation. */
const PROBE = `(async()=>{
const fs=require("node:fs"),net=require("node:net"),dgram=require("node:dgram"),os=require("node:os");
const read=p=>{try{return fs.readFileSync(p,"utf8").trim()}catch(e){return "ERR:"+e.code}};
const tcp=(host,port)=>new Promise(done=>{const s=net.connect({host,port});const t=setTimeout(()=>{s.destroy();done("timeout")},4000);s.once("connect",()=>{clearTimeout(t);s.destroy();done("connected")});s.once("error",e=>{clearTimeout(t);done(e.code)})});
const udp=()=>new Promise(done=>{const s=dgram.createSocket("udp4");s.send(Buffer.from("x"),53,"8.8.8.8",e=>{s.close();done(e?e.code:"sent")})});
let rootWrite="ok";try{fs.writeFileSync("/var/tmp/runner-proof","x")}catch(e){rootWrite=e.code}
let seccomp;try{const {dlopen,FFIType,read:mem}=require("bun:ffi");const nr={x64:{add_key:248,getpid:39},arm64:{add_key:217,getpid:172}}[process.arch];
const libc=dlopen("libc.so.6",{syscall:{args:[FFIType.i64,FFIType.i64,FFIType.i64,FFIType.i64,FFIType.i64,FFIType.i64],returns:FFIType.i64},__errno_location:{args:[],returns:FFIType.ptr}});
const pid=Number(libc.symbols.syscall(nr.getpid,0,0,0,0,0));const ret=Number(libc.symbols.syscall(nr.add_key,0,0,0,0,0));
seccomp={getpidWorks:pid===process.pid,addKeyRet:ret,addKeyErrno:mem.i32(libc.symbols.__errno_location())}}catch(e){seccomp={error:String(e)}}
console.log(JSON.stringify({uid:process.getuid(),status:read("/proc/self/status"),interfaces:Object.keys(os.networkInterfaces()).sort(),
tcp:await tcp("1.1.1.1",443),udp:await udp(),rootWrite,seccomp,memoryMax:read("/sys/fs/cgroup/memory.max"),pidsMax:read("/sys/fs/cgroup/pids.max")}));
})()`;

interface Observation {
  uid: number;
  status: string;
  interfaces: string[];
  tcp: string;
  udp: string;
  rootWrite: string;
  seccomp: { getpidWorks?: boolean; addKeyRet?: number; addKeyErrno?: number; error?: string };
  memoryMax: string;
  pidsMax: string;
}

/** The production runner, plus one worker launch through its real argv. */
class ProofRunner extends PodmanRunner {
  /** Runs one program in a worker container through the production argv. */
  async program(code: string): Promise<string> {
    const staged = await this.stage({});
    const id = `proof-${randomUUID()}`;
    try { return await this.run(id, LIMITS, staged, ["-e", code]); }
    finally { await this.remove(id); await rm(staged, { recursive: true, force: true }); }
  }
  async observe(): Promise<Observation> {
    return JSON.parse(await this.program(PROBE)) as Observation;
  }
}

/** A tool that tries to start a process and a thread, and reports both. */
const SPAWN_PROBE = `async () => { let spawn: string | number; try { spawn = Bun.spawnSync(["/bin/true"]).exitCode ?? "none"; } catch (error) { spawn = (error as { code?: string }).code ?? "error"; } const thread = await new Promise(resolve => { const worker = new Worker(URL.createObjectURL(new Blob(["postMessage(7)"]))); worker.onmessage = event => { resolve(event.data); worker.terminate(); }; }); return { spawn, thread }; }`;

/** A tool that opens its parent's memory file read-only, closes it at once, and reports the outcome. */
const PARENT_PROBE = `async () => { try { const fs = require("node:fs"); fs.closeSync(fs.openSync(\`/proc/\${process.ppid}/mem\`, "r")); return { parentMem: "opened" }; } catch (error) { return { parentMem: (error as { code?: string }).code ?? "error" }; } }`;

/** Builds one tool, then invokes it in one worker per start. */
async function spawnObservation(target: PodmanRunner, processSpawn?: ProcessSpawnPolicy, handler = SPAWN_PROBE): Promise<unknown> {
  const files = source(handler);
  const build = await target.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: build.artifactDigest!, principalId: "proof", scopeId: "proof", token: "proof", deadline: Date.now() + 60_000 };
  const worker = await target.start({ workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits, ...(processSpawn ? { processSpawn } : {}) }, async () => null);
  try { return await worker.request("extension/invoke", { name: "echo", input: {}, context }); } finally { await worker.close(); }
}

/** FAULT ARM: a runner whose "deny" worker is launched without the guard. */
class UnguardedRunner extends ProofRunner {
  protected override workerArgs(_policy: ProcessSpawnPolicy): string[] { return super.workerArgs("allow"); }
}

/** PR_SET_PTRACER with PR_SET_PTRACER_ANY: what Yama scope 0 allows for every process. */
const SHIM_PTRACER_ANY = `require("bun:ffi").dlopen("libc.so.6",{prctl:{args:["i32","u64","u64","u64","u64"],returns:"i32"}}).symbols.prctl(0x59616d61,0xffffffffffffffffn,0,0,0);`;

/** The production shim, opened to any tracer the way Yama scope 0 would; `dumpable` is the FAULT ARM. */
function yamaZeroRunner(dumpable: boolean): typeof ProofRunner {
  return class extends ProofRunner {
    protected override guestEntrypointArgs(policy: ProcessSpawnPolicy): string[] {
      const [flag, shim] = super.guestEntrypointArgs(policy) as [string, string];
      if (!shim.startsWith(BUN_SHIM_UNDUMPABLE)) throw new Error("the shim no longer starts with its non-dumpable step");
      return [flag, `${dumpable ? "" : BUN_SHIM_UNDUMPABLE}${SHIM_PTRACER_ANY}${shim.slice(BUN_SHIM_UNDUMPABLE.length)}`];
    }
  };
}

/** Runs the shim's non-dumpable step in a worker container, spawns once, then reads PR_GET_DUMPABLE. */
const SHIM_DUMPABLE_PROBE = `${BUN_SHIM_UNDUMPABLE}const spawned=require("node:child_process").spawnSync(process.execPath,["--version"]).status;const dumpable=require("bun:ffi").dlopen("libc.so.6",{prctl:{args:["i32","u64","u64","u64","u64"],returns:"i32"}}).symbols.prctl(3,0,0,0,0);console.log(JSON.stringify({spawned,dumpable}));`;

/** A `podman` wrapper that rewrites one exact argument (drop it, or swap it). */
function weakenedPodman(dir: string, from: string, to: string | null): string {
  const path = join(dir, `podman-${randomUUID()}`);
  writeFileSync(path, `#!/usr/bin/env bash
set -euo pipefail
args=()
for a in "$@"; do
  if [[ "$a" == ${JSON.stringify(from)} ]]; then ${to === null ? ":" : `args+=(${JSON.stringify(to)})`}; else args+=("$a"); fi
done
exec podman "\${args[@]}"
`);
  chmodSync(path, 0o755);
  return path;
}

function storeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

/** The isolation every production worker must show. */
function expectIsolated(o: Observation): void {
  expect(o.uid).toBe(65534);
  expect(o.interfaces).toEqual(["lo"]);
  expect(["ENETUNREACH", "EHOSTUNREACH"]).toContain(o.tcp);
  expect(["ENETUNREACH", "EHOSTUNREACH"]).toContain(o.udp);
  expect(o.rootWrite).toBe("EROFS");
  expect(o.seccomp).toMatchObject({ getpidWorks: true, addKeyRet: -1, addKeyErrno: ENOSYS });
  expect(o.status).toMatch(/^CapEff:\s+0+$/m);
  expect(o.status).toMatch(/^NoNewPrivs:\s+1$/m);
  expect(o.status).toMatch(/^Seccomp:\s+2$/m);
  expect(o.memoryMax).toBe(String(LIMITS.memoryBytes));
  expect(o.pidsMax).toBe(String(LIMITS.pids));
}

describe.skipIf(!liveEnabled)("runner worker isolation (live)", () => {
  let dir: string;
  let toolchain: Partial<PodmanRunnerOptions>;
  const runners: PodmanRunner[] = [];
  const runner = (podman?: string, Kind: typeof ProofRunner = ProofRunner): ProofRunner => {
    const value = new Kind({ root: storeDir("runner-proof-store-"), ...toolchain, ...(podman ? { podman } : {}) });
    runners.push(value);
    return value;
  };

  beforeAll(async () => {
    dir = storeDir("runner-proof-");
    toolchain = await provisionToolchain();
  }, 120_000);
  afterAll(async () => {
    for (const value of runners) await value.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a production worker is isolated on every control", async () => {
    const secure = runner();
    await secure.initialize();
    expectIsolated(await secure.observe());
  }, 120_000);

  test("a worker without the shell grant cannot start a process but can start a thread; an allow worker can", async () => {
    const secure = runner();
    expect(await secure.capabilities()).toEqual({ processSpawnEnforcement: true });
    expect(await spawnObservation(secure)).toEqual({ spawn: "EPERM", thread: 7 });
    expect(await spawnObservation(secure, "allow")).toEqual({ spawn: 0, thread: 7 });
  }, 300_000);

  test("without the guard a deny worker starts a process", async () => {
    expect(await spawnObservation(runner(undefined, UnguardedRunner), "deny")).toEqual({ spawn: 0, thread: 7 });
  }, 300_000);

  test("the shim is non-dumpable after it spawns, so a non-shell worker cannot open its memory file", async () => {
    expect(JSON.parse(await runner().program(SHIM_DUMPABLE_PROBE))).toEqual({ spawned: 0, dumpable: 0 });
    const result = await spawnObservation(runner(undefined, yamaZeroRunner(false)), "deny", PARENT_PROBE) as { parentMem: string };
    expect(["EACCES", "EPERM"]).toContain(result.parentMem);
  }, 300_000);

  test("FAULT ARM: with a dumpable shim the same read-only open succeeds", async () => {
    expect(await spawnObservation(runner(undefined, yamaZeroRunner(true)), "deny", PARENT_PROBE)).toEqual({ parentMem: "opened" });
  }, 300_000);

  test("without --network=none the worker has a network, and startup refuses it", async () => {
    const weak = runner(weakenedPodman(dir, "--network=none", null));
    const o = await weak.observe();
    expect(o.interfaces).not.toEqual(["lo"]);
    await expect(weak.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
  }, 120_000);

  test("with an unconfined seccomp profile add_key no longer fails with ENOSYS, and startup refuses it", async () => {
    const weak = runner(weakenedPodman(dir, `--security-opt=seccomp=${SECCOMP_PROFILE}`, "--security-opt=seccomp=unconfined"));
    const o = await weak.observe();
    expect(o.seccomp.addKeyErrno).not.toBe(ENOSYS);
    await expect(weak.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
  }, 120_000);

  test("without --read-only the image root is writable, and startup refuses it", async () => {
    const weak = runner(weakenedPodman(dir, "--read-only", null));
    expect((await weak.observe()).rootWrite).toBe("ok");
    await expect(weak.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
  }, 120_000);
});

describe("runner worker isolation (argv and fail-closed startup)", () => {
  let dir: string;
  beforeAll(() => { dir = storeDir("runner-proof-fake-"); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake `podman`: records argv, answers `info`, and prints `{}` for `run`. */
  function fakePodman(info: unknown): { path: string; calls: () => string[][] } {
    const log = join(dir, `calls-${randomUUID()}.jsonl`);
    const path = join(dir, `fake-podman-${randomUUID()}`);
    writeFileSync(path, `#!/usr/bin/env bash
printf '%s\\n' "$(bun -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@")" >> ${JSON.stringify(log)}
case "$1" in
  info) printf '%s' ${JSON.stringify(JSON.stringify(info))} ;;
  run) printf '{}' ;;
esac
exit 0
`);
    chmodSync(path, 0o755);
    return {
      path,
      calls: () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]),
    };
  }

  const secureInfo = { host: { security: { rootless: true, seccompEnabled: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] } };

  test("every worker launch carries the isolation flags", async () => {
    const fake = fakePodman(secureInfo);
    const runner = new ProofRunner({ root: storeDir("runner-proof-store-"), podman: fake.path });
    try {
      await runner.observe();
    } finally {
      await runner.close();
    }
    const run = fake.calls().find((argv) => argv[0] === "run");
    expect(run).toBeDefined();
    for (const flag of [
      "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
      `--security-opt=seccomp=${SECCOMP_PROFILE}`, "--user=65534:65534", "--pid=private", "--ipc=private",
      `--memory=${LIMITS.memoryBytes}`, `--memory-swap=${LIMITS.memoryBytes}`, `--pids-limit=${LIMITS.pids}`,
    ]) {
      expect(run).toContain(flag);
    }
    expect(run!.some((arg) => arg.startsWith("--tmpfs=/tmp:") && arg.includes("noexec"))).toBe(true);
  });

  test("the shipped seccomp profile is deny-by-default and does not allow add_key", () => {
    const profile = JSON.parse(readFileSync(SECCOMP_PROFILE, "utf8")) as {
      defaultAction: string;
      defaultErrnoRet: number;
      syscalls: { names: string[]; action: string }[];
    };
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.defaultErrnoRet).toBe(ENOSYS);
    const allowed = new Set(profile.syscalls.filter((s) => s.action === "SCMP_ACT_ALLOW").flatMap((s) => s.names));
    expect(allowed.has("add_key")).toBe(false);
    expect(allowed.has("getpid")).toBe(true);
  });

  test.each([
    ["not rootless", { host: { ...secureInfo.host, security: { rootless: false, seccompEnabled: true } } }, "isolation_unavailable"],
    ["without seccomp", { host: { ...secureInfo.host, security: { rootless: true, seccompEnabled: false } } }, "isolation_unavailable"],
    ["on cgroup v1", { host: { ...secureInfo.host, cgroupVersion: "v1" } }, "isolation_unavailable"],
    ["without the pids controller", { host: { ...secureInfo.host, cgroupControllers: ["cpu", "memory"] } }, "isolation_unavailable"],
  ])("startup refuses a host that is %s", async (_label, info, code) => {
    const runner = new ProofRunner({ root: storeDir("runner-proof-store-"), podman: fakePodman(info).path });
    try {
      await expect(runner.initialize()).rejects.toMatchObject({ code });
    } finally {
      await runner.close();
    }
  });

  test("startup refuses a seccomp profile that is not deny-by-default", async () => {
    const permissive = join(dir, "permissive-seccomp.json");
    writeFileSync(permissive, JSON.stringify({ defaultAction: "SCMP_ACT_ALLOW", syscalls: [] }));
    const runner = new ProofRunner({ root: storeDir("runner-proof-store-"), podman: fakePodman(secureInfo).path, seccompPath: permissive });
    try {
      await expect(runner.initialize()).rejects.toMatchObject({ code: "seccomp_unavailable" });
    } finally {
      await runner.close();
    }
  });

  test("startup refuses when the worker probe does not match the secure profile", async () => {
    // The fake prints `{}` for the probe container: no uid, no limits.
    const runner = new ProofRunner({ root: storeDir("runner-proof-store-"), podman: fakePodman(secureInfo).path });
    try {
      await expect(runner.initialize()).rejects.toMatchObject({ code: "isolation_probe_failed" });
    } finally {
      await runner.close();
    }
  });
});
