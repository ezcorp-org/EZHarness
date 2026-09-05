import { mkdir, mkdtemp, writeFile, readFile, rename, rm, chmod, lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BuildResult, InvocationContext, ResourceLimits, Runner, RunnerInspection, WorkspaceFiles } from "@ezcorp/extension-contract";
import { canonicalJson, validateInvocationContext, validateManifest } from "@ezcorp/extension-contract";
import { buildLimits, capture, command, digest, executionLimits, filesDigest, identifier, limitsWithin, processSpawn, relativePath, RunnerError, sha256, validateFiles } from "./core";
import { FramedExecution, type ReverseRpc } from "./protocol";
import { fetchLockedDependencies } from "./dependencies";

export const DEFAULT_IMAGE = "docker.io/oven/bun@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834";
const seccompDefault = new URL("../seccomp.json", import.meta.url).pathname;
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
}

export class PodmanRunner implements Runner {
  readonly image: string;
  protected readonly root: string;
  private readonly podman: string;
  private readonly seccompPath: string;
  private readonly operations = new Map<string, RunnerInspection>();
  private readonly containers = new Map<string, string>();
  private readonly executions = new Map<string, FramedExecution>();
  private readonly deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly buildWorkers = new Map<string, string>();
  private activeBuilds = 0;
  private activeExecutions = 0;
  private ready: Promise<void> | undefined;
  private lease: ChildProcessWithoutNullStreams | undefined;
  constructor(private readonly options: PodmanRunnerOptions) {
    this.root = resolve(options.root);
    this.image = options.image ?? DEFAULT_IMAGE;
    if (!/^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(this.image)) throw new RunnerError("image_unpinned", "Runner image must use an immutable registry digest");
    this.podman = options.podman ?? "podman";
    this.seccompPath = resolve(options.seccompPath ?? seccompDefault);
  }
  async initialize(): Promise<void> {
    this.ready ??= this.probe().catch(async error => { await this.close(); this.ready = undefined; throw error; });
    return this.ready;
  }
  private async probe(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()) throw new RunnerError("unsafe_store", "Runner store must be owned by the runner and private");
    await mkdir(join(this.root, "artifacts"), { recursive: true, mode: 0o700 });
    await this.acquireLease();
    await this.probeSecurity();
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
  protected async probeSecurity(): Promise<void> {
    const info = JSON.parse(await command(this.podman, ["info", "--format=json"]));
    if (!info.host?.security?.rootless || !info.host?.security?.seccompEnabled || info.host?.cgroupVersion !== "v2" || !["memory", "cpu", "pids"].every(controller => info.host.cgroupControllers.includes(controller))) throw new RunnerError("isolation_unavailable", "Rootless Podman, seccomp, and cgroup v2 CPU/memory/PID controls are required");
    const profile = JSON.parse(await readFile(this.seccompPath, "utf8"));
    if (profile.defaultAction !== "SCMP_ACT_ERRNO") throw new RunnerError("seccomp_unavailable", "An explicit deny-by-default seccomp profile is required");
    const probeId = `probe-${randomUUID()}`;
    const limits = { ...executionLimits, memoryBytes: 128 * 1024 ** 2, cpuMillis: 500, pids: 32 };
    const program = `const fs=require("node:fs");const read=p=>fs.readFileSync(p,"utf8").trim(); const status=read("/proc/self/status");let writable=false;try{fs.writeFileSync("/root-write-probe","x");writable=true}catch{} console.log(JSON.stringify({uid:process.getuid(),status,memory:read("/sys/fs/cgroup/memory.max"),swap:read("/sys/fs/cgroup/memory.swap.max"),cpu:read("/sys/fs/cgroup/cpu.max"),pids:read("/sys/fs/cgroup/pids.max"),routes:read("/proc/net/route"),ipv6:read("/proc/net/ipv6_route"),writable}));`;
    try {
      const probe = JSON.parse(await command(this.podman, [...this.args(probeId, limits), this.image, "-e", program]));
      if (probe.uid !== 65534 || probe.writable || probe.memory !== String(limits.memoryBytes) || probe.swap !== "0" || probe.cpu !== "50000 100000" || probe.pids !== "32" || !/^CapEff:\s+0+$/m.test(probe.status) || !/^NoNewPrivs:\s+1$/m.test(probe.status) || !/^Seccomp:\s+2$/m.test(probe.status) || probe.routes.split("\n").length !== 1 || probe.ipv6.split("\n").some((line: string) => line && !line.endsWith("lo"))) throw new RunnerError("isolation_probe_failed", "Kernel controls did not match the secure runner profile");
    } finally { await this.remove(probeId); }
    const orphans = await command(this.podman, ["ps", "-a", "--filter", `label=io.ezcorp.runner=${sha256(this.root)}`, "--format={{.Names}}"]);
    for (const name of orphans.trim().split("\n").filter(Boolean)) {
      if (/^ez-v4-[a-f0-9-]+$/.test(name)) await command(this.podman, ["rm", "--force", "--time=0", name]);
    }
  }
  protected async authorize(_phase: "build" | "execute", _digest: string): Promise<void> {}
  protected launch(id: string, limits: ResourceLimits, staged: string, args: string[]): ChildProcessWithoutNullStreams {
    return processSpawn(this.podman, [...this.args(id, limits, staged), this.image, ...args]);
  }
  protected async run(id: string, limits: ResourceLimits, staged: string, args: string[], maximumBytes = limits.outputBytes): Promise<string> {
    return capture(this.launch(id, limits, staged, args), limits.timeoutMs, maximumBytes);
  }
  private args(id: string, limits: ResourceLimits, mount?: string): string[] {
    const name = `ez-v4-${sha256(`${this.root}:${id}`).slice(0, 32)}`;
    this.containers.set(id, name);
    return ["run", "--pull=never", "--name", name, "--label", `io.ezcorp.runner=${sha256(this.root)}`, "--network=none", "--read-only", "--read-only-tmpfs=false", "--cap-drop=ALL", "--security-opt=no-new-privileges", `--security-opt=seccomp=${this.seccompPath}`, "--user=65534:65534", "--pid=private", "--ipc=private", "--cgroupns=private", "--no-hosts", "--log-driver=none", `--memory=${limits.memoryBytes}`, `--memory-swap=${limits.memoryBytes}`, `--cpus=${limits.cpuMillis / 1000}`, `--pids-limit=${limits.pids}`, "--ulimit=nofile=256:256", `--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=${limits.tmpBytes},mode=1777`, "--env=HOME=/tmp", "--env=TMPDIR=/tmp", "--env=BUN_INSTALL_CACHE_DIR=/tmp/bun-cache", mount ? "--workdir=/workspace" : "--workdir=/tmp", ...(mount ? ["--mount", `type=bind,src=${mount},dst=/workspace,ro=true,relabel=private`] : []), "--entrypoint=/usr/local/bin/bun", "-i"];
  }
  private async writeStaged(directory: string, path: string, content: string | Uint8Array, executable = false): Promise<void> {
    const target = join(directory, relativePath(path));
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    for (let parent = dirname(target); parent !== directory; parent = dirname(parent)) await chmod(parent, 0o755);
    await writeFile(target, content, { mode: 0o400, flag: "wx" });
    await chmod(target, executable ? 0o555 : 0o444);
  }
  private async stage(files: WorkspaceFiles): Promise<string> {
    const directory = await mkdtemp(join(this.root, "stage-"));
    await chmod(directory, 0o755);
    try {
      for (const [path, content] of Object.entries(files)) {
        await this.writeStaged(directory, path, content);
      }
      return directory;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async build(input: { operationId: string; sourceDigest: string; files: WorkspaceFiles; entrypoint: string; limits: ResourceLimits }): Promise<BuildResult> {
    identifier(input.operationId);
    digest(input.sourceDigest);
    validateFiles(input.files);
    relativePath(input.entrypoint);
    if (!(input.entrypoint in input.files)) throw new RunnerError("missing_entrypoint", "Entrypoint is absent");
    if (filesDigest(input.files) !== input.sourceDigest) throw new RunnerError("source_digest_mismatch", "Frozen source digest does not match bytes");
    const limits = limitsWithin(input.limits, this.options.buildCeiling ?? buildLimits);
    await this.initialize();
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
      if (!toolchain["node_modules/typescript/bin/tsc"]) throw new RunnerError("toolchain_unavailable", "Pinned TypeScript toolchain must be provisioned by the runner administrator", "typecheck");
      for (const path of Object.keys(sdk)) if (!path.startsWith("node_modules/@ezcorp/sdk/")) throw new RunnerError("sdk_invalid", "SDK provision must remain in its package");
      for (const path of Object.keys(toolchain)) if (!path.startsWith("node_modules/")) throw new RunnerError("toolchain_invalid", "Toolchain provision must remain in node_modules");
      for (const path of Object.keys(input.files)) if (path.startsWith("node_modules/") || path.startsWith(".runner/")) throw new RunnerError("reserved_path", "Source cannot replace provisioned dependencies or runner files");
      staged = await this.stage({ ...input.files, ...dependencies.text, ...sdk, ...toolchain });
      for (const [path, bytes] of Object.entries(dependencies.binary)) {
        await this.writeStaged(staged, path, bytes, dependencies.executable.includes(path));
      }
      this.requireBuilding(input.operationId);
      const typescriptFiles = Object.keys(input.files).filter(path => /\.[cm]?tsx?$/.test(path));
      if (typescriptFiles.length) {
        await this.run(input.operationId, limits, staged, ["node_modules/typescript/bin/tsc", "--noEmit", "--module", "preserve", "--moduleResolution", "bundler", "--target", "ESNext", "--skipLibCheck", "--allowJs", "--types", "bun", ...typescriptFiles.map(path => `./${path}`)]);
        await this.remove(input.operationId);
      }
      result.evidence.tests.push({ name: "typecheck", passed: true });
      this.requireBuilding(input.operationId);
      const compiled = JSON.parse(await this.run(input.operationId, limits, staged, ["-e", builderProgram, `./${input.entrypoint}`], 20 * 1024 ** 2));
      await this.remove(input.operationId);
      if (typeof compiled.code !== "string") throw new RunnerError("build_output_invalid", "Compiler returned invalid output");
      result.evidence.tests.push({ name: "compile", passed: true });
      const testFiles = Object.keys(input.files).filter(path => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));
      if (testFiles.length === 0) throw new RunnerError("tests_missing", "At least one feature test is required", "test");
      for (const test of testFiles) {
        this.requireBuilding(input.operationId);
        await this.run(input.operationId, limits, staged, ["-e", testProgram, `./${test}`, String(Math.min(limits.timeoutMs, 30_000))]);
        await this.remove(input.operationId);
        result.evidence.tests.push({ name: `feature:${test}`, passed: true });
      }
      const artifacts = { ...input.files, ".runner/extension.js": compiled.code, ".runner/recipe.json": canonicalJson({ image: this.image, sdkDigest: filesDigest(sdk), toolchainDigest: filesDigest(toolchain), seccompDigest: sha256(await readFile(this.seccompPath)), limits, entrypoint: input.entrypoint }), ".runner/executables.json": JSON.stringify(dependencies.executable), ".runner/dependencies.json": JSON.stringify(Object.fromEntries(Object.entries(dependencies.binary).map(([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]))) };
      const artifactDigest = filesDigest(artifacts);
      await this.storeArtifact(artifactDigest, artifacts);
      const workerId = `discovery-${randomUUID()}`;
      this.requireBuilding(input.operationId);
      this.buildWorkers.set(input.operationId, workerId);
      const worker = await this.startExecution({ workerId, artifactDigest, context: { invocationId: workerId, workerId, releaseId: artifactDigest, principalId: "verification", scopeId: "verification", token: "", deadline: Date.now() + Math.min(limits.timeoutMs, 60_000) }, limits: executionLimits }, async () => { throw new RunnerError("startup_effect_denied", "Discovery cannot access host capabilities"); }, true);
      try {
        const manifest = validateManifest(await worker.request("extension/discover", {}));
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
  private async storeArtifact(artifactDigest: string, files: WorkspaceFiles): Promise<void> {
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
  async start(input: { workerId: string; artifactDigest: string; context: InvocationContext; limits: ResourceLimits }, reverseRpc: ReverseRpc): Promise<FramedExecution> {
    return this.startExecution(input, reverseRpc, false);
  }
  private async startExecution(input: { workerId: string; artifactDigest: string; context: InvocationContext; limits: ResourceLimits }, reverseRpc: ReverseRpc, discovery: boolean): Promise<FramedExecution> {
    identifier(input.workerId);
    const limits = limitsWithin(input.limits, this.options.executionCeiling ?? executionLimits);
    if (input.context.workerId !== input.workerId || !Number.isSafeInteger(input.context.deadline) || input.context.deadline <= Date.now()) throw new RunnerError("invalid_context", "Worker context or deadline is invalid");
    await this.initialize();
    if (!discovery) await this.authorize("execute", input.artifactDigest);
    if (this.operations.has(input.workerId)) throw new RunnerError("duplicate_worker", "Worker ID is already used");
    if (this.activeExecutions >= (this.options.maxExecutions ?? 4)) throw new RunnerError("runner_busy", "Execution concurrency limit reached", "queue", true);
    this.activeExecutions++;
    this.operations.set(input.workerId, { id: input.workerId, state: "running", diagnostics: [] });
    let staged: string | undefined;
    try {
      const artifacts = await this.collectArtifacts(input.artifactDigest);
      const recipe = JSON.parse(artifacts[".runner/recipe.json"] ?? "{}");
      if (recipe.image !== this.image || recipe.seccompDigest !== sha256(await readFile(this.seccompPath))) throw new RunnerError("runtime_profile_changed", "Runtime image or isolation policy differs from the built release");
      staged = await this.stage(artifacts);
      const dependencies = JSON.parse(artifacts[".runner/dependencies.json"] ?? "{}");
      const executable = JSON.parse(artifacts[".runner/executables.json"] ?? "[]");
      if (!Array.isArray(executable) || executable.some(path => typeof path !== "string")) throw new RunnerError("artifact_corrupt", "Invalid executable catalog");
      for (const [path, content] of Object.entries(dependencies)) {
        if (!path.startsWith("node_modules/") || typeof content !== "string") throw new RunnerError("artifact_corrupt", "Invalid dependency closure");
        await this.writeStaged(staged, path, Buffer.from(content, "base64"), executable.includes(path));
      }
      const stage = staged;
      const child = this.launch(input.workerId, limits, stage, ["./.runner/extension.js"]);
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
      this.deadlines.set(input.workerId, setTimeout(() => { void this.cancel(input.workerId); }, Math.min(limits.timeoutMs, input.context.deadline - Date.now())));
      void execution.exited.then(async code => {
        clearTimeout(this.deadlines.get(input.workerId));
        this.deadlines.delete(input.workerId);
        this.executions.delete(input.workerId);
        this.activeExecutions--;
        const current = this.operations.get(input.workerId);
        if (current?.state === "running") this.operations.set(input.workerId, { id: input.workerId, state: code === 0 ? "succeeded" : "failed", diagnostics: code === 0 ? [] : [new RunnerError("worker_exited", `Worker exited ${code}`).diagnostic()] });
        await this.remove(input.workerId);
        await rm(stage, { recursive: true, force: true });
      });
      return execution;
    } catch (error) { this.activeExecutions--; this.operations.set(input.workerId, { id: input.workerId, state: "failed", diagnostics: [new RunnerError("worker_start_failed", "Worker could not start").diagnostic()] }); if (staged) await rm(staged, { recursive: true, force: true }); throw error; }
  }
  async cancel(id: string): Promise<void> {
    identifier(id);
    const current = this.operations.get(id);
    if (!current) return;
    this.operations.set(id, { ...current, state: "cancelled" });
    this.controllers.get(id)?.abort(new RunnerError("cancelled", "Build cancelled"));
    const buildWorker = this.buildWorkers.get(id);
    if (buildWorker) await this.cancel(buildWorker);
    await this.executions.get(id)?.close();
    await this.remove(id);
  }
  async inspect(id: string): Promise<RunnerInspection> {
    identifier(id);
    return structuredClone(this.operations.get(id) ?? { id, state: "unknown", diagnostics: [] });
  }
  async close(): Promise<void> {
    await Promise.all([...this.operations.values()].filter(operation => operation.state === "building" || operation.state === "running").map(operation => this.cancel(operation.id)));
    if (this.lease) { const lease = this.lease; this.lease = undefined; lease.stdin.end(); await new Promise<void>(resolve => lease.once("exit", () => resolve())); }
    this.ready = undefined;
  }
  protected async remove(id: string): Promise<void> {
    const name = this.containers.get(id);
    if (!name) return;
    this.containers.delete(id);
    try {
      const state = JSON.parse(await command(this.podman, ["inspect", "--format={{json .State}}", name]));
      if (state.OOMKilled) {
        const current = this.operations.get(id);
        if (current) this.operations.set(id, { ...current, state: "failed", diagnostics: [...current.diagnostics, new RunnerError("memory_limit", "Kernel terminated worker at its memory limit").diagnostic()] });
      }
    } catch {}
    try { await command(this.podman, ["rm", "--force", "--time=0", "--ignore", name]); } catch (error) { this.containers.set(id, name); throw error; }
  }
}
