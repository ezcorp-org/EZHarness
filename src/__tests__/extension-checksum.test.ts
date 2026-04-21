import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  computePackageChecksums,
  verifyPackageChecksums,
} from "../extensions/checksum";

describe("computePackageChecksums", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "checksum-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns map of relative paths to SHA-256 hex strings", async () => {
    await writeFile(join(tempDir, "ezcorp.config.ts"), 'export default { name: "test" };');
    await writeFile(join(tempDir, "index.ts"), 'console.log("hello")');

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums)).toContain("ezcorp.config.ts");
    expect(Object.keys(checksums)).toContain("index.ts");
    // SHA-256 hex is 64 chars
    expect(checksums["ezcorp.config.ts"]).toMatch(/^[a-f0-9]{64}$/);
    expect(checksums["index.ts"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("excludes .git directory", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await mkdir(join(tempDir, ".git"), { recursive: true });
    await writeFile(join(tempDir, ".git", "config"), "git config");

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums)).toContain("index.ts");
    expect(Object.keys(checksums)).not.toContain(".git/config");
  });

  test("excludes .gitignore, .DS_Store, .gitmodules, .gitattributes, .editorconfig, .prettierrc, .eslintrc", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await writeFile(join(tempDir, ".gitignore"), "node_modules");
    await writeFile(join(tempDir, ".DS_Store"), "data");
    await writeFile(join(tempDir, ".gitmodules"), "submodule");
    await writeFile(join(tempDir, ".gitattributes"), "attrs");
    await writeFile(join(tempDir, ".editorconfig"), "config");
    await writeFile(join(tempDir, ".prettierrc"), "{}");
    await writeFile(join(tempDir, ".eslintrc"), "{}");

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums)).toEqual(["index.ts"]);
  });

  test("excludes node_modules directory", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(tempDir, "node_modules", "pkg", "index.js"), "dep");

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums)).toEqual(["index.ts"]);
  });

  test("includes nested files recursively", async () => {
    await writeFile(join(tempDir, "index.ts"), "root");
    await mkdir(join(tempDir, "lib"), { recursive: true });
    await writeFile(join(tempDir, "lib", "helper.ts"), "helper");
    await mkdir(join(tempDir, "lib", "sub"), { recursive: true });
    await writeFile(join(tempDir, "lib", "sub", "deep.ts"), "deep");

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums).sort()).toEqual([
      "index.ts",
      "lib/helper.ts",
      "lib/sub/deep.ts",
    ]);
  });

  test("handles empty directory", async () => {
    const checksums = await computePackageChecksums(tempDir);
    expect(Object.keys(checksums)).toEqual([]);
  });

  test("handles single-file extension", async () => {
    await writeFile(join(tempDir, "index.ts"), "only file");

    const checksums = await computePackageChecksums(tempDir);

    expect(Object.keys(checksums)).toEqual(["index.ts"]);
    expect(checksums["index.ts"]).toMatch(/^[a-f0-9]{64}$/);
  });

  test("gracefully skips broken symlinks where stat() fails", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    // Create a symlink pointing to a non-existent target
    await symlink(join(tempDir, "nonexistent-target"), join(tempDir, "broken-link"));

    const checksums = await computePackageChecksums(tempDir);

    // Should include the real file but skip the broken symlink
    expect(Object.keys(checksums)).toContain("index.ts");
    expect(Object.keys(checksums)).not.toContain("broken-link");
    // Should not throw
  });
});

describe("verifyPackageChecksums", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns valid when all checksums match", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await writeFile(join(tempDir, "ezcorp.config.ts"), 'export default { name: "test" };');

    const expected = await computePackageChecksums(tempDir);
    const result = await verifyPackageChecksums(tempDir, expected);

    expect(result.valid).toBe(true);
    expect(result.mismatched).toEqual([]);
  });

  test("detects modified file", async () => {
    await writeFile(join(tempDir, "index.ts"), "original");
    const expected = await computePackageChecksums(tempDir);

    // Modify file
    await writeFile(join(tempDir, "index.ts"), "modified");

    const result = await verifyPackageChecksums(tempDir, expected);

    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("index.ts");
  });

  test("detects added file", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    const expected = await computePackageChecksums(tempDir);

    // Add a new file
    await writeFile(join(tempDir, "evil.ts"), "malicious");

    const result = await verifyPackageChecksums(tempDir, expected);

    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("evil.ts");
  });

  test("detects removed file", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await writeFile(join(tempDir, "lib.ts"), "library");
    const expected = await computePackageChecksums(tempDir);

    // Remove a file
    await rm(join(tempDir, "lib.ts"));

    const result = await verifyPackageChecksums(tempDir, expected);

    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("lib.ts");
  });

  test("detects multiple issues at once", async () => {
    await writeFile(join(tempDir, "a.ts"), "a");
    await writeFile(join(tempDir, "b.ts"), "b");
    await writeFile(join(tempDir, "c.ts"), "c");
    const expected = await computePackageChecksums(tempDir);

    // Modify a, remove b, add d
    await writeFile(join(tempDir, "a.ts"), "changed");
    await rm(join(tempDir, "b.ts"));
    await writeFile(join(tempDir, "d.ts"), "new");

    const result = await verifyPackageChecksums(tempDir, expected);

    expect(result.valid).toBe(false);
    expect(result.mismatched.sort()).toEqual(["a.ts", "b.ts", "d.ts"]);
  });
});
