import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createFactoryOrchestrationReadinessWriter } from "../../../../src/factory/orchestration-readiness-writer.ts";
import { readFactoryOrchestrationReadiness } from "../../../../src/factory/orchestration-readiness.ts";

const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;

function options(path: string) {
  return {
    installationId: "installation-1", tenantId: "tenant-1", namespace: "tenant-1", taskQueue: "factory-orchestrator",
    readinessFilePath: path, readinessHeartbeatMs: 1_000,
  } as const;
}

test("the Node writer atomically publishes only a fully ready process", async () => {
  const directory = await mkdtemp(join(runtimeRoot, "factory-readiness-writer-"));
  await chmod(directory, 0o700);
  try {
    const path = join(directory, "ready.json");
    const writer = createFactoryOrchestrationReadinessWriter(options(path), () => 1_000);
    const starting = await writer.write({ lifecycle: "starting", workerPolling: false, dispatcherLive: false, credentialGeneration: 0 });
    assert.equal(starting.lifecycle, "starting");
    await assert.rejects(readFactoryOrchestrationReadiness(options(path), () => 1_000));
    await unlink(path);
    await symlink("foreign", path);
    const ready = await writer.write({ lifecycle: "ready", workerPolling: true, dispatcherLive: true, credentialGeneration: 1 });
    assert.deepEqual(ready, {
      schemaVersion: "factory.orchestrator-readiness.v1", installationId: "installation-1", tenantId: "tenant-1", namespace: "tenant-1",
      taskQueue: "factory-orchestrator", lifecycle: "ready", observedAtMs: 1_000, workerPolling: true, dispatcherLive: true, credentialGeneration: 1,
    });
    assert.deepEqual(await readFactoryOrchestrationReadiness(options(path), () => 3_999), ready);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), ready);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the writer rejects unsafe configuration and premature ready states", async () => {
  assert.throws(() => createFactoryOrchestrationReadinessWriter({ ...options("/tmp/ready"), readinessHeartbeatMs: 999 }), /configuration is invalid/);
  const directory = await mkdtemp(join(runtimeRoot, "factory-readiness-invalid-"));
  await chmod(directory, 0o700);
  try {
    const writer = createFactoryOrchestrationReadinessWriter(options(join(directory, "ready.json")), () => 1_000);
    await assert.rejects(writer.write({ lifecycle: "ready", workerPolling: false, dispatcherLive: true, credentialGeneration: 1 }), /state is invalid/);
    await assert.rejects(writer.write({ lifecycle: "failed", workerPolling: false, dispatcherLive: false, credentialGeneration: 1, errorCode: "raw Error: secret" }), /state is invalid/);
    const failed = await writer.write({ lifecycle: "failed", workerPolling: false, dispatcherLive: false, credentialGeneration: 1, errorCode: "factory_worker_failed" });
    assert.equal(failed.errorCode, "factory_worker_failed");
    const unusable = createFactoryOrchestrationReadinessWriter(options(join(directory, `${"x".repeat(256)}.json`)), () => 1_000);
    await assert.rejects(unusable.write({ lifecycle: "starting", workerPolling: false, dispatcherLive: false, credentialGeneration: 0 }), /ENAMETOOLONG/);
    assert.equal((await readFile(join(directory, "ready.json"), "utf8")).includes("factory_worker_failed"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
