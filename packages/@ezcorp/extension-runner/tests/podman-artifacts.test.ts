import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { executionLimits, filesDigest, RunnerError, RunnerStartRefusedError } from "../src/core";
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
      code: "artifact_missing", message: "The release's artifact is not in this runner's store",
    });
    const workerId = "missing-artifact-worker";
    const context = { workerId, invocationId: "missing-artifact-invocation", releaseId: artifactDigest,
      principalId: "owner", scopeId: "project", token: "test-token", deadline: Date.now() + 30_000 };
    const failure = await runner.start({ workerId, artifactDigest, context, limits: executionLimits },
      async () => { throw new Error("Unexpected host call"); }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RunnerError);
    expect(failure).toMatchObject({ code: "artifact_missing" });
    expect(runner.launchCalled).toBe(false);
    expect(await runner.inspect(workerId)).toEqual({ id: workerId, state: "unknown", diagnostics: [] });
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
    expect(failure).toMatchObject({ code: "artifact_missing", message: "The release's artifact is not in this runner's store" });
    expect(runner.launchCalled).toBe(false);
    expect(await client.inspect(workerId)).toEqual({ id: workerId, state: "unknown", diagnostics: [] });
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

class ProfileBoundaryRunner extends PodmanRunner {
  staged = false; launched = false;
  protected override async prepare(): Promise<void> {}
  protected override async stage(): Promise<string> { this.staged = true; throw new Error("stage boundary reached"); }
  protected override async launchDetached(): Promise<never> { this.launched = true; throw new Error("worker boundary reached"); }
}

for (const mismatch of ["image", "seccomp"] as const) {
 test(`actual runner ${mismatch} mismatch is a proven pre-start refusal over the authenticated Unix API`, async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-profile-refusal-"));
  const seccompPath = join(root, "seccomp.json");
  await writeFile(seccompPath, "{}");
  const runner = new ProfileBoundaryRunner({ root, seccompPath });
  const files = { "extension.ts": "export {};", ".runner/recipe.json": JSON.stringify({ image: mismatch === "image" ? "other-image" : runner.image, seccompDigest: mismatch === "seccomp" ? "0".repeat(64) : createHash("sha256").update("{}").digest("hex") }) };
  const artifactDigest = filesDigest(files);
  await mkdir(join(root, "artifacts")); await writeFile(join(root, "artifacts", artifactDigest), JSON.stringify(files));
  const socketPath = join(root, "runner.sock"); const token = "profile-refusal-32-byte-test-token";
  const service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
  let rpc = 0;
  try {
   const client = new RunnerClient({ socketPath, token });
   const workerId = `profile-${mismatch}`;
   const context = { workerId, invocationId: workerId, releaseId: artifactDigest, principalId: "owner", scopeId: "project", token: "test-token", deadline: Date.now() + 30_000 };
   const error = await client.start({ workerId, artifactDigest, context, limits: executionLimits }, async () => { rpc++; throw new Error("no RPC"); }).catch(error => error);
   expect(error).toBeInstanceOf(RunnerStartRefusedError);
   expect(error).toMatchObject({ code: "runtime_profile_changed" });
   expect(runner.staged).toBe(false); expect(runner.launched).toBe(false); expect(rpc).toBe(0);
   expect(await client.inspect(workerId)).toMatchObject({ state: "failed" });
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
 }, 30_000);
}
