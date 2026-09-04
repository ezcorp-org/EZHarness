import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFirstPartyExtensionSources, snapshotFirstPartyExtension } from "./migrate-extension-v4";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "extension-source-test-"));
  roots.push(root);
  for (const path of ["extensions/candidate/src", "docs/extensions/examples", "packages/@ezcorp"]) await mkdir(join(root, path), { recursive: true });
  const extension = join(root, "extensions/candidate");
  await writeFile(join(extension, "ezcorp.config.ts"), "throw new Error('Config must not execute on host');");
  await writeFile(join(extension, "extension.ts"), "export const version = 4;");
  return { root, extension };
}

test("collects every first-party and reference source without executing config", async () => {
  const { root, extension } = await fixture();
  await writeFile(join(extension, "src/nested.ts"), "export const value = 1;");
  await writeFile(join(extension, ".env"), "SECRET=hidden");
  const result = await snapshotFirstPartyExtension(root, "candidate");
  expect(result.files["src/nested.ts"]).toContain("value = 1");
  expect(result.files["ezcorp.config.ts"]).toContain("must not execute");
  expect(result.files[".env"]).toBeUndefined();
  expect(result.source.entrypoint).toBe("extension.ts");
  expect(await listFirstPartyExtensionSources(root)).toHaveLength(1);
});

test("rejects links, invalid text, and oversized files", async () => {
  const { root, extension } = await fixture();
  await symlink("/etc/passwd", join(extension, "link"));
  await expect(snapshotFirstPartyExtension(root, "candidate")).rejects.toThrow("links");
  await rm(join(extension, "link"));
  await writeFile(join(extension, "binary"), new Uint8Array([255, 254]));
  await expect(snapshotFirstPartyExtension(root, "candidate")).rejects.toThrow();
  await rm(join(extension, "binary"));
  await writeFile(join(extension, "large"), "a".repeat(4 * 1024 * 1024 + 1));
  await expect(snapshotFirstPartyExtension(root, "candidate")).rejects.toThrow("limit");
});

test("rejects caller paths and ambiguous extension names", async () => {
  const { root } = await fixture();
  await expect(snapshotFirstPartyExtension(root, "../candidate")).rejects.toThrow("Unknown");
  const duplicate = join(root, "docs/extensions/examples/candidate");
  await mkdir(duplicate);
  await writeFile(join(duplicate, "ezcorp.config.ts"), "export default {};");
  await expect(snapshotFirstPartyExtension(root, "candidate")).rejects.toThrow("ambiguous");
});
