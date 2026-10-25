import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_IMAGE, executionLimits, filesDigest, PodmanRunner, RunnerError } from "../src";

import { sha256 } from "../src/core";

/** A runner over a given store; storeArtifact is what a successful build calls. */
class StoreRunner extends PodmanRunner {
  put(digest: string, files: Record<string, string>) { return this.storeArtifact(digest, files); }
}
const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });
async function store() { const root = await mkdtemp(join(tmpdir(), "ez-runner-store-")); roots.push(root); await mkdir(join(root, "artifacts"), { mode: 0o700 }); return root; }
const files = { "extension.js": "export {};", ".runner/recipe.json": "{}" };
const artifact = filesDigest(files);

test("two boots on one kept store: the second runner serves the release the first one built", async () => {
  const root = await store();
  const first = new StoreRunner({ root });
  await first.put(artifact, files);
  const second = new StoreRunner({ root });
  expect(await second.collectArtifacts(artifact)).toEqual(files);
});

test("a store that lacks the release's artifact refuses by name, artifact_missing, naming the cause ENOENT (real-8)", async () => {
  const first = new StoreRunner({ root: await store() });
  await first.put(artifact, files);
  const fresh = new StoreRunner({ root: await store() });
  await expect(fresh.collectArtifacts(artifact)).rejects.toMatchObject({ code: "artifact_missing", detail: { errorClass: "Error", errorCode: "ENOENT" } });
});

/** A runner whose kernel probe is a no-op, so a start runs up to the artifact and recipe checks without Podman. */
class UnprobedRunner extends StoreRunner {
  protected override async probeSecurity(): Promise<void> {}
}
const open: PodmanRunner[] = [];
afterAll(async () => { for (const runner of open) await runner.close(); });
function boot<T extends PodmanRunner>(runner: T): T { open.push(runner); return runner; }
function startRequest(workerId: string) {
  const deadline = Date.now() + 60_000;
  return { workerId, artifactDigest: artifact, context: { invocationId: `${workerId}-call`, workerId, releaseId: "release", principalId: "principal", scopeId: "scope", token: "token", deadline }, limits: executionLimits, processSpawn: "deny" as const };
}
const noReverse = async () => { throw new Error("unused"); };

test("a kept installation whose runner store is fresh takes the release back through restoreArtifact, and the next boot serves it (W4H-32)", async () => {
  const root = await store();
  await boot(new StoreRunner({ root })).put(artifact, files);
  await rm(root, { recursive: true, force: true });
  const second = boot(new StoreRunner({ root }));
  await expect(second.collectArtifacts(artifact)).rejects.toMatchObject({ code: "artifact_missing" });
  await second.restoreArtifact(artifact, files);
  expect(await second.collectArtifacts(artifact)).toEqual(files);
  await second.close();
  expect(await boot(new StoreRunner({ root })).collectArtifacts(artifact)).toEqual(files);
});

test("restoring an artifact the store already holds is a no-op: the stored file is not rewritten (W4H-32)", async () => {
  const root = await store();
  const runner = boot(new StoreRunner({ root }));
  await runner.restoreArtifact(artifact, files);
  const before = await stat(join(root, "artifacts", artifact));
  await runner.restoreArtifact(artifact, files);
  const after = await stat(join(root, "artifacts", artifact));
  expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  expect(await runner.collectArtifacts(artifact)).toEqual(files);
});

test("restore refuses files that do not digest to the key, artifact_corrupt, and stores nothing (W4H-32)", async () => {
  const runner = boot(new StoreRunner({ root: await store() }));
  await expect(runner.restoreArtifact(artifact, { ...files, "extension.js": "export const changed = 1;" })).rejects.toMatchObject({ code: "artifact_corrupt" });
  await expect(runner.collectArtifacts(artifact)).rejects.toMatchObject({ code: "artifact_missing" });
});

test("a start refused for a missing artifact registers no worker, so the same start goes past the artifact after a restore (W4H-32)", async () => {
  const runner = boot(new UnprobedRunner({ root: await store() }));
  await expect(runner.start(startRequest("worker-1"), noReverse)).rejects.toMatchObject({ code: "artifact_missing" });
  await runner.restoreArtifact(artifact, files);
  // The fixture's recipe names no image, so the retried start stops at the profile check: past the artifact, and not a duplicate.
  await expect(runner.start(startRequest("worker-1"), noReverse)).rejects.toMatchObject({ code: "runtime_profile_changed" });
});

/** Hold both real artifact reads before their start calls can reserve an execution. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class AdmissionRunner extends UnprobedRunner {
  readonly bothReads = gate();
  readonly releaseReads = gate();
  readonly firstStage = gate();
  readonly releaseStage = gate();
  reads = 0;
  admitted = 0;
  protected override async prepare(): Promise<void> {}
  override async collectArtifacts(digest: string) {
    const actual = await super.collectArtifacts(digest);
    if (++this.reads === 2) this.bothReads.release();
    if (this.reads <= 2) await this.releaseReads.promise;
    return actual;
  }
  protected override async stage(): Promise<string> {
    this.admitted++;
    this.firstStage.release();
    await this.releaseStage.promise;
    throw new RunnerError("controlled_stage", "Controlled before any staging or launch");
  }
}
async function concurrentAdmission(sameWorker: boolean) {
  const root = await store();
  const runner = boot(new AdmissionRunner({ root, maxExecutions: 1 }));
  const profile = await readFile(new URL("../seccomp.json", import.meta.url));
  const valid = { ...files, ".runner/recipe.json": JSON.stringify({ image: DEFAULT_IMAGE, seccompDigest: sha256(profile) }) };
  const digest = filesDigest(valid);
  const request = (id: string) => ({ ...startRequest(id), artifactDigest: digest });
  // A missing artifact must leave this same worker ID available for the real attempt.
  await expect(runner.start(request("worker-first"), noReverse)).rejects.toMatchObject({ code: "artifact_missing" });
  expect(runner.admitted).toBe(0);
  await runner.put(digest, valid);
  const first = runner.start(request("worker-first"), noReverse).catch((error: unknown) => error);
  const second = runner.start(request(sameWorker ? "worker-first" : "worker-second"), noReverse).catch((error: unknown) => error);
  await runner.bothReads.promise;
  runner.releaseReads.release();
  await runner.firstStage.promise;
  runner.releaseStage.release();
  const results = await Promise.all([first, second]);
  // One reaches the controlled pre-stage boundary; the other must never enter it.
  expect(runner.admitted).toBe(1);
  expect(results.map(error => (error as RunnerError).code).sort()).toEqual(["controlled_stage", sameWorker ? "duplicate_worker" : "runner_busy"].sort());
  // Failed controlled start released its execution slot: a fresh ID can enter once.
  await expect(runner.start(request("worker-after-teardown"), noReverse)).rejects.toMatchObject({ code: "controlled_stage" });
  expect(runner.admitted).toBe(2);
  await runner.close();
}
test("artifact reads cannot admit the same worker twice", () => concurrentAdmission(true));
test("artifact reads cannot exceed one configured execution slot", () => concurrentAdmission(false));
