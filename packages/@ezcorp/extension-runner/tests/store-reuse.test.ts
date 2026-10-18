import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionLimits, filesDigest, PodmanRunner } from "../src";

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
