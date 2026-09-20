import { afterEach, describe, expect, test } from "bun:test";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalWorkspaceFileError, LocalWorkspaceFiles } from "../runtime/sandbox/local-podman/files";

const roots: string[] = [];
const digest = "a".repeat(64);
const call = { scope: { projectId: "project-1", bindingId: "binding-1", generation: 1 }, operationId: "operation-1", idempotencyKey: "retry-1", requestDigest: digest };
const resourceId = "resource-1";

async function fixture(limits = { maxReadBytes: 256 * 1024, maxWriteBytes: 256 * 1024, maxListEntries: 256 }) {
  const root = await mkdtemp(join(tmpdir(), "ez-local-files-"));
  roots.push(root);
  return { root, files: new LocalWorkspaceFiles(root, limits) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("LocalWorkspaceFiles", () => {
  test("writes atomically, preserves binary data, and enforces revision CAS and modes", async () => {
    const { root, files } = await fixture();
    const created = await files.write({ call, resourceId, path: "/data.bin", encoding: "base64", data: "AP8B" });
    expect(await readFile(join(root, "data.bin"))).toEqual(Buffer.from([0, 255, 1]));
    expect(created.entry.mode).toBe(0o600);
    expect((await readdir(root)).every(name => !name.startsWith(".ez-write-"))).toBe(true);

    const read = await files.read({ call, resourceId, path: "/data.bin", revision: created.entry.revision, offsetBytes: 1, lengthBytes: 2 });
    expect(read).toMatchObject({ encoding: "base64", data: "/wE=", offsetBytes: 1, nextOffsetBytes: 3, eof: true });
    await expect(files.write({ call, resourceId, path: "/data.bin", expectedRevision: "stale", encoding: "utf8", data: "no" })).rejects.toMatchObject({ code: "revision_conflict" });

    const replaced = await files.write({ call, resourceId, path: "/data.bin", expectedRevision: created.entry.revision, encoding: "utf8", data: "new" });
    expect(await readFile(join(root, "data.bin"), "utf8")).toBe("new");
    expect(replaced.entry.revision).not.toBe(created.entry.revision);
    await chmod(root, 0o500);
    try {
      await expect(files.write({ call, resourceId, path: "/data.bin", expectedRevision: replaced.entry.revision, encoding: "utf8", data: "partial" })).rejects.toMatchObject({ code: "unsupported_file" });
    } finally { await chmod(root, 0o700); }
    expect(await readFile(join(root, "data.bin"), "utf8")).toBe("new");
    expect((await readdir(root)).every(name => !name.startsWith(".ez-write-"))).toBe(true);
    const changed = await files.chmod({ call, resourceId, path: "/data.bin", expectedRevision: replaced.entry.revision, mode: 0o755 });
    expect(changed.entry.mode).toBe(0o755);
    await expect(files.chmod({ call, resourceId, path: "/data.bin", expectedRevision: replaced.entry.revision, mode: 0o600 })).rejects.toMatchObject({ code: "revision_conflict" });
  });

  test("supports canonical mkdir, stat, bounded listing, cursor scoping, and removal", async () => {
    const { root, files } = await fixture({ maxReadBytes: 8, maxWriteBytes: 8, maxListEntries: 2 });
    const directory = await files.mkdir({ call, resourceId, path: "/src/nested", recursive: true });
    expect(directory.entry).toMatchObject({ path: "/src/nested", kind: "directory", mode: 0o700 });
    await files.write({ call, resourceId, path: "/src/a", encoding: "utf8", data: "a" });
    await files.write({ call, resourceId, path: "/src/b", encoding: "utf8", data: "b" });
    await files.write({ call, resourceId, path: "/src/c", encoding: "utf8", data: "c" });
    const first = await files.list({ call, resourceId, path: "/src", limit: 2 });
    expect(first.entries.map(entry => entry.path)).toEqual(["/src/a", "/src/b"]);
    expect(first.nextCursor).toBeString();
    const second = await files.list({ call, resourceId, path: "/src", cursor: first.nextCursor, limit: 2 });
    expect(second.entries.map(entry => entry.path)).toEqual(["/src/c", "/src/nested"]);
    await expect(files.list({ call, resourceId, path: "/", cursor: first.nextCursor, limit: 2 })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(files.list({ call, resourceId, path: "/src", limit: 3 })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(files.read({ call, resourceId, path: "/src/a", offsetBytes: 0, lengthBytes: 9 })).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(files.write({ call, resourceId, path: "/src/a", encoding: "utf8", data: "123456789" })).rejects.toMatchObject({ code: "limit_exceeded" });

    const file = await files.stat({ call, resourceId, path: "/src/a" });
    expect(file.entry.kind).toBe("file");
    await expect(files.remove({ call, resourceId, path: "/src", recursive: false })).rejects.toMatchObject({ code: "unsupported_file" });
    const removed = await files.remove({ call, resourceId, path: "/src", recursive: true });
    expect(removed.removedRevision).toBeString();
    expect(await lstat(join(root, "src")).catch(error => (error as NodeJS.ErrnoException).code)).toBe("ENOENT");
  });

  test("denies traversal, symlinks, hardlinks, devices, roots, and malformed limits", async () => {
    const { root, files } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "ez-local-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "secret"), "outside");
    await symlink(outside, join(root, "link"));
    await expect(files.read({ call, resourceId, path: "/link/secret", offsetBytes: 0, lengthBytes: 7 })).rejects.toBeDefined();
    await expect(files.stat({ call, resourceId, path: "/link" })).rejects.toBeDefined();
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("outside");

    await writeFile(join(root, "source"), "hardlink");
    await link(join(root, "source"), join(root, "hard"));
    await expect(files.stat({ call, resourceId, path: "/hard" })).rejects.toMatchObject({ code: "unsupported_file" });
    const fifo = join(root, "fifo");
    const child = Bun.spawn(["mkfifo", fifo]);
    expect(await child.exited).toBe(0);
    await expect(files.stat({ call, resourceId, path: "/fifo" })).rejects.toMatchObject({ code: "unsupported_file" });

    for (const action of [
      () => files.write({ call, resourceId, path: "/", encoding: "utf8", data: "x" }),
      () => files.remove({ call, resourceId, path: "/", recursive: true }),
      () => files.chmod({ call, resourceId, path: "/", mode: 0o700 }),
    ]) await expect(action()).rejects.toMatchObject({ code: "invalid_path" });
    expect(() => new LocalWorkspaceFiles("relative", { maxReadBytes: 1, maxWriteBytes: 1, maxListEntries: 1 })).toThrow(LocalWorkspaceFileError);
    expect(() => new LocalWorkspaceFiles(root, { maxReadBytes: 0, maxWriteBytes: 1, maxListEntries: 1 })).toThrow(LocalWorkspaceFileError);
  });

  test("never follows an intermediate symlink during a real rename race", async () => {
    const { root, files } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "ez-local-race-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "value"), "outside");
    const safe = join(root, "safe");
    const parked = join(root, "parked");
    await mkdir(safe);
    await writeFile(join(safe, "value"), "inside");
    let running = true;
    const racer = (async () => {
      while (running) {
        try { await rename(safe, parked); await symlink(outside, safe); await rm(safe); await rename(parked, safe); }
        catch (error) { if (!new Set(["ENOENT", "EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      }
    })();
    const observed: string[] = ["inside"];
    let denied = 0;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const value = await files.read({ call, resourceId, path: "/safe/value", offsetBytes: 0, lengthBytes: 16 });
          observed.push(Buffer.from(value.data, value.encoding === "base64" ? "base64" : "utf8").toString("utf8"));
        } catch (error) { denied++; expect(error).toBeDefined(); }
      }
    } finally { running = false; await racer; }
    expect(observed.every(value => value === "inside")).toBe(true);
    expect(observed.length + denied).toBe(101);
    expect(await readFile(join(outside, "value"), "utf8")).toBe("outside");
  });
});
