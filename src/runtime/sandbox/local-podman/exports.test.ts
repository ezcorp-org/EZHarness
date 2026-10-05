import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrozenWorkspaceExports } from "./exports";
import { validateSnapshot } from "../../../integrations/github-personal-prs/snapshot";

async function workspace<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "ez-snapshot-test-"));
  try { return await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

describe("frozen local sandbox export", () => {
  test("returns immutable chunks bound to scope and resource", async () => workspace(async root => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "before");
    const exports = new FrozenWorkspaceExports();
    const begun = await exports.begin(root, "scope-A", "resource-A");
    await writeFile(join(root, "src", "a.txt"), "after");
    const chunks: string[] = [];
    for (let offset = 0; offset < begun.byteLength;) {
      const read = exports.read("scope-A", "resource-A", begun.snapshotId, offset, 2);
      expect(read.nextOffsetBytes).toBeGreaterThan(offset);
      chunks.push(read.data);
      offset = read.nextOffsetBytes;
      expect(read.eof).toBe(offset === begun.byteLength);
    }
    const bytes = Buffer.concat(chunks.map(value => Buffer.from(value, "base64")));
    expect(await crypto.subtle.digest("SHA-256", bytes).then(value => Buffer.from(value).toString("hex"))).toBe(begun.sha256);
    const validated = validateSnapshot(JSON.parse(bytes.toString("utf8")));
    expect(Buffer.from(validated.files[0]!.bytes).toString()).toBe("before");
    expect(() => exports.read("scope-B", "resource-A", begun.snapshotId, 0, 2)).toThrow();
    expect(() => exports.read("scope-A", "resource-B", begun.snapshotId, 0, 2)).toThrow();
    exports.end("scope-A", "resource-A", begun.snapshotId);
    expect(() => exports.read("scope-A", "resource-A", begun.snapshotId, 0, 2)).toThrow();
  }));

  test("rejects links and platform data before returning a snapshot", async () => workspace(async root => {
    const exports = new FrozenWorkspaceExports();
    await symlink("/etc/passwd", join(root, "link"));
    await expect(exports.begin(root, "scope", "resource")).rejects.toThrow();
    await rm(join(root, "link"));
    await mkdir(join(root, ".ezcorp"));
    await writeFile(join(root, ".ezcorp", "secret"), "x");
    await expect(exports.begin(root, "scope", "resource")).rejects.toThrow();
  }));
});
