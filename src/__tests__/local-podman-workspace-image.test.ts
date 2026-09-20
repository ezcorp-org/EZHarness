import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceImage } from "../runtime/sandbox/local-podman/workspace-image";
import { ResourceRoot } from "../runtime/sandbox/local-podman/resource-root";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => { process.env.PATH = originalPath; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ez-workspace-image-")); roots.push(root);
  const bin = join(root, "bin"); const log = join(root, "commands.jsonl"); const control = join(root, "control");
  await mkdir(bin);
  const script = `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
const name = "__COMMAND__"; const args = process.argv.slice(2); await appendFile(${JSON.stringify(log)}, JSON.stringify({ name }) + "\\n");
let mode = ""; try { mode = await readFile(${JSON.stringify(control)}, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (mode.trim() === name + ":fail") process.exit(2);
if (name === "truncate") await writeFile(args.at(-1), new Uint8Array(1));
if (name === "e2fsck" && mode.trim() === "e2fsck:repair") process.exit(1);
`;
  for (const name of ["truncate", "mkfs.ext2", "fuse2fs", "fusermount3", "e2fsck"]) { const path = join(bin, name); await writeFile(path, script.replace("__COMMAND__", name)); await chmod(path, 0o700); }
  process.env.PATH = `${bin}:${originalPath ?? ""}`;
  const config = { fuse2fsPath: join(bin, "fuse2fs") } as ConstructorParameters<typeof WorkspaceImage>[0];
  const tools = { truncate: join(bin, "truncate"), mkfs: join(bin, "mkfs.ext2"), unmount: join(bin, "fusermount3"), check: join(bin, "e2fsck") };
  return { root, log, control, image: join(root, "workspace.ext2"), mount: join(root, "mount"), images: new WorkspaceImage(config, tools) };
}

describe("WorkspaceImage", () => {
  test("creates, checks, measures, and destroys an owned image through bounded commands", async () => {
    const f = await fixture();
    await f.images.create(f.image, f.mount, 16 * 1024 * 1024);
    await f.images.recoverCreate(f.image, f.mount, 16 * 1024 * 1024);
    await f.images.check(f.image); await writeFile(f.control, "e2fsck:repair"); await f.images.check(f.image);
    await writeFile(f.image, Buffer.alloc(4096, 1));
    expect(await f.images.allocatedBytes(f.image)).toBeGreaterThan(0);
    await writeFile(f.control, ""); await f.images.destroy(f.image, f.mount);
    await expect(stat(f.image)).rejects.toThrow(); await expect(stat(f.mount)).rejects.toThrow();
    const names = (await readFile(f.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).name);
    expect(names).toEqual(["truncate", "mkfs.ext2", "fuse2fs", "truncate", "mkfs.ext2", "fuse2fs", "e2fsck", "e2fsck", "fusermount3"]);
  });

  test("rejects invalid sizes and command failures, and retains data after an unmount failure", async () => {
    const f = await fixture();
    await expect(f.images.create(f.image, f.mount, 1)).rejects.toThrow("invalid workspace size");
    await writeFile(f.control, "mkfs.ext2:fail"); await expect(f.images.create(f.image, f.mount, 16 * 1024 * 1024)).rejects.toThrow("mkfs.ext2 failed");
    await writeFile(f.control, ""); await f.images.mount(f.image, f.mount);
    await writeFile(f.control, "e2fsck:fail"); await expect(f.images.check(f.image)).rejects.toThrow("e2fsck failed");
    await writeFile(f.control, "fusermount3:fail"); await expect(f.images.destroy(f.image, f.mount)).rejects.toThrow("fusermount3 failed");
    expect((await stat(f.image)).isFile()).toBe(true); expect((await stat(f.mount)).isDirectory()).toBe(true);
  });
});

describe("ResourceRoot", () => {
  test("reads durable metadata, closes oversized input, and removes the resource", async () => {
    const root = await mkdtemp(join(tmpdir(), "ez-resource-root-")); roots.push(root); const resources = new ResourceRoot(root);
    await resources.verifyPrivateRoot(); const paths = await resources.initialize("resource");
    await resources.writeMetadata("resource", { value: 1 }); expect(await resources.readMetadata<{ value: number }>("resource")).toEqual({ value: 1 });
    await writeFile(paths.metadata, "x".repeat(64 * 1024 + 1)); await expect(resources.readMetadata("resource")).rejects.toThrow("oversized");
    await resources.destroy("resource"); await expect(stat(paths.root)).rejects.toThrow();
  });
});
