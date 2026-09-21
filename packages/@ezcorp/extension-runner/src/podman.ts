import { mkdir, mkdtemp, writeFile, readFile, rename, rm, chmod, lstat, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BuildResult, InvocationContext, ResourceLimits, Runner, RunnerInspection, StartRequest, WorkspaceFiles } from "@ezcorp/extension-contract";
import { canonicalJson, validateInvocationContext, validateManifest, workspaceFileBytes, workspaceText } from "@ezcorp/extension-contract";
import { buildLimits, capture, command, digest, executionLimits, filesDigest, identifier, limitsWithin, processSpawn, relativePath, RunnerError, sha256, validateFiles } from "./core";
import { FramedExecution, type FramedTransport, type ReverseRpc } from "./protocol";
import { fetchLockedDependencies } from "./dependencies";
import { browserBuild, browserBuilderProgram } from "./browser";

export const DEFAULT_IMAGE = "docker.io/oven/bun@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834";
const seccompDefault = new URL("../seccomp.json", import.meta.url).pathname;
/**
 * The sandbox's init process. It holds the three control FIFOs open for the
 * guest's whole life and spawns the extension as its child.
 *
 * It must install a SIGTERM handler: the kernel applies no default signal
 * action to PID 1, so without one a graceful stop is silently ignored and every
 * cancellation has to be resolved by a kill. The handler forwards the signal to
 * the extension, which is not PID 1 and so does take the default action, and
 * the existing exit relay ends the sandbox as soon as it goes.
 */
const guestShim = `const fs=require("node:fs");const cp=require("node:child_process");const i=fs.openSync("/channel/in","r+"),o=fs.openSync("/channel/out","r+"),e=fs.openSync("/channel/err","r+");const c=cp.spawn(process.execPath,["./.runner/extension.js"],{stdio:[i,o,e]});c.on("exit",code=>process.exit(code===null?1:code));c.on("error",()=>process.exit(1));for(const s of["SIGTERM","SIGINT"])process.on(s,()=>{try{c.kill(s)}catch{process.exit(143)}});`;
const probeProgramSource = `const fs=require("node:fs");const read=p=>fs.readFileSync(p,"utf8").trim(); const status=read("/proc/self/status");let writable=false;try{fs.writeFileSync("/root-write-probe","x");writable=true}catch{} console.log(JSON.stringify({uid:process.getuid(),status,memory:read("/sys/fs/cgroup/memory.max"),swap:read("/sys/fs/cgroup/memory.swap.max"),cpu:read("/sys/fs/cgroup/cpu.max"),pids:read("/sys/fs/cgroup/pids.max"),routes:read("/proc/net/route"),ipv6:read("/proc/net/ipv6_route"),writable}));`;
/**
 * The guest's environment is exactly `HOME`, `TMPDIR`, `BUN_INSTALL_CACHE_DIR`
 * and `PATH`. `--unsetenv-all` drops the image's own `ENV`, which otherwise
 * reached every guest: measured on the pinned images, that was `PATH`,
 * `container`, and the interpreter's build metadata. Two variables remain
 * because the OCI runtime writes them into the process after podman has built
 * the spec, and `--unsetenv` cannot reach them: `LC_CTYPE=C.UTF-8`, and
 * `HOSTNAME`, which is pinned to a fixed value below so it cannot carry the
 * container's host-derived identity.
 */
const GUEST_HOSTNAME = "guest";
/**
 * Where a per-attempt material directory appears inside a guest.
 *
 * It is a fixed path, not an environment variable, because the profile declares
 * a guest exactly four variables and this is not one of them.
 */
export const GUEST_MATERIALS_PATH = "/materials";
/** Exactly the four variables the profile declares. Every guest has all four. */
export const RUNNER_GUEST_ENVIRONMENT = Object.freeze(["BUN_INSTALL_CACHE_DIR", "HOME", "PATH", "TMPDIR"]);
/**
 * The only names a guest may carry beyond the four declared ones. The OCI
 * runtime writes them after podman has built the spec, so `--unsetenv` cannot
 * reach them, and which of the two appears depends on the image. Both carry
 * fixed, tenant-independent values: the hostname is pinned above and the locale
 * is the C UTF-8 default.
 */
export const RUNNER_GUEST_ENVIRONMENT_RESIDUE = Object.freeze(["HOSTNAME", "LC_CTYPE"]);
const CHANNEL_FIFOS = ["in", "out", "err"] as const;
/** Traversable and readable by the mapped guest uid, writable by nobody but the runner. */
const CHANNEL_DIRECTORY_MODE = 0o755;
/** The guest opens the FIFO inodes read-write; only these three inodes carry that mode. */
const CHANNEL_FIFO_MODE = 0o666;

/**
 * The per-attempt material mount, and the only read-write mount a guest gets.
 *
 * It exists because the control channel is not a data path: a guest may emit at
 * most `min(limits.outputBytes, 1 MiB)` over its whole life, and a domain pack's
 * real output is larger than that. The guest writes ordinary files here and the
 * host reads them back afterwards.
 *
 * `noexec`, `nosuid`, and `nodev` keep it at the same posture the `/tmp` tmpfs
 * already carries, so the two writable surfaces a guest has agree. Execution was
 * denied without `noexec` on the host this was measured on, but by that
 * filesystem's own flags rather than by anything this profile guarantees.
 *
 * Nothing here widens what a guest can reach: no device, no network, no host
 * path outside the directory, and no credential. What it does widen is what a
 * guest can WRITE, and a guest can create a symbolic link in its own directory,
 * which was measured rather than assumed. So the host must read the result back
 * only through `listRunnerMaterials` and `openRunnerMaterial`, never by walking
 * the tree itself, and the caller that creates the directory must not make it
 * world-writable.
 */
/** The uid a guest runs as, and therefore the uid that must own its material directory. */
const GUEST_UID = 65534;
/** Owner read, write, and traverse for the guest; the same for the runner's group; nothing for anyone else. */
const MATERIAL_DIRECTORY_MODE = 0o770;

export function runnerMaterialMount(directory: string): string[] {
  return ["--mount", `type=bind,src=${directory},dst=${GUEST_MATERIALS_PATH},rw=true,relabel=private,noexec,nosuid,nodev`];
}

/**
 * The guest's control-channel mount. It is read-only: a FIFO may still be opened
 * for reading and writing on a read-only mount, because the kernel's EROFS check
 * covers directory-entry changes and regular files, not passing data through a
 * pipe. That keeps the channel usable while denying the guest any way to unlink,
 * rename, or replace an entry the host later opens by name.
 */
export function runnerChannelMount(directory: string): string[] {
  return ["--mount", `type=bind,src=${directory},dst=/channel,ro=true,relabel=private`];
}

interface ChannelInode { readonly device: number; readonly inode: number }

const builderProgram = `const result = await Bun.build({entrypoints:[process.argv[1]],target:"bun",format:"esm",packages:"bundle",minify:false,sourcemap:"none"}); if(!result.success){console.error(JSON.stringify(result.logs));process.exit(1);} console.log(JSON.stringify({code:await result.outputs[0].text()}));`;
const testProgram = `const child=Bun.spawn([process.execPath,"test","--config=/dev/null",process.argv[1],"--timeout",process.argv[2],"--bail","--reporter=junit","--reporter-outfile=/tmp/feature-tests.xml"],{stdout:"inherit",stderr:"inherit"});const code=await child.exited;if(code!==0)process.exit(code);const report=await Bun.file('/tmp/feature-tests.xml').text();const root=report.match(/<testsuites\\b[^>]*>/)?.[0]??report.match(/<testsuite\\b[^>]*>/)?.[0]??'';const count=Number(root.match(/\\btests="(\\d+)"/)?.[1]);if(!count||/<skipped\\b|<failure\\b|<error\\b/.test(report)||/\\b(?:failures|errors|skipped)="[1-9]/.test(root)){console.error('Feature tests missing, skipped, or failed');process.exit(1)}`;

export interface PodmanRunnerOptions {
  root: string;
  image?: string;
  podman?: string;
  seccompPath?: string;
  sdkFiles?: WorkspaceFiles;
  toolchainFiles?: WorkspaceFiles;
  buildCeiling?: ResourceLimits;
  executionCeiling?: ResourceLimits;
  maxBuilds?: number;
  maxExecutions?: number;
  /** Explicit GPU device nodes for execution guests. Build guests never receive them. */
  configuredDevices?: readonly string[];
}

export function configuredRunnerDevices(value: readonly string[] | undefined): readonly string[] {
  const devices = value ?? [];
  if (devices.length > 16 || new Set(devices).size !== devices.length || devices.some(device => device !== "/dev/kfd" && !/^\/dev\/dri\/renderD[0-9]+$/.test(device))) throw new RunnerError("invalid_device", "Runner device configuration is invalid");
  return Object.freeze([...devices]);
}

/**
 * The exact device list one execution start may use. A caller that names the
 * field owns the decision for that start and the host-global configuration is
 * ignored entirely, which is how a factory attempt carries the devices its held
 * pool allocation authorized and how a CPU attempt carries none. Only a v4
 * extension caller, which never names the field, keeps the host default.
 */
export function startExecutionDevices(requested: readonly string[] | undefined, configured: readonly string[]): readonly string[] {
  return requested === undefined ? configured : configuredRunnerDevices(requested);
}

export class PodmanRunner implements Runner {
  readonly image: string;
  /** The in-container program `--entrypoint` names. A pinned guest language overrides it. */
  protected readonly guestInterpreter: string = "/usr/local/bin/bun";
  /**
   * The guest's executable search path. `--unsetenv-all` also drops the image's
   * own `PATH`, and a v4 extension may spawn a helper by bare name under its
   * shell grant, so the runner declares the path itself rather than inheriting
   * it. The value is the pinned image's own directory list: fixed, carrying no
   * host or tenant identity, and reaching only the read-only image. A pinned
   * guest language overrides it with its own image's list.
   */
  protected readonly guestPath: string = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bun-node-fallback-bin";
  protected readonly root: string;
  private readonly podman: string;
  protected readonly seccompPath: string;
  private readonly configuredDevices: readonly string[];
  protected readonly operations = new Map<string, RunnerInspection>();
  private readonly containers = new Map<string, string>();
  private readonly executions = new Map<string, FramedExecution>();
  private readonly channels = new Map<string, () => void>();
  protected readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly buildWorkers = new Map<string, string>();
  private activeBuilds = 0;
  private activeExecutions = 0;
  private ready: Promise<void> | undefined;
  private lease: ChildProcessWithoutNullStreams | undefined;
  constructor(protected readonly options: PodmanRunnerOptions) {
    this.root = resolve(options.root);
    this.image = options.image ?? DEFAULT_IMAGE;
    if (!/^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(this.image)) throw new RunnerError("image_unpinned", "Runner image must use an immutable registry digest");
    this.podman = options.podman ?? "podman";
    this.seccompPath = resolve(options.seccompPath ?? seccompDefault);
    this.configuredDevices = configuredRunnerDevices(options.configuredDevices ?? (process.env.EZ_EXTENSION_RUNNER_DEVICES === undefined ? undefined : process.env.EZ_EXTENSION_RUNNER_DEVICES.split(",").filter(Boolean)));
  }
  /**
   * Normal daemon startup: prepare the store, verify the kernel controls, then
   * sweep orphans. Only this entry point sweeps, because with detached
   * execution a container legitimately outlives the process that started it.
   */
  async initialize(): Promise<void> {
    return this.prepare(true);
  }
  /**
   * The artifact store itself: private ownership, the artifacts directory, and
   * the exclusive store lease. It creates no container, so a recovery attach
   * can use it without a multi-second delay.
   */
  private async prepareStore(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()) throw new RunnerError("unsafe_store", "Runner store must be owned by the runner and private");
    await mkdir(join(this.root, "artifacts"), { recursive: true, mode: 0o700 });
    await this.acquireLease();
  }
  /**
   * Store preparation plus the fail-closed kernel probe. Every path that
   * creates a container goes through this, so an unavailable isolation control
   * fails the operation instead of degrading it. The first caller decides the
   * orphan sweep, and the lazy build and execution paths never request it.
   */
  protected async prepare(cleanupOrphans: boolean): Promise<void> {
    this.ready ??= this.probe(cleanupOrphans).catch(async error => { await this.close(); this.ready = undefined; throw error; });
    return this.ready;
  }
  private async probe(cleanupOrphans: boolean): Promise<void> {
    await this.prepareStore();
    await this.probeSecurity(cleanupOrphans);
  }
  private async acquireLease(): Promise<void> {
    if (this.lease) return;
    const lease = processSpawn("flock", ["--exclusive", "--nonblock", join(this.root, "runner.lock"), "/bin/sh", "-c", "echo READY; cat >/dev/null"]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { lease.kill("SIGKILL"); reject(new RunnerError("runner_store_busy", "Artifact store lease timed out")); }, 5000);
      lease.stdout.once("data", chunk => { clearTimeout(timer); if (chunk.toString().trim() === "READY") resolve(); else reject(new RunnerError("runner_store_busy", "Invalid artifact store lease")); });
      lease.once("error", error => { clearTimeout(timer); reject(error); });
      lease.once("exit", () => { clearTimeout(timer); reject(new RunnerError("runner_store_busy", "Another runner owns this artifact store")); });
    });
    this.lease = lease;
    lease.once("exit", () => { this.lease = undefined; this.ready = undefined; void this.close(); });
  }
  protected async probeSecurity(cleanupOrphans = true): Promise<void> {
    const info = JSON.parse(await command(this.podman, ["info", "--format=json"]));
    if (!info.host?.security?.rootless || !info.host?.security?.seccompEnabled || info.host?.cgroupVersion !== "v2" || !["memory", "cpu", "pids"].every(controller => info.host.cgroupControllers.includes(controller))) throw new RunnerError("isolation_unavailable", "Rootless Podman, seccomp, and cgroup v2 CPU/memory/PID controls are required");
    const profile = JSON.parse(await readFile(this.seccompPath, "utf8"));
    if (profile.defaultAction !== "SCMP_ACT_ERRNO") throw new RunnerError("seccomp_unavailable", "An explicit deny-by-default seccomp profile is required");
    const probeId = `probe-${randomUUID()}`;
    const limits = { ...executionLimits, memoryBytes: 128 * 1024 ** 2, cpuMillis: 500, pids: 32 };
    try {
      const probe = JSON.parse(await command(this.podman, [...this.args(probeId, limits), this.image, ...this.probeProgram()]));
      if (probe.uid !== 65534 || probe.writable || probe.memory !== String(limits.memoryBytes) || probe.swap !== "0" || probe.cpu !== "50000 100000" || probe.pids !== "32" || !/^CapEff:\s+0+$/m.test(probe.status) || !/^NoNewPrivs:\s+1$/m.test(probe.status) || !/^Seccomp:\s+2$/m.test(probe.status) || probe.routes.split("\n").length !== 1 || probe.ipv6.split("\n").some((line: string) => line && !line.endsWith("lo"))) throw new RunnerError("isolation_probe_failed", "Kernel controls did not match the secure runner profile");
    } finally { await this.remove(probeId); }
    if (!cleanupOrphans) return;
    const orphans = await command(this.podman, ["ps", "-a", "--filter", `label=io.ezcorp.runner=${sha256(this.root)}`, "--format={{.Names}}"]);
    for (const name of orphans.trim().split("\n").filter(Boolean)) {
      if (/^ez-v4-[a-f0-9-]+$/.test(name)) await command(this.podman, ["rm", "--force", "--time=0", name]);
    }
  }
  /** The in-guest program that reports the applied kernel controls, in the guest's own language. */
  protected probeProgram(): string[] { return ["-e", probeProgramSource]; }
  protected async authorize(_phase: "build" | "execute", _digest: string): Promise<void> {}
  /** Build and typecheck guests. They never receive a device, whatever the host configures. */
  protected launch(id: string, limits: ResourceLimits, staged: string, args: string[]): ChildProcessWithoutNullStreams {
    return processSpawn(this.podman, [...this.args(id, limits, staged, []), this.image, ...args]);
  }
  /** The argv that starts the in-guest channel shim. A pinned guest language overrides it. */
  protected guestEntrypointArgs(): string[] { return ["-e", guestShim]; }
  private channelDirectory(id: string): string { return join(this.root, "channels", this.containerName(id)); }
  /**
   * Execution containers outlive every control client. The guest's stdin is a
   * FIFO the in-guest shim holds `O_RDWR`, so a supervisor's death closes only
   * its own descriptors; it can never reach the guest as end-of-input. This is
   * what `podman attach` could not give us: its stream is the container's stdin,
   * so a client's EOF always terminated the guest.
   *
   * This is the execution-launch seam. `launch` is still the seam for the build
   * and typecheck guests, which are ordinary foreground subprocesses; a runner
   * whose execution guest is not a podman container overrides this one too.
   */
  protected async launchDetached(id: string, limits: ResourceLimits, staged: string, devices: readonly string[], materials?: string): Promise<FramedTransport> {
    const directory = this.channelDirectory(id);
    await mkdir(directory, { recursive: true, mode: CHANNEL_DIRECTORY_MODE });
    await chmod(directory, CHANNEL_DIRECTORY_MODE);
    const facts: Record<string, ChannelInode> = {};
    for (const fifo of CHANNEL_FIFOS) {
      const path = join(directory, fifo);
      await rm(path, { force: true });
      await command("mkfifo", ["-m", CHANNEL_FIFO_MODE.toString(8), path]);
      await chmod(path, CHANNEL_FIFO_MODE);
      const created = await lstat(path);
      if (!created.isFIFO()) throw new RunnerError("channel_untrusted", "Runner control channel entry is not a FIFO");
      facts[fifo] = { device: created.dev, inode: created.ino };
    }
    // Recorded beside the channel, never inside it, so the guest cannot reach
    // the identities the host checks against.
    await writeFile(this.channelFactsPath(id), canonicalJson(facts), { mode: 0o600 });
    if (materials) await this.handOverMaterials(materials);
    await command(this.podman, [...this.args(id, limits, staged, devices, directory, materials), "--detach", this.image, ...this.guestEntrypointArgs()]);
    return this.channelTransport(id);
  }
  /**
   * Hands a material directory to the guest that will write into it.
   *
   * The runner creates nothing here: the directory is the caller's, and the
   * caller placed any inputs in it. What the runner does is the one step no
   * caller can get right on its own, because it depends on the guest uid and on
   * the user-namespace mapping this runner launches into. Without it a guest
   * cannot write at all, and every domain pack would repeat the same four lines.
   *
   * Mode first, ownership second. After ownership moves to the mapped guest uid
   * the runner no longer owns the directory and can no longer chmod it, so the
   * order is not cosmetic. The result is `0o770` owned by the guest with the
   * runner's group: the guest writes, the runner reads the results back, and
   * nobody else can read or write it. Never `0o777`.
   *
   * Files the caller already placed keep their own ownership and modes, so an
   * input stays the runner's and a guest can read it exactly as far as its mode
   * already allowed.
   */
  private async handOverMaterials(directory: string): Promise<void> {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try { stats = await lstat(directory); }
    catch { throw new RunnerError("material_directory_invalid", "Runner material directory does not exist"); }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new RunnerError("material_directory_invalid", "Runner material directory is not a directory");
    if (stats.uid !== process.getuid?.()) throw new RunnerError("material_directory_invalid", "Runner material directory is not owned by the runner");
    await chmod(directory, MATERIAL_DIRECTORY_MODE);
    // Inside the user namespace the runner is root, so gid 0 is the runner's own
    // group on the host and uid 65534 is the guest's mapped uid.
    await command(this.podman, ["unshare", "chown", `${GUEST_UID}:0`, directory]);
  }
  private channelFactsPath(id: string): string { return `${this.channelDirectory(id)}.channel.json`; }
  /**
   * Opens one channel entry without ever following a symlink, then proves the
   * opened descriptor is the exact FIFO inode this runner created. A guest that
   * managed to replace the entry cannot make the host open anything else.
   */
  private async openChannelEntry(id: string, fifo: string, flags: number): Promise<Awaited<ReturnType<typeof open>>> {
    let facts: Record<string, ChannelInode>;
    try { facts = JSON.parse(await readFile(this.channelFactsPath(id), "utf8")) as Record<string, ChannelInode>; }
    catch { throw new RunnerError("channel_untrusted", "Runner control channel has no recorded identity"); }
    const expected = facts[fifo];
    if (!expected || !Number.isSafeInteger(expected.device) || !Number.isSafeInteger(expected.inode)) throw new RunnerError("channel_untrusted", "Runner control channel identity is incomplete");
    // `O_NOFOLLOW` rejects a planted symlink with ELOOP, and a directory with
    // EISDIR, before any identity check can run. Every refusal, whether raised
    // by the kernel at open or by the identity check below, leaves this method
    // as the same typed error carrying the underlying cause.
    let handle: Awaited<ReturnType<typeof open>>;
    try { handle = await open(join(this.channelDirectory(id), fifo), flags | fsConstants.O_NOFOLLOW); }
    catch (error) { throw new RunnerError("channel_untrusted", `Runner control channel entry could not be opened as the FIFO the runner created (${(error as { code?: string }).code ?? "unknown"})`); }
    const opened = await handle.stat();
    if (!opened.isFIFO() || opened.dev !== expected.device || opened.ino !== expected.inode) {
      await handle.close();
      throw new RunnerError("channel_untrusted", "Runner control channel entry is not the FIFO the runner created");
    }
    return handle;
  }
  /**
   * Connects to a guest's channel. Opening `out` and `err` read-only settles as
   * soon as the shim holds them, and their end-of-file is the guest's exit.
   * `in` is opened read-write so this side never blocks and never signals a
   * close to the guest.
   */
  private async channelTransport(id: string): Promise<FramedTransport> {
    const [input, output, errors] = await Promise.all([
      this.openChannelEntry(id, "in", fsConstants.O_RDWR),
      this.openChannelEntry(id, "out", fsConstants.O_RDONLY),
      this.openChannelEntry(id, "err", fsConstants.O_RDONLY),
    ]);
    const sink = input.createWriteStream();
    const out = output.createReadStream();
    const err = errors.createReadStream();
    const closes: ((code: number | null) => void)[] = [];
    const errored: ((error: Error) => void)[] = [];
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const listener of closes) listener(null);
      void Promise.allSettled([input.close(), output.close(), errors.close()]);
    };
    out.once("end", finish);
    out.once("close", finish);
    for (const stream of [sink, out, err]) stream.on("error", (error: Error) => { for (const listener of errored) listener(error); });
    this.channels.set(id, finish);
    const transport: FramedTransport = {
      stdout: out,
      stderr: err,
      stdin: sink,
      on(event: "error" | "close", listener: (value: never) => void) { (event === "close" ? closes : errored).push(listener as never); return transport; },
      once(_event: "close", listener: (code: number | null) => void) { closes.push(listener); return transport; },
      kill: () => { void command(this.podman, ["kill", "--signal=KILL", this.containerName(id)]).catch(() => undefined); },
    };
    return transport;
  }
  protected async run(id: string, limits: ResourceLimits, staged: string, args: string[], maximumBytes = limits.outputBytes): Promise<string> {
    return capture(this.launch(id, limits, staged, args), limits.timeoutMs, maximumBytes);
  }
  private args(id: string, limits: ResourceLimits, mount?: string, devices: readonly string[] = [], channel?: string, materials?: string): string[] {
    const name = this.containerName(id);
    this.containers.set(id, name);
    return ["run", "--pull=never", "--name", name, "--label", `io.ezcorp.runner=${sha256(this.root)}`, "--network=none", "--read-only", "--read-only-tmpfs=false", "--cap-drop=ALL", "--security-opt=no-new-privileges", `--security-opt=seccomp=${this.seccompPath}`, "--user=65534:65534", "--pid=private", "--ipc=private", "--cgroupns=private", "--no-hosts", "--log-driver=none", "--unsetenv-all", `--hostname=${GUEST_HOSTNAME}`, `--memory=${limits.memoryBytes}`, `--memory-swap=${limits.memoryBytes}`, `--cpus=${limits.cpuMillis / 1000}`, `--pids-limit=${limits.pids}`, "--ulimit=nofile=256:256", `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${limits.tmpBytes},mode=1777`, "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=BUN_INSTALL_CACHE_DIR=/tmp/bun-cache", `--env=PATH=${this.guestPath}`, ...devices.flatMap(device => ["--device", device]), mount ? "--workdir=/workspace" : "--workdir=/tmp", ...(mount ? ["--mount", `type=bind,src=${mount},dst=/workspace,ro=true,relabel=private`] : []), ...(channel ? runnerChannelMount(channel) : []), ...(materials ? runnerMaterialMount(materials) : []), `--entrypoint=${this.guestInterpreter}`, "-i"];
  }
  private containerName(id: string): string { return `ez-v4-${sha256(`${this.root}:${id}`).slice(0, 32)}`; }
  private async writeStaged(directory: string, path: string, content: string | Uint8Array, executable = false): Promise<void> {
    const target = join(directory, relativePath(path));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    for (let parent = dirname(target); parent !== directory; parent = dirname(parent)) await chmod(parent, 0o755);
    await writeFile(target, content, { mode: 0o400, flag: "wx" });
    await chmod(target, executable ? 0o555 : 0o444);
  }
  protected async stage(files: WorkspaceFiles): Promise<string> {
    const directory = await mkdtemp(join(this.root, "stage-"));
    await chmod(directory, 0o755);
    try {
      for (const [path, content] of Object.entries(files)) {
        await this.writeStaged(directory, path, workspaceFileBytes(content), typeof content !== "string" && content.executable);
      }
      return directory;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  /** The frozen source is self-consistent: bounded files, a present entrypoint, an exact digest. */
  private assertBuildInput(input: { operationId: string; sourceDigest: string; files: WorkspaceFiles; entrypoint: string }): void {
    identifier(input.operationId);
    digest(input.sourceDigest);
    validateFiles(input.files);
    relativePath(input.entrypoint);
    if (!(input.entrypoint in input.files)) throw new RunnerError("missing_entrypoint", "Entrypoint is absent");
    workspaceText(input.files[input.entrypoint], input.entrypoint);
    if (filesDigest(input.files) !== input.sourceDigest) throw new RunnerError("source_digest_mismatch", "Frozen source digest does not match bytes");
  }

  /** Each provision stays in its own tree, and no source file may replace one. */
  private assertProvisionedPaths(files: WorkspaceFiles, sdk: WorkspaceFiles, toolchain: WorkspaceFiles): void {
    if (!toolchain["node_modules/typescript/bin/tsc"]) throw new RunnerError("toolchain_unavailable", "Pinned TypeScript toolchain must be provisioned by the runner administrator", "typecheck");
    for (const path of Object.keys(sdk)) if (!path.startsWith("node_modules/@ezcorp/sdk/") && !path.startsWith("node_modules/@ezcorp/extension-contract/")) throw new RunnerError("sdk_invalid", "SDK provision must remain in its trusted packages");
    for (const path of Object.keys(toolchain)) if (!path.startsWith("node_modules/")) throw new RunnerError("toolchain_invalid", "Toolchain provision must remain in node_modules");
    for (const path of Object.keys(files)) if (path.startsWith("node_modules/") || path.startsWith(".runner/")) throw new RunnerError("reserved_path", "Source cannot replace provisioned dependencies or runner files");
  }

  /** Typecheck, compile, and — when the source declares one — build the browser bundle. */
  private async typecheckAndCompile(input: { operationId: string; files: WorkspaceFiles; entrypoint: string }, limits: ResourceLimits, staged: string, result: BuildResult): Promise<{ code: string; browser: ReturnType<typeof browserBuild>; browserArtifacts: WorkspaceFiles }> {
    this.requireBuilding(input.operationId);
    const typescriptFiles = Object.keys(input.files).filter(path => /\.[cm]?tsx?$/.test(path));
    if (typescriptFiles.length) {
      await this.run(input.operationId, limits, staged, ["node_modules/typescript/bin/tsc", "--noEmit", "--strictNullChecks", "--allowImportingTsExtensions", "--module", "preserve", "--moduleResolution", "bundler", "--target", "ESNext", "--skipLibCheck", "--allowJs", "--types", "bun", ...typescriptFiles.map(path => `./${path}`)]);
      await this.remove(input.operationId);
    }
    result.evidence.tests.push({ name: "typecheck", passed: true });
    this.requireBuilding(input.operationId);
    const compiled = JSON.parse(await this.run(input.operationId, limits, staged, ["-e", builderProgram, `./${input.entrypoint}`], 20 * 1024 ** 2));
    await this.remove(input.operationId);
    if (typeof compiled.code !== "string") throw new RunnerError("build_output_invalid", "Compiler returned invalid output");
    result.evidence.tests.push({ name: "compile", passed: true });
    const browser = browserBuild(input.files);
    const browserArtifacts: WorkspaceFiles = {};
    if (browser) {
      const compiledBrowser = JSON.parse(await this.run(input.operationId, limits, staged, ["-e", browserBuilderProgram, canonicalJson(browser)], 20 * 1024 ** 2));
      await this.remove(input.operationId);
      if (typeof compiledBrowser.html !== "string" || Buffer.byteLength(compiledBrowser.html) > 12 * 1024 ** 2) throw new RunnerError("browser_build_invalid", "Browser compiler returned invalid output");
      browserArtifacts[".runner/browser.html"] = compiledBrowser.html;
      browserArtifacts[".runner/browser.json"] = canonicalJson(browser);
      result.evidence.tests.push({ name: "browser-compile", passed: true });
    }
    return { code: compiled.code, browser, browserArtifacts };
  }

  /** Run every declared feature test, each in its own container. A build without tests fails. */
  private async runFeatureTests(operationId: string, limits: ResourceLimits, staged: string, files: WorkspaceFiles, result: BuildResult): Promise<void> {
    const testFiles = Object.keys(files).filter(path => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));
    if (testFiles.length === 0) throw new RunnerError("tests_missing", "At least one feature test is required", "test");
    for (const test of testFiles) {
      this.requireBuilding(operationId);
      await this.run(operationId, limits, staged, ["-e", testProgram, `./${test}`, String(Math.min(limits.timeoutMs, 30_000))]);
      await this.remove(operationId);
      result.evidence.tests.push({ name: `feature:${test}`, passed: true });
    }
  }

  async build(input: { operationId: string; sourceDigest: string; files: WorkspaceFiles; entrypoint: string; limits: ResourceLimits }): Promise<BuildResult> {
    this.assertBuildInput(input);
    const limits = limitsWithin(input.limits, this.options.buildCeiling ?? buildLimits);
    await this.prepare(false);
    await this.authorize("build", input.sourceDigest);
    if (this.operations.has(input.operationId)) throw new RunnerError("duplicate_operation", "Runner operation ID is already used");
    if (this.activeBuilds >= (this.options.maxBuilds ?? 1)) throw new RunnerError("runner_busy", "Build concurrency limit reached", "queue", true);
    this.activeBuilds++;
    this.operations.set(input.operationId, { id: input.operationId, state: "building", diagnostics: [] });
    const controller = new AbortController();
    this.controllers.set(input.operationId, controller);
    const result: BuildResult = { operationId: input.operationId, state: "failed", sourceDigest: input.sourceDigest, imageDigest: this.image, diagnostics: [], evidence: { protocolVersion: 4, validatorVersion: "runner-v4.1", tests: [], discoveryDigest: "" } };
    let staged: string | undefined;
    this.deadlines.set(input.operationId, setTimeout(() => { void this.cancel(input.operationId); }, limits.timeoutMs));
    try {
      const dependencies = await fetchLockedDependencies(input.files, controller.signal);
      const sdk = this.options.sdkFiles ?? {};
      const toolchain = this.options.toolchainFiles ?? {};
      this.assertProvisionedPaths(input.files, sdk, toolchain);
      staged = await this.stage({ ...input.files, ...dependencies.text, ...sdk, ...toolchain });
      for (const [path, bytes] of Object.entries(dependencies.binary)) {
        await this.writeStaged(staged, path, bytes, dependencies.executable.includes(path));
      }
      const compiled = await this.typecheckAndCompile(input, limits, staged, result);
      const { browser, browserArtifacts } = compiled;
      await this.runFeatureTests(input.operationId, limits, staged, input.files, result);
      const artifacts = { ...input.files, ...browserArtifacts, ".runner/extension.js": compiled.code, ".runner/recipe.json": canonicalJson({ image: this.image, sdkDigest: filesDigest(sdk), toolchainDigest: filesDigest(toolchain), seccompDigest: sha256(await readFile(this.seccompPath)), limits, entrypoint: input.entrypoint }), ".runner/executables.json": JSON.stringify(dependencies.executable), ".runner/dependencies.json": JSON.stringify(Object.fromEntries(Object.entries(dependencies.binary).map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]))) };
      const artifactDigest = filesDigest(artifacts);
      await this.storeArtifact(artifactDigest, artifacts);
      const workerId = `discovery-${randomUUID()}`;
      this.requireBuilding(input.operationId);
      this.buildWorkers.set(input.operationId, workerId);
      const worker = await this.startExecution({ workerId, artifactDigest, context: { invocationId: workerId, workerId, releaseId: artifactDigest, principalId: "verification", scopeId: "verification", token: "", deadline: Date.now() + Math.min(limits.timeoutMs, 60_000) }, limits: executionLimits }, async () => { throw new RunnerError("startup_effect_denied", "Discovery cannot access host capabilities"); }, true);
      try {
        const manifest = validateManifest(await worker.request("extension/discover", {}));
        if (browser?.tools.some(name => !manifest.tools?.some(tool => tool.name === name))) throw new RunnerError("browser_tool_undeclared", "Browser tools must be declared in the verified extension manifest");
        result.manifest = manifest;
        result.evidence.discoveryDigest = sha256(canonicalJson(manifest));
        result.evidence.tests.push({ name: "metadata-discovery", passed: true });
      } finally { await worker.close(); }
      if (this.operations.get(input.operationId)?.state === "cancelled") throw new RunnerError("cancelled", "Build was cancelled");
      result.artifactDigest = artifactDigest;
      result.state = "succeeded";
      this.operations.set(input.operationId, { id: input.operationId, state: "succeeded", diagnostics: [] });
    } catch (error) {
      result.diagnostics.push((error instanceof RunnerError ? error : new RunnerError("build_failed", error instanceof Error ? error.message : String(error), "build")).diagnostic());
      if (this.operations.get(input.operationId)?.state !== "cancelled") this.operations.set(input.operationId, { id: input.operationId, state: "failed", diagnostics: result.diagnostics });
    } finally {
      clearTimeout(this.deadlines.get(input.operationId));
      this.deadlines.delete(input.operationId);
      this.controllers.delete(input.operationId);
      this.buildWorkers.delete(input.operationId);
      await this.remove(input.operationId);
      if (staged) await rm(staged, { recursive: true, force: true });
      this.activeBuilds--;
    }
    return result;
  }
  protected async storeArtifact(artifactDigest: string, files: WorkspaceFiles): Promise<void> {
    const target = join(this.root, "artifacts", digest(artifactDigest));
    const temporary = join(this.root, `artifact-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o400);
    try { await handle.writeFile(JSON.stringify(files)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
    const directory = await open(join(this.root, "artifacts"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private requireBuilding(id: string): void {
    if (this.operations.get(id)?.state !== "building") throw new RunnerError("cancelled", "Build was cancelled");
  }
  async collectArtifacts(artifactDigest: string): Promise<WorkspaceFiles> {
    const files = JSON.parse(await readFile(join(this.root, "artifacts", digest(artifactDigest)), "utf8"));
    validateFiles(files, 160 * 1024 ** 2, 4000);
    if (filesDigest(files) !== artifactDigest) throw new RunnerError("artifact_corrupt", "Stored artifact digest mismatch");
    return files;
  }
  async start(input: StartRequest, reverseRpc: ReverseRpc): Promise<FramedExecution> {
    return this.startExecution(input, reverseRpc, false);
  }
  /** Reconnect to an existing container after a supervisor restart. Recovery never admits new reverse effects. */
  async attach(input: StartRequest, _reverseRpc: ReverseRpc): Promise<FramedExecution> {
    identifier(input.workerId);
    const limits = limitsWithin(input.limits, this.options.executionCeiling ?? executionLimits);
    if (input.context.workerId !== input.workerId || !Number.isSafeInteger(input.context.deadline) || input.context.deadline <= Date.now()) throw new RunnerError("invalid_context", "Worker context or deadline is invalid");
    await this.prepareStore();
    if ((await this.inspect(input.workerId)).state !== "running") throw new RunnerError("worker_not_running", "Worker cannot be attached because it is not running");
    if (this.executions.has(input.workerId)) throw new RunnerError("duplicate_worker", "Worker is already attached");
    const name = this.containerName(input.workerId);
    this.containers.set(input.workerId, name);
    this.operations.set(input.workerId, { id: input.workerId, state: "running", diagnostics: [] });
    const child = await this.channelTransport(input.workerId);
    const execution = new FramedExecution(input.workerId, child, async () => { throw new RunnerError("recovery_effect_denied", "Recovered workers cannot perform effects before durable result recovery"); }, () => this.remove(input.workerId), Math.min(limits.outputBytes, 1024 ** 2), limits.timeoutMs);
    this.executions.set(input.workerId, execution);
    void execution.exited.finally(() => { this.executions.delete(input.workerId); }).catch(() => undefined);
    return execution;
  }
  protected async startExecution(input: StartRequest, reverseRpc: ReverseRpc, discovery: boolean): Promise<FramedExecution> {
    identifier(input.workerId);
    const limits = limitsWithin(input.limits, this.options.executionCeiling ?? executionLimits);
    if (input.context.workerId !== input.workerId || !Number.isSafeInteger(input.context.deadline) || input.context.deadline <= Date.now()) throw new RunnerError("invalid_context", "Worker context or deadline is invalid");
    await this.prepare(false);
    if (!discovery) await this.authorize("execute", input.artifactDigest);
    if (this.operations.has(input.workerId)) throw new RunnerError("duplicate_worker", "Worker ID is already used");
    if (this.activeExecutions >= (this.options.maxExecutions ?? 4)) throw new RunnerError("runner_busy", "Execution concurrency limit reached", "queue", true);
    this.activeExecutions++;
    this.operations.set(input.workerId, { id: input.workerId, state: "running", diagnostics: [] });
    let staged: string | undefined;
    try {
      const artifacts = await this.collectArtifacts(input.artifactDigest);
      const recipe = JSON.parse(workspaceText(artifacts[".runner/recipe.json"] ?? "{}", ".runner/recipe.json"));
      if (recipe.image !== this.image || recipe.seccompDigest !== sha256(await readFile(this.seccompPath))) throw new RunnerError("runtime_profile_changed", "Runtime image or isolation policy differs from the built release");
      staged = await this.stage(artifacts);
      const dependencies = JSON.parse(workspaceText(artifacts[".runner/dependencies.json"] ?? "{}", ".runner/dependencies.json"));
      const executable = JSON.parse(workspaceText(artifacts[".runner/executables.json"] ?? "[]", ".runner/executables.json"));
      if (!Array.isArray(executable) || executable.some(path => typeof path !== "string")) throw new RunnerError("artifact_corrupt", "Invalid executable catalog");
      for (const [path, content] of Object.entries(dependencies)) {
        if (!path.startsWith("node_modules/") || typeof content !== "string") throw new RunnerError("artifact_corrupt", "Invalid dependency closure");
        await this.writeStaged(staged, path, Buffer.from(content, "base64"), executable.includes(path));
      }
      const stage = staged;
      // Discovery is a build-phase guest, so it is denied a device even when the
      // host configures one. Every other start uses exactly what it was given.
      const devices = discovery ? [] : startExecutionDevices(input.devices, this.configuredDevices);
      // A discovery guest never receives one: the build phase has no attempt
      // and therefore no material scope to write into.
      const child = await this.launchDetached(input.workerId, limits, stage, devices, discovery ? undefined : input.materials);
      const contexts = new Map<string, InvocationContext>();
      const execution = new FramedExecution(input.workerId, child, async (method, params) => {
        const context = validateInvocationContext((params as { context?: unknown })?.context);
        const registered = contexts.get(context.invocationId);
        if (!registered || canonicalJson(registered) !== canonicalJson(context) || Date.now() >= context.deadline || this.operations.get(input.workerId)?.state !== "running") throw new RunnerError("context_expired", "Invocation is no longer active or identity does not match");
        return reverseRpc(method, params);
      }, () => this.remove(input.workerId), Math.min(limits.outputBytes, 1024 ** 2), limits.timeoutMs, (method, params) => {
        if (method === "extension/discover" || method === "extension/cancel") return () => {};
        const context = structuredClone(validateInvocationContext((params as { context?: unknown })?.context));
        if (["workerId", "releaseId", "principalId", "scopeId"].some(key => context[key as keyof InvocationContext] !== input.context[key as keyof InvocationContext]) || context.deadline <= Date.now() || context.deadline > Date.now() + limits.timeoutMs || contexts.has(context.invocationId)) throw new RunnerError("invalid_context", "Invocation identity, deadline or active ID is invalid");
        contexts.set(context.invocationId, context);
        return () => { contexts.delete(context.invocationId); };
      });
      this.executions.set(input.workerId, execution);
      const cleanupFailed = () => {
        const current = this.operations.get(input.workerId);
        this.operations.set(input.workerId, { id: input.workerId, state: "failed", diagnostics: [...(current?.diagnostics.filter(diagnostic => diagnostic.code !== "cleanup_failed") ?? []), new RunnerError("cleanup_failed", "Worker cleanup failed; retained resources require cleanup retry").diagnostic()] });
      };
      this.deadlines.set(input.workerId, setTimeout(() => { void this.cancel(input.workerId).catch(cleanupFailed); }, Math.min(limits.timeoutMs, input.context.deadline - Date.now())));
      void execution.exited.then(code => {
        const current = this.operations.get(input.workerId);
        if (current?.state === "running") this.operations.set(input.workerId, { id: input.workerId, state: code === 0 ? "succeeded" : "failed", diagnostics: code === 0 ? [] : [new RunnerError("worker_exited", `Worker exited ${code}`).diagnostic()] });
      }).finally(async () => {
        clearTimeout(this.deadlines.get(input.workerId));
        this.deadlines.delete(input.workerId);
        this.executions.delete(input.workerId);
        this.activeExecutions--;
        if (!this.containers.has(input.workerId)) await rm(stage, { recursive: true, force: true });
      }).catch(cleanupFailed);
      return execution;
    } catch (error) { this.activeExecutions--; this.operations.set(input.workerId, { id: input.workerId, state: "failed", diagnostics: [new RunnerError("worker_start_failed", "Worker could not start").diagnostic()] }); if (staged) await rm(staged, { recursive: true, force: true }); throw error; }
  }
  /**
   * Signals the sandbox's init process so the guest can clean up. It never
   * removes the container, so the caller can observe whether cleanup finished
   * before it kills what remains.
   */
  async abort(id: string): Promise<void> {
    identifier(id);
    const current = this.operations.get(id) ?? await this.inspect(id);
    if (current.state !== "running") return;
    try { await command(this.podman, ["kill", "--signal=TERM", this.containerName(id)]); }
    catch (error) { if (!(error instanceof RunnerError && error.code === "command_failed" && /no such (?:object|container)|is not running/i.test(error.message))) throw error; }
  }

  async cancel(id: string): Promise<void> {
    identifier(id);
    const current = this.operations.get(id) ?? await this.inspect(id);
    if (current.state === "unknown") return;
    this.operations.set(id, { ...current, state: "cancelled" });
    this.controllers.get(id)?.abort(new RunnerError("cancelled", "Build cancelled"));
    const buildWorker = this.buildWorkers.get(id);
    if (buildWorker) await this.cancel(buildWorker);
    await this.executions.get(id)?.close();
    this.containers.set(id, this.containerName(id));
    await this.remove(id);
  }
  async inspect(id: string): Promise<RunnerInspection> {
    identifier(id);
    const known = this.operations.get(id);
    if (known) return structuredClone(known);
    try {
      const state = JSON.parse(await command(this.podman, ["inspect", "--format={{json .State}}", this.containerName(id)])) as { Running?: unknown; ExitCode?: unknown };
      if (state.Running === true) return { id, state: "running", diagnostics: [] };
      if (Number.isInteger(state.ExitCode)) return { id, state: Number(state.ExitCode) === 0 ? "succeeded" : "failed", diagnostics: [] };
      throw new RunnerError("inspect_invalid", "Podman returned an invalid worker state");
    } catch (error) {
      if (error instanceof RunnerError && error.code === "command_failed" && /no such (?:object|container)/i.test(error.message)) return { id, state: "unknown", diagnostics: [] };
      throw error;
    }
  }
  async close(): Promise<void> {
    await Promise.all([...this.operations.values()].filter(operation => operation.state === "building" || operation.state === "running").map(operation => this.cancel(operation.id)));
    await Promise.all([...this.containers.keys()].map(id => this.remove(id)));
    if (this.lease) { const lease = this.lease; this.lease = undefined; lease.stdin.end(); await new Promise<void>(resolve => lease.once("exit", () => resolve())); }
    this.ready = undefined;
  }
  protected async remove(id: string): Promise<void> {
    this.channels.get(id)?.();
    this.channels.delete(id);
    const name = this.containers.get(id);
    if (!name) { await this.discardChannel(id); return; }
    this.containers.delete(id);
    try {
      const state = JSON.parse(await command(this.podman, ["inspect", "--format={{json .State}}", name]));
      if (state.OOMKilled) {
        const current = this.operations.get(id);
        if (current) this.operations.set(id, { ...current, state: "failed", diagnostics: [...current.diagnostics, new RunnerError("memory_limit", "Kernel terminated worker at its memory limit").diagnostic()] });
      }
    } catch {}
    try { await command(this.podman, ["rm", "--force", "--time=0", "--ignore", name]); } catch (error) { this.containers.set(id, name); throw error; }
    await this.discardChannel(id);
  }
  private async discardChannel(id: string): Promise<void> {
    await rm(this.channelDirectory(id), { recursive: true, force: true });
    await rm(this.channelFactsPath(id), { force: true });
  }
}
