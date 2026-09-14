import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { buildLimits, DEFAULT_PYTHON_IMAGE, executionLimits, filesDigest, PythonPodmanRunner, pythonClosureDigest, pythonGuestLauncher, RUNNER_GUEST_ENVIRONMENT, RunnerError } from "@ezcorp/extension-runner";
import { validateFactoryRunnerRequest, validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { FACTORY_PYTHON_GUEST_ENTRYPOINT, factoryPythonGuestDigest, factoryPythonGuestFiles, factoryPythonRunnerClosure } from "./python-guest";

/**
 * The isolated Python guest, end to end through the shared runner.
 *
 * Every case below runs a real rootless Podman container from the pinned
 * interpreter image: the build lanes, the framed control channel, and the
 * applied kernel controls. Nothing is mocked, and the guest source is the
 * committed repository bytes rather than a fixture written for this file.
 */

type Fixture = { success: Array<{ name: string; kind: "request" | "result"; value: unknown }>; rejected: Array<{ name: string; kind: "request" | "result"; path: Array<string | number>; value: unknown }> };
type Verdict = { ok: boolean; schemaId?: string; runtime?: string; code?: string; path?: Array<string | number> };
type GuestControls = { uid: number; gid: number; capabilities: string; noNewPrivileges: string; seccomp: string; memoryMax: string; swapMax: string; cpuMax: string; pidsMax: string; routes: string[]; ipv6Routes: string[]; environment: string[]; devices: string[]; gpuDevices: string[]; writableRoot: boolean; distributions: string[]; python: string; runtime: string };

const fixture = JSON.parse(await readFile(join(import.meta.dir, "fixtures/c02-conformance.json"), "utf8")) as Fixture;

let root: string;
let runner: PythonPodmanRunner;
let files: WorkspaceFiles;
let artifactDigest: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ez-python-guest-"));
  runner = new PythonPodmanRunner({ root, closure: await factoryPythonRunnerClosure() });
  files = await factoryPythonGuestFiles();
  const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  expect(build.state).toBe("succeeded");
  artifactDigest = build.artifactDigest!;
  Object.defineProperty(globalThis, "__pythonBuild", { value: build, configurable: true });
}, 900_000);

afterAll(async () => { await runner.close(); await rm(root, { recursive: true, force: true }); });

function build(): { evidence: { tests: Array<{ name: string }>; discoveryDigest: string }; manifest?: { name?: string; tools?: Array<{ name: string }> }; imageDigest: string } {
  return (globalThis as unknown as { __pythonBuild: never }).__pythonBuild;
}

async function guest<Result>(name: string, input: unknown): Promise<Result> {
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "tenant-python", scopeId: "project-python", token: "python-token", deadline: Date.now() + executionLimits.timeoutMs - 5_000 };
  const worker = await runner.start({ workerId, artifactDigest, context, limits: executionLimits, devices: [] }, async () => { throw new Error("the Python guest must never reach the broker"); });
  try { return await worker.request("extension/invoke", { name, input, context }) as Result; }
  finally { await worker.close(); }
}

test("the pinned interpreter image, the committed lock, and the guest source are all sealed into one recipe", async () => {
  expect(runner.image).toBe(DEFAULT_PYTHON_IMAGE);
  expect(runner.closure.pythonVersion).toBe((await readFile(join(import.meta.dir, "../../../.python-version"), "utf8")).trim());
  expect(runner.closure.lockDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(filesDigest(files)).toBe(await factoryPythonGuestDigest());
  const artifacts = await runner.collectArtifacts(artifactDigest);
  const recipe = JSON.parse(artifacts[".runner/recipe.json"] as string) as { runtime: string; entrypoint: string; closure: Record<string, unknown>; closureDigest: string; image: string };
  expect(recipe.runtime).toBe("python");
  expect(recipe.image).toBe(DEFAULT_PYTHON_IMAGE);
  expect(recipe.entrypoint).toBe(FACTORY_PYTHON_GUEST_ENTRYPOINT);
  expect(recipe.closure).toEqual({ pythonVersion: runner.closure.pythonVersion, lockDigest: runner.closure.lockDigest, distributions: ["pip==25.3"], models: [], resourceClass: "cpu-small" });
  expect(recipe.closureDigest).toBe(pythonClosureDigest(runner.closure));
  expect(artifacts[".runner/extension.py"]).toBe(pythonGuestLauncher(FACTORY_PYTHON_GUEST_ENTRYPOINT));
}, 120_000);

test("every build lane ran inside the isolated guest, including the committed Python suite", () => {
  const names = build().evidence.tests.map(entry => entry.name);
  expect(names.slice(0, 2)).toEqual(["syntax", "closure"]);
  expect(names).toContain("feature:tests/test_factory_validation.py");
  expect(names).toContain("feature:tests/test_factory_ijson.py");
  expect(names).toContain("feature:tests/test_factory_schema.py");
  expect(names).toContain("feature:tests/test_guest.py");
  expect(names.at(-1)).toBe("metadata-discovery");
  expect(build().manifest?.name).toBe("factory-python-runner");
  expect(build().manifest?.tools?.map(tool => tool.name)).toEqual(["validate", "run", "controls"]);
  expect(build().evidence.discoveryDigest).toMatch(/^[a-f0-9]{64}$/);
});

test("a real framed invocation crosses the FIFO control channel and answers with the guest's own verdict", async () => {
  const verdict = await guest<Verdict>("validate", { kind: "request", value: fixture.success.find(entry => entry.kind === "request")!.value });
  expect(verdict).toMatchObject({ ok: true, schemaId: "urn:ezcorp:factory:runner-request:v1", runtime: "factory.python-guest.v1" });
}, 180_000);

test("the isolated Python guest and the Bun validator agree on every committed fixture", async () => {
  for (const item of fixture.success) {
    expect(item.kind === "request" ? validateFactoryRunnerRequest(item.value) : validateFactoryRunnerResult(item.value)).toEqual({ ok: true });
    expect(await guest<Verdict>("validate", { kind: item.kind, value: item.value })).toMatchObject({ ok: true });
  }
  for (const item of fixture.rejected) {
    const base = JSON.parse(canonicalJson(fixture.success.find(success => success.kind === item.kind)!.value)) as Record<string, unknown>;
    let target: Record<string, unknown> = base;
    for (const key of item.path.slice(0, -1)) target = target[key as string] as Record<string, unknown>;
    target[item.path.at(-1) as string] = item.value;
    const bun = item.kind === "request" ? validateFactoryRunnerRequest(base) : validateFactoryRunnerResult(base);
    expect(bun.ok).toBe(false);
    const python = await guest<Verdict>("validate", { kind: item.kind, value: base });
    expect(python.ok).toBe(false);
    expect(python.code).toBe((bun as unknown as { issues: Array<{ code: string }> }).issues[0]!.code);
  }
}, 900_000);

test("a real attempt request becomes a completed result the shared contract admits", async () => {
  const request = fixture.success.find(entry => entry.kind === "request")!.value;
  const result = await guest<Record<string, unknown>>("run", request);
  expect(result.status).toBe("completed");
  expect(validateFactoryRunnerResult(result)).toEqual({ ok: true });
  expect(await guest<Record<string, unknown>>("run", request)).toEqual(result);
}, 300_000);

test("a request the shared contract refuses becomes a failed result, never a completed one", async () => {
  const request = JSON.parse(canonicalJson(fixture.success.find(entry => entry.kind === "request")!.value)) as { runner: { version: string } };
  request.runner.version = "latest";
  const result = await guest<Record<string, unknown>>("run", request);
  expect(result.status).toBe("failed");
  expect((result.error as { code: string }).code).toBe("RUNNER_PIN");
  expect(validateFactoryRunnerResult(result)).toEqual({ ok: true });
}, 180_000);

test("the guest observes the applied controls: no capability, no device, no route, and only the three declared variables", async () => {
  const report = await guest<GuestControls>("controls", {});
  expect(report.uid).toBe(65534);
  expect(report.gid).toBe(65534);
  expect(report.capabilities).toMatch(/^0+$/);
  expect(report.noNewPrivileges).toBe("1");
  expect(report.seccomp).toBe("2");
  expect(report.memoryMax).toBe(String(executionLimits.memoryBytes));
  expect(report.swapMax).toBe("0");
  expect(report.pidsMax).toBe(String(executionLimits.pids));
  expect(report.routes).toEqual([]);
  expect(report.ipv6Routes).toEqual([]);
  expect(report.writableRoot).toBe(false);
  expect(report.environment).toEqual([...RUNNER_GUEST_ENVIRONMENT]);
  expect(report.gpuDevices).toEqual([]);
  expect(report.distributions).toEqual(["pip==25.3"]);
  expect(report.python).toBe(runner.closure.pythonVersion);
  expect(Object.values(report).flat().join(" ")).not.toContain("sk-");
}, 180_000);

test("every escape a hostile package would try is refused by the kernel inside the component environment", async () => {
  const report = await guest<Record<string, boolean>>("hostile", {});
  expect(report).toEqual({
    "write-workspace": true,
    "replace-guest-source": true,
    "unlink-guest-source": true,
    "write-root": true,
    "write-channel": true,
    "unlink-channel": true,
    "symlink-channel": true,
    "read-host-secret": true,
    "open-network": true,
    "spawn-shell": true,
    "execute-from-tmp": true,
    allRefused: true,
  });
  // The guest is still whole and still answers after every refusal.
  expect(await guest<Verdict>("validate", { kind: "request", value: fixture.success.find(entry => entry.kind === "request")!.value })).toMatchObject({ ok: true });
}, 300_000);

test("a build whose declared closure does not match the pinned image fails instead of sealing an artifact", async () => {
  const drifted = new PythonPodmanRunner({ root: await mkdtemp(join(tmpdir(), "ez-python-drift-")), closure: { ...await factoryPythonRunnerClosure(), distributions: ["pip==0.0.1"] } });
  try {
    const result = await drifted.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
    expect(result.state).toBe("failed");
    expect(result.artifactDigest).toBeUndefined();
    expect(result.diagnostics.map(entry => entry.code)).toContain("dependency_closure_changed");
  } finally { await drifted.close(); }
}, 300_000);

test("a guest source that cannot be parsed never becomes an artifact", async () => {
  const broken = { ...files, "broken.py": "def missing(:\n" };
  const result = await runner.build({ operationId: randomUUID(), files: broken, sourceDigest: filesDigest(broken), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
  expect(result.state).toBe("failed");
  expect(result.artifactDigest).toBeUndefined();
}, 300_000);

test("a distribution the pinned closure never declared cannot be imported by the guest", async () => {
  const probing = { ...files, "tests/test_closure.py": "import importlib.util\nimport unittest\n\n\nclass ClosureTest(unittest.TestCase):\n    def test_no_third_party_validator_is_importable(self) -> None:\n        for name in ('jsonschema', 'pydantic', 'requests', 'numpy'):\n            self.assertIsNone(importlib.util.find_spec(name), name)\n" };
  const result = await runner.build({ operationId: randomUUID(), files: probing, sourceDigest: filesDigest(probing), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  expect(result.state).toBe("succeeded");
  expect(result.evidence.tests.map(entry => entry.name)).toContain("feature:tests/test_closure.py");
}, 300_000);

test("a Python guest with no declared test never builds, and a non-module entrypoint is refused", async () => {
  const untested: WorkspaceFiles = { "guest.py": files["guest.py"]! };
  const result = await runner.build({ operationId: randomUUID(), files: untested, sourceDigest: filesDigest(untested), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
  expect(result.state).toBe("failed");
  expect(result.diagnostics.map(entry => entry.code)).toContain("tests_missing");
  await expect(runner.build({ operationId: randomUUID(), files: { "guest.ts": "export {}" }, sourceDigest: filesDigest({ "guest.ts": "export {}" }), entrypoint: "guest.ts", limits: buildLimits })).rejects.toThrow("must be a module");
  expect(() => pythonGuestLauncher("not a module.py")).toThrow(RunnerError);
}, 300_000);
