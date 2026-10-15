import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, executionLimits, filesDigest } from "@ezcorp/extension-runner";
import { provision, source } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import {
  FACTORY_SANDBOX_ABORT_GRACE_MS,
  FACTORY_SANDBOX_POLL_INTERVAL_MS,
  factoryRunnerSandboxControl,
  stopFactorySandbox,
  type FactorySandboxControl,
} from "./sandbox-stop";

const workerFor = (seed: string) => `factory_${createHash("sha256").update(seed).digest("hex").slice(0, 48)}`;
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function context(workerId: string, releaseId: string) {
  return { workerId, invocationId: `${workerId}-invocation`, releaseId, principalId: "tenant-sandbox", scopeId: "project-sandbox", token: `factory-runner:${workerId}`, deadline: Date.now() + 120_000 };
}

/**
 * C02.14 against a real rootless Podman sandbox: abort, at most ten seconds of
 * cleanup, then kill the whole sandbox and confirm from the runtime that no
 * process remains.
 */
test("a real sandbox cleans up inside its budget, and one that ignores the signal is killed and confirmed gone", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-sandbox-stop-"));
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    const files = source("async (input) => input");
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    const artifactDigest = build.artifactDigest!;

    // The cooperative case. The sandbox's init process is signalled and the
    // whole namespace exits, so the kill phase is never reached.
    const cooperative = workerFor("sandbox-cooperative");
    const cooperativeExecution = await runner.start({ workerId: cooperative, artifactDigest, context: context(cooperative, artifactDigest), limits: executionLimits }, async () => ({}));
    expect((await runner.inspect(cooperative)).state).toBe("running");
    const control = factoryRunnerSandboxControl(runner);
    let kills = 0;
    const counted: FactorySandboxControl = { ...control, async terminate(workerId) { kills += 1; await control.terminate(workerId); } };
    const cleaned = await stopFactorySandbox(counted, cooperative, { graceMs: FACTORY_SANDBOX_ABORT_GRACE_MS, pollIntervalMs: FACTORY_SANDBOX_POLL_INTERVAL_MS, now: Date.now, wait });
    expect(cleaned).toMatchObject({ disposition: "cleaned", processGroupAbsent: true });
    expect(cleaned.cleanupPolls).toBeGreaterThanOrEqual(1);
    expect(kills).toBe(0);
    // The runtime, not the caller, is what says the sandbox is gone.
    expect(["succeeded", "failed", "cancelled"]).toContain((await runner.inspect(cooperative)).state);
    await cooperativeExecution.close();

    // The stubborn case. The abort reports that it was delivered but nothing
    // reaches the guest, so the budget runs out and the sandbox is killed.
    const stubborn = workerFor("sandbox-stubborn");
    const stubbornExecution = await runner.start({ workerId: stubborn, artifactDigest, context: context(stubborn, artifactDigest), limits: executionLimits }, async () => ({}));
    expect((await runner.inspect(stubborn)).state).toBe("running");
    let ignored = 0;
    const undeliverable: FactorySandboxControl = { ...control, async abort() { ignored += 1; return true; } };
    const terminated = await stopFactorySandbox(undeliverable, stubborn, { graceMs: 1_000, pollIntervalMs: 250, now: Date.now, wait });
    expect(ignored).toBe(1);
    expect(terminated).toMatchObject({ disposition: "terminated", processGroupAbsent: true });
    expect(terminated.cleanupPolls).toBeGreaterThanOrEqual(1);
    expect(["succeeded", "failed", "cancelled", "unknown"]).toContain((await runner.inspect(stubborn)).state);
    await stubbornExecution.close();

    // A worker the runtime has never heard of is not "absent": an inspect that
    // cannot find it proves nothing, so the stop still kills and re-observes.
    expect(await control.present(workerFor("sandbox-absent"))).toBe(true);
  } finally {
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
