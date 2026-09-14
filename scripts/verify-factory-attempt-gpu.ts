#!/usr/bin/env bun
/**
 * The local AMD GPU proof for the per-attempt device grant.
 *
 * `verify-factory-local-gpu.sh` proves that this host can run real ROCm
 * computation in a fresh isolated container. This script proves the other half:
 * that the factory's own launch path gives an attempt exactly the devices its
 * held allocation authorized, through the same shared Podman runner an attempt
 * uses, and nothing else.
 *
 * It holds the user-scoped GPU lock for its whole run, so it never contends with
 * the ROCm fixture or another copy of itself. It changes no GPU configuration
 * and reimages nothing.
 *
 * Usage: bun scripts/verify-factory-attempt-gpu.ts [--out <path>]
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildLimits, executionLimits, filesDigest, PodmanRunner, startExecutionDevices } from "@ezcorp/extension-runner";
import { provisionToolchain } from "../packages/@ezcorp/extension-runner/src/provision";
import { factoryAttemptDeviceGrant, factoryHeldAllocationDevices, type FactoryAttemptLease } from "../src/factory/runner/attempt-runtime";

/** The supported local profile: both render nodes, because this ROCm runtime fails initialization with only the discrete device. */
const LOCAL_AMD_PROFILE = Object.freeze({ hostId: "local-amd-host", devices: Object.freeze(["/dev/kfd", "/dev/dri/renderD128", "/dev/dri/renderD129"]), cdiDevices: Object.freeze([] as readonly string[]) });
const GPU_LOCK = `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1001"}/ezcorp-factory-local-gpu.lock`;

const lease: FactoryAttemptLease = { reservationId: "gpu-reservation", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "gpu-allocation", hostId: LOCAL_AMD_PROFILE.hostId };

const REPORT = `async () => { const fs = require("node:fs"); const read = p => { try { return fs.readdirSync(p).sort(); } catch { return null; } }; let readable = false; try { fs.closeSync(fs.openSync("/dev/kfd", "r")); readable = true; } catch {} return { kfd: fs.existsSync("/dev/kfd"), kfdReadable: readable, dri: read("/dev/dri"), dev: read("/dev") }; }`;

type Report = { kfd: boolean; kfdReadable: boolean; dri: string[] | null; dev: string[] };
type Case = { name: string; expectation: string; verdict: "pass" | "fail"; detail: unknown };

const results: Case[] = [];
function record(name: string, expectation: string, ok: boolean, detail: unknown): void {
  results.push({ name, expectation, verdict: ok ? "pass" : "fail", detail });
}

/** Holds the user-scoped GPU lock for the whole run; a second copy waits rather than sharing the device. */
async function withGpuLock<Value>(action: () => Promise<Value>): Promise<Value> {
  const handle = await open(GPU_LOCK, "a");
  const lock = Bun.spawn(["flock", "--exclusive", String(handle.fd), "/bin/sh", "-c", "echo HELD; cat >/dev/null"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  try {
    const reader = lock.stdout.getReader();
    const first = await reader.read();
    if (new TextDecoder().decode(first.value).trim() !== "HELD") throw new Error("Could not take the local GPU lock.");
    return await action();
  } finally { lock.kill(); await lock.exited.catch(() => undefined); await handle.close(); }
}

async function main(): Promise<number> {
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : "";
  const root = await mkdtemp(join(tmpdir(), "ez-factory-gpu-"));
  // The host configures the full local profile, exactly the host-global list a
  // factory start must never inherit.
  const runner = new PodmanRunner({ root, configuredDevices: LOCAL_AMD_PROFILE.devices, ...await provisionToolchain({ sdkEntrypoint: process.env.EZ_RUNNER_SDK_ENTRY }) });
  try {
    const files = (await import("../packages/@ezcorp/extension-runner/tests/helpers")).source(REPORT);
    const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`guest build failed: ${JSON.stringify(build.diagnostics)}`);
    const artifactDigest = build.artifactDigest!;

    const probe = async (devices: readonly string[]): Promise<Report> => {
      const workerId = randomUUID();
      const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "gpu-tenant", scopeId: "gpu-project", token: "gpu-token", deadline: Date.now() + executionLimits.timeoutMs - 5_000 };
      const worker = await runner.start({ workerId, artifactDigest, context, limits: executionLimits, devices }, async () => { throw new Error("a GPU probe never reaches the broker"); });
      try { return await worker.request("extension/invoke", { name: "echo", input: {}, context }) as Report; }
      finally { await worker.close(); }
    };

    const cpuAuthorization = factoryHeldAllocationDevices(lease, {}, LOCAL_AMD_PROFILE);
    const cpuGrant = factoryAttemptDeviceGrant("gpu-attempt-cpu", lease, cpuAuthorization);
    const cpu = await probe(cpuGrant.devices);
    record("cpu-attempt-has-no-device", "A CPU attempt sees no GPU device although the host configures three", cpu.kfd === false && cpu.dri === null, { grant: cpuGrant.devices, observed: cpu });

    const gpuAuthorization = factoryHeldAllocationDevices(lease, { "gpu-host": 1 }, LOCAL_AMD_PROFILE);
    const gpuGrant = factoryAttemptDeviceGrant("gpu-attempt-allocated", lease, gpuAuthorization);
    const gpu = await probe(gpuGrant.devices);
    record("allocated-attempt-has-exactly-its-grant", "A held gpu-host allocation reaches the exact devices its grant names, readable inside the guest", gpu.kfd === true && gpu.kfdReadable === true && JSON.stringify(gpu.dri) === JSON.stringify(["renderD128", "renderD129"]), { grant: gpuGrant.devices, capabilities: gpuGrant.capabilities, observed: gpu });

    const narrow = await probe(["/dev/dri/renderD128"]);
    record("narrower-grant-is-exact", "A grant naming one render node reaches that node and no other", narrow.kfd === false && JSON.stringify(narrow.dri) === JSON.stringify(["renderD128"]), { observed: narrow });

    let unapproved = "";
    try { factoryAttemptDeviceGrant("gpu-attempt-unapproved", lease, { devices: LOCAL_AMD_PROFILE.devices }); }
    catch (error) { unapproved = (error as Error).message; }
    record("unapproved-grant-denied", "A device grant without a held gpu-host allocation is denied before any launch", unapproved.includes("requires a held gpu-host allocation"), { message: unapproved });

    let unsupported = "";
    try { startExecutionDevices(["/dev/nvidia0"], LOCAL_AMD_PROFILE.devices); }
    catch (error) { unsupported = (error as Error).message; }
    record("unsupported-profile-denied", "A device outside the supported local profile is refused by the shared validator", unsupported.includes("Runner device configuration is invalid"), { message: unsupported });

    let cdi = "";
    try { factoryAttemptDeviceGrant("gpu-attempt-cdi", lease, factoryHeldAllocationDevices(lease, { "gpu-host": 1 }, { ...LOCAL_AMD_PROFILE, devices: [], cdiDevices: ["nvidia.com/gpu=0"] })); }
    catch (error) { cdi = (error as Error).message; }
    record("cdi-profile-unavailable", "The production CDI profile has no implementation on this host, and a CDI grant cannot start an attempt", cdi === "" , { note: "The grant is well formed; IsolatedFactoryAttemptRuntime refuses it at start. See attempt-devices.test.ts." });
  } finally {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }

  const failed = results.filter(entry => entry.verdict === "fail");
  const report = { schemaVersion: "factory.local-gpu-attempt-proof.v1", host: LOCAL_AMD_PROFILE.hostId, profile: { devices: [...LOCAL_AMD_PROFILE.devices], cdiDevices: [...LOCAL_AMD_PROFILE.cdiDevices] }, cases: results, verdict: failed.length === 0 ? "pass" : "fail" };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (out) await writeFile(out, text);
  process.stdout.write(text);
  return failed.length === 0 ? 0 : 1;
}

process.exitCode = await withGpuLock(main);
