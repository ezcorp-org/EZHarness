import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFactoryOrchestrationReadiness, type FactoryOrchestrationReadinessOptions } from "../factory/orchestration-readiness";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const observedAtMs = 1_900_000_000_000;
async function fixture() {
  const directory = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid!()}`, "factory-readiness-"));
  directories.push(directory);
  const options: FactoryOrchestrationReadinessOptions = { installationId: "installation-a", tenantId: "tenant-a", namespace: "namespace-a", taskQueue: "factory-kernel-v1", readinessFilePath: join(directory, "orchestration.json"), readinessHeartbeatMs: 5_000 };
  const state = { schemaVersion: "factory.orchestrator-readiness.v1", installationId: options.installationId, tenantId: options.tenantId, namespace: options.namespace, taskQueue: options.taskQueue, lifecycle: "ready", observedAtMs, workerPolling: true, dispatcherLive: true, credentialGeneration: 1 } as const;
  const write = async (value: unknown) => {
    const temporary = join(directory, "next.json");
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, options.readinessFilePath);
  };
  await write(state);
  return { directory, options, state, write };
}

test("readiness accepts only a fresh private status for the exact installation worker and dispatcher", async () => {
  const { options, state } = await fixture();
  expect(await readFactoryOrchestrationReadiness(options, () => observedAtMs)).toEqual(state);
  expect(await readFactoryOrchestrationReadiness(options, () => observedAtMs + 15_000)).toEqual(state);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs + 15_001)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs - 1)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
});

test("foreign, incomplete and non-ready process states cannot open admission", async () => {
  const { options, state, write } = await fixture();
  const invalid: unknown[] = [null, [], {}, "ready", { ...state, schemaVersion: "v2" }, { ...state, extra: true }, { ...state, errorCode: "failed" }];
  for (const key of ["installationId", "tenantId", "namespace", "taskQueue"]) invalid.push({ ...state, [key]: "foreign" });
  for (const lifecycle of ["starting", "stopping", "failed", "unknown"]) invalid.push({ ...state, lifecycle });
  for (const key of ["workerPolling", "dispatcherLive"]) invalid.push({ ...state, [key]: false }, { ...state, [key]: "true" });
  for (const credentialGeneration of [0, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) invalid.push({ ...state, credentialGeneration });
  for (const observedAtMs of [-1, "now", 0.5]) invalid.push({ ...state, observedAtMs });
  const { taskQueue: _taskQueue, ...withoutQueue } = state;
  invalid.push(withoutQueue, { ...withoutQueue, hiddenQueue: "factory-kernel-v1" });
  for (const value of invalid) {
    await write(value);
    await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  }
});

test("the readiness path rejects unsafe files and malformed bytes without disclosing them", async () => {
  const { directory, options, state, write } = await fixture();
  for (const content of ["private-value-must-not-leak", "x".repeat(4_097), "", Uint8Array.from([0xff])]) {
    await writeFile(options.readinessFilePath, content, { mode: 0o600 });
    await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable", message: "Factory orchestration has no verified live readiness state." });
  }
  await write(state);
  await chmod(options.readinessFilePath, 0o640);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await chmod(options.readinessFilePath, 0o600);
  await chmod(directory, 0o750);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await chmod(directory, 0o700);
  const target = join(directory, "target.json");
  await rename(options.readinessFilePath, target);
  await symlink(target, options.readinessFilePath);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await rm(options.readinessFilePath);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  const fifo = Bun.spawn(["mkfifo", "-m", "600", options.readinessFilePath], { stdout: "pipe", stderr: "pipe" });
  expect(await fifo.exited).toBe(0);
  await expect(readFactoryOrchestrationReadiness(options, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
});

test("readiness snapshots its scope and validates the configured heartbeat and clock", async () => {
  const { options, state, write } = await fixture();
  const mutable = { ...options };
  const pending = readFactoryOrchestrationReadiness(mutable, () => observedAtMs);
  mutable.tenantId = "foreign";
  mutable.readinessFilePath = "/missing";
  expect(await pending).toEqual(state);
  expect(await readFactoryOrchestrationReadiness({ ...options, readinessHeartbeatMs: undefined }, () => observedAtMs)).toEqual(state);
  for (const readinessHeartbeatMs of [0, 999, 60_001, 1_000.5]) await expect(readFactoryOrchestrationReadiness({ ...options, readinessHeartbeatMs }, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  for (const tenantId of ["", "x".repeat(513), "bad\0id"]) await expect(readFactoryOrchestrationReadiness({ ...options, tenantId }, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await expect(readFactoryOrchestrationReadiness({ ...options, readinessFilePath: "" }, () => observedAtMs)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  for (const now of [-1, 0.5, NaN]) await expect(readFactoryOrchestrationReadiness(options, () => now)).rejects.toMatchObject({ code: "factory_orchestration_unavailable" });
  await write({ ...state, observedAtMs: Date.now() });
  expect(await readFactoryOrchestrationReadiness(options)).toMatchObject({ lifecycle: "ready", credentialGeneration: 1 });
});
