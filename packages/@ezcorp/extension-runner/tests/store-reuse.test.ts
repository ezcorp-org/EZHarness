import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesDigest, PodmanRunner } from "../src";

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
