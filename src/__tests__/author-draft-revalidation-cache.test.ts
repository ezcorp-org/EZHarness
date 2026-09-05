import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { snapshotExtensionSource } from "../../scripts/migrate-extension-v4";
import { digestObject } from "../extensions/v4/blobs";
import { loadManifest, loadManifestFresh } from "../extensions/loader";
import { verifyExtension } from "../extensions/sdk/verify";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function draft(config: string) {
  const root = await mkdtemp(join(tmpdir(), "draft-revalidation-"));
  roots.push(root);
  const directory = join(root, "candidate");
  await mkdir(directory);
  await writeFile(join(directory, "extension.ts"), "throw new Error('untrusted entrypoint must not run on host');");
  await writeFile(join(directory, "ezcorp.config.ts"), config);
  return { directory, snapshot: async () => (await snapshotExtensionSource(root, { name: "candidate", directory: "candidate", entrypoint: "extension.ts" })).files };
}

for (const [name, before, after] of [
  ["valid to broken", "export default {name:'first'};", "export default {"],
  ["broken to valid", "export default {", "export default {name:'fixed'};"],
  ["renamed identity", "export default {name:'old'};", "export default {name:'new'};"],
]) test(`same-path ${name} creates fresh source evidence without altering frozen bytes`, async () => {
  const fixture = await draft(before!);
  const first = await fixture.snapshot();
  const firstDigest = digestObject(first);
  expect(first["ezcorp.config.ts"]).toBe(before);
  expect((await verifyExtension({ extDir: fixture.directory })).pass).toBe(false);
  await writeFile(join(fixture.directory, "ezcorp.config.ts"), after!);
  const second = await fixture.snapshot();
  expect(second["ezcorp.config.ts"]).toBe(after);
  expect(digestObject(second)).not.toBe(firstDigest);
  expect(digestObject(first)).toBe(firstDigest);
  expect(first["ezcorp.config.ts"]).toBe(before);
  const verification = await verifyExtension({ extDir: fixture.directory });
  expect(verification.pass).toBe(false);
  expect(verification.steps.some(step => !step.ok && step.detail.includes("Host configuration evaluation is disabled"))).toBe(true);
});

test("cached and fresh legacy loaders both reject executable host configuration", async () => {
  const fixture = await draft("throw new Error('CONFIG_EXECUTED');");
  for (const loader of [loadManifest, loadManifestFresh]) {
    await expect(loader(fixture.directory)).rejects.toMatchObject({ code: "EXTENSION_V4_REQUIRED" });
    await writeFile(join(fixture.directory, "ezcorp.config.ts"), "throw new Error('EDITED_CONFIG_EXECUTED');");
    await expect(loader(fixture.directory)).rejects.toThrow("Host configuration evaluation is disabled");
  }
});
