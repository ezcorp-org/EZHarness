import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionLimits, filesDigest, RunnerError } from "../src/core";
import { RunnerClient } from "../src/client";
import { PodmanRunner } from "../src/podman";
import { startRunnerService } from "../src/service";

class UnstartedRunner extends PodmanRunner {
  launchCalled = false;
  override async initialize(): Promise<void> {}
  protected override launch(): never {
    this.launchCalled = true;
    throw new Error("No worker may start for a missing artifact");
  }
}

test("a missing runner artifact fails before worker launch with a precise diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-runner-missing-artifact-"));
  try {
    const runner = new UnstartedRunner({ root });
    const artifactDigest = filesDigest({ "extension.ts": "export {};" });
    await expect(runner.collectArtifacts(artifactDigest)).rejects.toMatchObject({
      code: "artifact_missing", message: "Runner artifact is missing from its local store",
    });
    const workerId = "missing-artifact-worker";
    const context = { workerId, invocationId: "missing-artifact-invocation", releaseId: artifactDigest,
      principalId: "owner", scopeId: "project", token: "test-token", deadline: Date.now() + 30_000 };
    const failure = await runner.start({ workerId, artifactDigest, context, limits: executionLimits },
      async () => { throw new Error("Unexpected host call"); }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerError);
    expect(failure).toMatchObject({ code: "artifact_missing" });
    expect(runner.launchCalled).toBe(false);
    expect(await runner.inspect(workerId)).toMatchObject({ state: "failed",
      diagnostics: [{ code: "artifact_missing" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing artifact still requires its exact digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-runner-corrupt-artifact-"));
  try {
    const runner = new UnstartedRunner({ root });
    const artifactDigest = filesDigest({ "extension.ts": "export {};" });
    await mkdir(join(root, "artifacts"));
    await writeFile(join(root, "artifacts", artifactDigest), JSON.stringify({ "extension.ts": "changed" }));
    await expect(runner.collectArtifacts(artifactDigest)).rejects.toMatchObject({ code: "artifact_corrupt" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Unix runner API preserves a missing-artifact error before worker launch", async () => {
  const root = await mkdtemp("/tmp/ez-runner-artifact-api-");
  const socketPath = join(root, "runner.sock");
  const token = "missing-artifact-test-token-32-bytes";
  const runner = new UnstartedRunner({ root });
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  try {
    const client = new RunnerClient({ socketPath, token });
    const artifactDigest = filesDigest({ "extension.ts": "export {};" });
    await expect(client.collectArtifacts(artifactDigest)).rejects.toMatchObject({ code: "artifact_missing" });
    const workerId = "missing-artifact-socket-worker";
    const context = { workerId, invocationId: "missing-artifact-socket-invocation", releaseId: artifactDigest,
      principalId: "owner", scopeId: "project", token: "test-token", deadline: Date.now() + 30_000 };
    const failure = await client.start({ workerId, artifactDigest, context, limits: executionLimits },
      async () => { throw new Error("Unexpected host call"); }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerError);
    expect(failure).toMatchObject({ code: "artifact_missing", message: "Runner artifact is missing from its local store" });
    expect(runner.launchCalled).toBe(false);
    expect(await client.inspect(workerId)).toMatchObject({ state: "failed",
      diagnostics: [{ code: "artifact_missing" }] });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
