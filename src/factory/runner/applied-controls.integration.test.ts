import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildLimits, executionLimits, filesDigest, PodmanRunner, PythonPodmanRunner, RUNNER_GUEST_ENVIRONMENT, RUNNER_GUEST_ENVIRONMENT_RESIDUE } from "@ezcorp/extension-runner";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { manifest as bunManifest, provision, source } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import { FACTORY_PYTHON_GUEST_ENTRYPOINT, factoryPythonGuestFiles, factoryPythonRunnerClosure } from "./python-guest";

/**
 * Applied-control verification from the host.
 *
 * C05 requires the applied configuration to be read from the supervisor and the
 * container runtime, not from output the sandbox chose to print. Every fact
 * below is taken from `podman inspect` on the live container while the guest is
 * running, and the guest's own report is then compared with it, so a control the
 * runtime claims but the kernel did not apply cannot pass unseen in either
 * direction. Both pinned guest languages are measured through the same
 * assertions, because they share one launch path.
 */

type Inspection = {
  HostConfig: { NetworkMode: string; ReadonlyRootfs: boolean; CapAdd?: string[] | null; CapDrop?: string[] | null; SecurityOpt: string[]; Devices?: Array<{ PathOnHost: string }> | null; Memory: number; MemorySwap: number; PidsLimit: number; CpuQuota: number; Privileged: boolean; Binds?: string[] | null; Mounts?: Array<{ Destination: string; RW: boolean }> | null };
  Config: { User: string; Env?: string[] | null; Hostname: string };
  EffectiveCaps?: string;
  BoundingCaps?: string;
  Mounts?: Array<{ Destination: string; RW: boolean }>;
};

type GuestControls = { uid: number; gid: number; capabilities: string; noNewPrivileges: string; seccomp: string; memoryMax: string; swapMax: string; cpuMax: string; pidsMax: string; routes: string[]; ipv6Routes: string[]; environment: string[]; devices: string[]; gpuDevices: string[]; writableRoot: boolean; distributions: string[]; python: string; runtime: string };

const BUN_CONTROLS = `async () => { const fs = require("node:fs"); const read = p => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return "unavailable"; } }; const status = read("/proc/self/status"); const field = name => (status.split("\\n").find(line => line.split(":")[0] === name) ?? "").split(":")[1]?.trim() ?? ""; let writableRoot = true; try { fs.writeFileSync("/root-write-probe", "x"); } catch { writableRoot = false; } const devices = fs.existsSync("/dev") ? fs.readdirSync("/dev").sort() : []; return { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, capabilities: field("CapEff"), noNewPrivileges: field("NoNewPrivs"), seccomp: field("Seccomp"), memoryMax: read("/sys/fs/cgroup/memory.max"), swapMax: read("/sys/fs/cgroup/memory.swap.max"), cpuMax: read("/sys/fs/cgroup/cpu.max"), pidsMax: read("/sys/fs/cgroup/pids.max"), routes: read("/proc/net/route").split("\\n").filter(Boolean).slice(1), ipv6Routes: read("/proc/net/ipv6_route").split("\\n").filter(line => line && !line.endsWith("lo")), environment: Object.keys(process.env).sort(), devices, gpuDevices: devices.filter(name => name === "kfd" || name === "dri"), writableRoot, distributions: [], python: "", runtime: "bun" }; }`;

let bunRoot: string;
let pythonRoot: string;
let bunRunner: PodmanRunner;
let pythonRunner: PythonPodmanRunner;
let bunArtifact: string;
let pythonArtifact: string;

async function inspect(name: string): Promise<Inspection> {
  const process = Bun.spawn(["podman", "inspect", "--format={{json .}}", name], { stdout: "pipe", stderr: "pipe" });
  const [code, text] = await Promise.all([process.exited, new Response(process.stdout).text()]);
  expect(code, await new Response(process.stderr).text()).toBe(0);
  return JSON.parse(text) as Inspection;
}

function containerName(root: string, workerId: string): string {
  return `ez-v4-${new Bun.CryptoHasher("sha256").update(`${root}:${workerId}`).digest("hex").slice(0, 32)}`;
}

beforeAll(async () => {
  bunRoot = await mkdtemp(join(tmpdir(), "ez-controls-bun-"));
  pythonRoot = await mkdtemp(join(tmpdir(), "ez-controls-python-"));
  // The host configures a GPU device profile so the empty factory grant below is
  // proved against a host that could have injected one.
  const configuredDevices = ["/dev/kfd", "/dev/dri/renderD128"];
  bunRunner = new PodmanRunner({ root: bunRoot, configuredDevices, ...await provision() });
  const bunFiles = source(BUN_CONTROLS);
  const built = await bunRunner.build({ operationId: randomUUID(), files: bunFiles, sourceDigest: filesDigest(bunFiles), entrypoint: "extension.ts", limits: buildLimits });
  expect(built.diagnostics).toEqual([]);
  bunArtifact = built.artifactDigest!;

  pythonRunner = new PythonPodmanRunner({ root: pythonRoot, configuredDevices, closure: await factoryPythonRunnerClosure() });
  const pythonFiles: WorkspaceFiles = await factoryPythonGuestFiles();
  const sealed = await pythonRunner.build({ operationId: randomUUID(), files: pythonFiles, sourceDigest: filesDigest(pythonFiles), entrypoint: FACTORY_PYTHON_GUEST_ENTRYPOINT, limits: buildLimits });
  expect(sealed.diagnostics).toEqual([]);
  pythonArtifact = sealed.artifactDigest!;
}, 900_000);

afterAll(async () => {
  await bunRunner.close();
  await pythonRunner.close();
  await rm(bunRoot, { recursive: true, force: true });
  await rm(pythonRoot, { recursive: true, force: true });
});

async function measure(language: "bun" | "python"): Promise<{ applied: Inspection; reported: GuestControls }> {
  const runner = language === "bun" ? bunRunner : pythonRunner;
  const root = language === "bun" ? bunRoot : pythonRoot;
  const artifactDigest = language === "bun" ? bunArtifact : pythonArtifact;
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "tenant-controls", scopeId: "project-controls", token: "controls-token", deadline: Date.now() + executionLimits.timeoutMs - 5_000 };
  const worker = await runner.start({ workerId, artifactDigest, context, limits: executionLimits, devices: [] }, async () => { throw new Error("an applied-control probe never reaches the broker"); });
  try {
    const reported = await worker.request("extension/invoke", { name: language === "bun" ? "echo" : "controls", input: {}, context }) as GuestControls;
    const applied = await inspect(containerName(root, workerId));
    return { applied, reported };
  } finally { await worker.close(); }
}

test.each(["bun", "python"] as const)("%s: the runtime API and the guest agree on every applied control", async language => {
  const { applied, reported } = await measure(language);

  // Namespaces and egress.
  expect(applied.HostConfig.NetworkMode).toBe("none");
  expect(reported.routes).toEqual([]);
  expect(reported.ipv6Routes).toEqual([]);

  // Filesystem.
  expect(applied.HostConfig.ReadonlyRootfs).toBe(true);
  expect(reported.writableRoot).toBe(false);
  const writable = (applied.Mounts ?? applied.HostConfig.Mounts ?? []).filter(mount => mount.RW && mount.Destination !== "/tmp");
  expect(writable).toEqual([]);

  // Privilege.
  expect(applied.HostConfig.Privileged).toBe(false);
  // Podman expands `--cap-drop=ALL` into the explicit set it would otherwise
  // have granted, so the runtime API is read as "every default dropped and none
  // added", and the guest's own all-zero effective set below is the outcome.
  expect(applied.HostConfig.CapAdd ?? []).toEqual([]);
  for (const capability of ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FOWNER", "CAP_FSETID", "CAP_KILL", "CAP_NET_BIND_SERVICE", "CAP_SETFCAP", "CAP_SETGID", "CAP_SETPCAP", "CAP_SETUID", "CAP_SYS_CHROOT"]) {
    expect(applied.HostConfig.CapDrop).toContain(capability);
  }
  expect(applied.HostConfig.SecurityOpt).toContain("no-new-privileges");
  expect(applied.HostConfig.SecurityOpt.some(option => option.startsWith("seccomp="))).toBe(true);
  expect(applied.Config.User).toBe("65534:65534");
  expect(reported.uid).toBe(65534);
  expect(reported.gid).toBe(65534);
  expect(reported.capabilities).toMatch(/^0+$/);
  expect(reported.noNewPrivileges).toBe("1");
  expect(reported.seccomp).toBe("2");

  // Cgroups.
  expect(applied.HostConfig.Memory).toBe(executionLimits.memoryBytes);
  expect(applied.HostConfig.MemorySwap).toBe(executionLimits.memoryBytes);
  expect(applied.HostConfig.PidsLimit).toBe(executionLimits.pids);
  expect(reported.memoryMax).toBe(String(executionLimits.memoryBytes));
  expect(reported.swapMax).toBe("0");
  expect(reported.pidsMax).toBe(String(executionLimits.pids));
  expect(reported.cpuMax).toBe(`${applied.HostConfig.CpuQuota} 100000`);

  // Devices: the host configures two and this start was granted none.
  expect(applied.HostConfig.Devices ?? []).toEqual([]);
  expect(reported.gpuDevices).toEqual([]);

  // Environment. The declared variables are always present, and the only
  // other names permitted are the ones the OCI runtime writes after podman has
  // built the spec, with fixed, tenant-independent values.
  const permitted = new Set([...RUNNER_GUEST_ENVIRONMENT, ...RUNNER_GUEST_ENVIRONMENT_RESIDUE]);
  for (const name of RUNNER_GUEST_ENVIRONMENT) expect(reported.environment).toContain(name);
  expect(reported.environment.filter(name => !permitted.has(name))).toEqual([]);
  expect(applied.Config.Hostname).toBe("guest");
  const declared = (applied.Config.Env ?? []).map(entry => entry.split("=")[0]).sort();
  for (const name of RUNNER_GUEST_ENVIRONMENT) expect(declared).toContain(name);
  expect(declared.filter(name => !permitted.has(name))).toEqual([]);
}, 300_000);

test("no provider credential, publish credential, or attempt secret reaches either guest's environment", async () => {
  for (const language of ["bun", "python"] as const) {
    const { applied, reported } = await measure(language);
    const values = (applied.Config.Env ?? []).join("\n");
    for (const secret of ["sk-", "AKIA", "ghp_", "PASSWORD", "SECRET", "TOKEN", "API_KEY", "CREDENTIAL"]) {
      expect(values.toUpperCase()).not.toContain(secret.toUpperCase());
      expect(reported.environment.join("\n").toUpperCase()).not.toContain(secret.toUpperCase());
    }
    // The attempt token crosses the control channel inside the invocation
    // context; it is never written into the container's environment.
    expect(values).not.toContain("controls-token");
  }
}, 300_000);

test("the Bun guest's manifest is discovered inside the container, never imported by the host", async () => {
  // The manifest is data the host reads back over a control frame from a guest
  // whose reverse channel denies every host capability, so an import-time side
  // effect in author source cannot run outside the sandbox.
  const files = source(`async () => { throw new Error("never invoked"); }`);
  files["extension.ts"] = `globalThis.__host_side_effect = true;\n${files["extension.ts"]}`;
  const built = await bunRunner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(built.diagnostics).toEqual([]);
  expect(built.manifest?.name).toBe(bunManifest.name);
  expect((globalThis as Record<string, unknown>).__host_side_effect).toBeUndefined();
}, 300_000);

test("the pinned seccomp profile really is deny-by-default and is bound to the built release", async () => {
  const profile = JSON.parse(await readFile(new URL("../../../packages/@ezcorp/extension-runner/seccomp.json", import.meta.url).pathname, "utf8")) as { defaultAction: string };
  expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  const artifacts = await pythonRunner.collectArtifacts(pythonArtifact);
  const recipe = JSON.parse(artifacts[".runner/recipe.json"] as string) as { seccompDigest: string };
  expect(recipe.seccompDigest).toMatch(/^[a-f0-9]{64}$/);
});
