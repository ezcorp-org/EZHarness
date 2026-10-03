import { readFile, rm } from "node:fs/promises";
import type { BuildResult, ResourceLimits, WorkspaceFiles } from "@ezcorp/extension-contract";
import { canonicalJson, validateManifest } from "@ezcorp/extension-contract";
import { PodmanRunner, type PodmanRunnerOptions } from "./podman";
import { buildLimits, digest, executionLimits, filesDigest, identifier, limitsWithin, relativePath, RunnerError, sha256, validateFiles } from "./core";

/** Pinned CPython 3.13.12 on Debian bookworm, by immutable registry digest. */
export const DEFAULT_PYTHON_IMAGE = "docker.io/library/python@sha256:3121f8b0804aa3698ab750d9a39ea4a42657a385c9b133722b915e55c51551a6";

/**
 * The in-guest shim. It is the Python counterpart of the Bun shim: it opens the
 * three channel FIFOs `O_RDWR` and holds them for the guest's whole life, so a
 * FIFO reader sees end-of-file only when this process itself exits and no host
 * process's death can reach the guest as end-of-input.
 */
const pythonGuestShim = `import os,subprocess,sys
i=os.open("/channel/in",os.O_RDWR)
o=os.open("/channel/out",os.O_RDWR)
e=os.open("/channel/err",os.O_RDWR)
try:
    child=subprocess.Popen([sys.executable,"-u","./.runner/extension.py"],stdin=i,stdout=o,stderr=e)
except OSError:
    sys.exit(1)
sys.exit(child.wait())`;

/** The same applied-control facts the Bun probe reports, stated in Python. */
const pythonProbeProgram = `import json,os
read=lambda p:open(p).read().strip()
writable=False
try:
    open("/root-write-probe","w").write("x"); writable=True
except OSError:
    pass
print(json.dumps({"uid":os.getuid(),"status":read("/proc/self/status"),"memory":read("/sys/fs/cgroup/memory.max"),"swap":read("/sys/fs/cgroup/memory.swap.max"),"cpu":read("/sys/fs/cgroup/cpu.max"),"pids":read("/sys/fs/cgroup/pids.max"),"routes":read("/proc/net/route"),"ipv6":read("/proc/net/ipv6_route"),"writable":writable}))`;

/** Parses every staged module. A file that cannot be parsed never becomes an artifact. */
const pythonSyntaxProgram = `import ast,pathlib,sys
for path in sorted(pathlib.Path(".").rglob("*.py")):
    ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
sys.stdout.write("ok")`;

/**
 * Reports the guest's actual importable closure and interpreter. The build
 * compares it with the declared content lock, so a base image that gained a
 * distribution fails the build instead of reaching an attempt.
 */
const pythonClosureProgram = `import importlib.metadata as m,json,sys
names=sorted({f"{d.metadata['Name']}=={d.version}" for d in m.distributions() if d.metadata['Name']})
print(json.dumps({"python":"%d.%d.%d"%sys.version_info[:3],"distributions":names}))`;

/**
 * The generated launcher: the one fixed path the shim starts. It imports the
 * entrypoint module and calls its `main`, so the guest has no second script
 * entry whose behaviour could drift from the one the tests measure.
 */
export function pythonGuestLauncher(entrypoint: string): string {
  const path = relativePath(entrypoint);
  const module = path.replace(/\.py$/, "").replaceAll("/", ".");
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(module)) throw new RunnerError("missing_entrypoint", "A Python runner entrypoint must be an importable module path");
  return `import importlib,sys\nsys.path.insert(0,"/workspace")\nraise SystemExit(importlib.import_module("${module}").main())\n`;
}

/**
 * The immutable content lock a Python guest carries. It extends the shared
 * `.runner/recipe.json` recipe with the interpreter pin, the committed
 * dependency lock, the importable distribution closure, the pinned model
 * weights, and the C03 resource class, so nothing an attempt runs is resolved
 * at execution time.
 */
export interface PythonRunnerClosure {
  /** Exactly the repository's `.python-version`. */
  readonly pythonVersion: string;
  /** `sha256:` digest of the committed `uv.lock` that governs this project. */
  readonly lockDigest: string;
  /** Sorted `name==version` distributions the guest may import. Empty means the standard library only. */
  readonly distributions: readonly string[];
  /** Sorted `name@sha256:...` model weight pins. Empty means the guest uses no model weights. */
  readonly models: readonly string[];
  /** The C03 resource class this guest is built for. */
  readonly resourceClass: string;
}

export interface PythonPodmanRunnerOptions extends PodmanRunnerOptions {
  readonly closure: PythonRunnerClosure;
}

export function pythonClosureDigest(closure: PythonRunnerClosure): string {
  return `sha256:${sha256(canonicalJson({ pythonVersion: closure.pythonVersion, lockDigest: closure.lockDigest, distributions: [...closure.distributions], models: [...closure.models], resourceClass: closure.resourceClass }))}`;
}

/** `sha256:` over the committed lock file, so a recipe names the exact lock that produced it. */
export async function pythonLockDigest(lockPath: string): Promise<string> {
  return `sha256:${sha256(await readFile(lockPath))}`;
}

/**
 * The isolated Python guest runner.
 *
 * It extends the shared Podman runner rather than reimplementing it, so the
 * fail-closed kernel probe, the private artifact store and its exclusive lease,
 * the read-only channel mount with its FIFO identity check, the detached launch,
 * the frame policy, the resource ceilings and the per-attempt device contract
 * are the same code for both guest languages. Only three things differ: the
 * pinned image, the in-guest shim, and a build whose lanes are Python's.
 */
export class PythonPodmanRunner extends PodmanRunner {
  protected override readonly guestInterpreter = "/usr/local/bin/python3";
  /** The pinned Python image's own directory list, deduplicated. */
  protected override readonly guestPath = "/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin";
  readonly closure: PythonRunnerClosure;

  constructor(options: PythonPodmanRunnerOptions) {
    super({ ...options, image: options.image ?? DEFAULT_PYTHON_IMAGE });
    if (!/^\d+\.\d+\.\d+$/.test(options.closure.pythonVersion)) throw new RunnerError("closure_invalid", "Python runner closure must pin an exact interpreter version");
    if (!/^sha256:[a-f0-9]{64}$/.test(options.closure.lockDigest)) throw new RunnerError("closure_invalid", "Python runner closure must pin its dependency lock by digest");
    for (const list of [options.closure.distributions, options.closure.models]) {
      if (list.length !== new Set(list).size || [...list].sort().some((entry, index) => entry !== list[index])) throw new RunnerError("closure_invalid", "Python runner closure lists must be sorted and unique");
    }
    if (!options.closure.resourceClass) throw new RunnerError("closure_invalid", "Python runner closure must name its resource class");
    this.closure = Object.freeze({ ...options.closure, distributions: Object.freeze([...options.closure.distributions]), models: Object.freeze([...options.closure.models]) });
  }

  protected override probeProgram(): string[] { return ["-c", pythonProbeProgram]; }
  protected override guestEntrypointArgs(): string[] { return ["-c", pythonGuestShim]; }

  /**
   * Seals one Python guest into an immutable artifact through the shared recipe
   * machinery. Every lane runs inside the same isolated profile the attempt will
   * use: the modules are parsed, the importable closure is compared with the
   * declared content lock, the declared tests run, and only then is the artifact
   * stored and its manifest read back from a real guest.
   */
  override async build(input: { operationId: string; sourceDigest: string; files: WorkspaceFiles; entrypoint: string; limits: ResourceLimits }): Promise<BuildResult> {
    identifier(input.operationId);
    digest(input.sourceDigest);
    validateFiles(input.files);
    relativePath(input.entrypoint);
    if (!(input.entrypoint in input.files)) throw new RunnerError("missing_entrypoint", "Entrypoint is absent");
    if (!input.entrypoint.endsWith(".py")) throw new RunnerError("missing_entrypoint", "A Python runner entrypoint must be a module");
    if (filesDigest(input.files) !== input.sourceDigest) throw new RunnerError("source_digest_mismatch", "Frozen source digest does not match bytes");
    for (const path of Object.keys(input.files)) if (path.startsWith(".runner/") || path.startsWith("node_modules/")) throw new RunnerError("reserved_path", "Source cannot replace provisioned runner files");
    const limits = limitsWithin(input.limits, this.options.buildCeiling ?? buildLimits);
    await this.prepare(false);
    await this.authorize("build", input.sourceDigest);
    if (this.operations.has(input.operationId)) throw new RunnerError("duplicate_operation", "Runner operation ID is already used");
    this.operations.set(input.operationId, { id: input.operationId, state: "building", diagnostics: [] });
    const result: BuildResult = { operationId: input.operationId, state: "failed", sourceDigest: input.sourceDigest, imageDigest: this.image, diagnostics: [], evidence: { protocolVersion: 4, validatorVersion: "python-runner-v4.1", tests: [], discoveryDigest: "" } };
    let staged: string | undefined;
    this.deadlines.set(input.operationId, setTimeout(() => { void this.cancel(input.operationId); }, limits.timeoutMs));
    try {
      staged = await this.stage(input.files);
      if ((await this.run(input.operationId, limits, staged, ["-c", pythonSyntaxProgram])).trim() !== "ok") throw new RunnerError("build_output_invalid", "Python syntax lane returned invalid output");
      await this.remove(input.operationId);
      result.evidence.tests.push({ name: "syntax", passed: true });

      const observed = JSON.parse(await this.run(input.operationId, limits, staged, ["-c", pythonClosureProgram])) as { python?: unknown; distributions?: unknown };
      await this.remove(input.operationId);
      if (observed.python !== this.closure.pythonVersion) throw new RunnerError("runtime_profile_changed", `Guest interpreter ${String(observed.python)} is not the pinned ${this.closure.pythonVersion}`);
      if (canonicalJson(observed.distributions) !== canonicalJson([...this.closure.distributions])) throw new RunnerError("dependency_closure_changed", "Guest importable distributions differ from the pinned content lock");
      result.evidence.tests.push({ name: "closure", passed: true });

      const tests = Object.keys(input.files).filter(path => /(?:^|\/)test_[^/]+\.py$/.test(path));
      if (tests.length === 0) throw new RunnerError("tests_missing", "At least one Python feature test is required", "test");
      for (const test of tests) {
        await this.run(input.operationId, limits, staged, ["-m", "unittest", "-v", test.replace(/\.py$/, "").replaceAll("/", ".")]);
        await this.remove(input.operationId);
        result.evidence.tests.push({ name: `feature:${test}`, passed: true });
      }

      const recipe = { image: this.image, seccompDigest: sha256(await readFile(this.seccompPath)), limits, entrypoint: input.entrypoint, runtime: "python" as const, closure: { pythonVersion: this.closure.pythonVersion, lockDigest: this.closure.lockDigest, distributions: [...this.closure.distributions], models: [...this.closure.models], resourceClass: this.closure.resourceClass }, closureDigest: pythonClosureDigest(this.closure) };
      const artifacts: WorkspaceFiles = { ...input.files, ".runner/extension.py": pythonGuestLauncher(input.entrypoint), ".runner/recipe.json": canonicalJson(recipe) };
      const artifactDigest = filesDigest(artifacts);
      await this.storeArtifact(artifactDigest, artifacts);

      const workerId = `discovery-${sha256(`${input.operationId}:${artifactDigest}`).slice(0, 32)}`;
      const worker = await this.startExecution({ workerId, artifactDigest, context: { invocationId: workerId, workerId, releaseId: artifactDigest, principalId: "verification", scopeId: "verification", token: "", deadline: Date.now() + Math.min(limits.timeoutMs, 60_000) }, limits: executionLimits, devices: [] }, async () => { throw new RunnerError("startup_effect_denied", "Discovery cannot access host capabilities"); }, true);
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
      await this.remove(input.operationId);
      if (staged) await rm(staged, { recursive: true, force: true });
    }
    return result;
  }
}
