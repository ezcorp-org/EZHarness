import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveImageToDisk, EXTENSION_NAME } from "./image-storage";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oig2-"));
});

afterAll(() => {
  // beforeEach leaves dirs around on failure; best-effort cleanup of
  // the common prefix. Individual tests also rm their own tree.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch { /* noop */ }
});

describe("saveImageToDisk", () => {
  test("writes the decoded bytes under <projectRoot>/.ezcorp/extension-data/<name>/generated/", async () => {
    const { relPath, url } = await saveImageToDisk("aGVsbG8=", "image/png", { projectRoot: root });
    expect(relPath.startsWith("generated/")).toBe(true);
    expect(relPath.endsWith(".png")).toBe(true);
    expect(url).toBe(`/api/ext-files/${EXTENSION_NAME}/${relPath}`);
    const abs = join(root, ".ezcorp", "extension-data", EXTENSION_NAME, relPath);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs).toString("utf8")).toBe("hello");
  });

  test("chooses extension from mime type", async () => {
    const png = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const jpg = await saveImageToDisk("AAA=", "image/jpeg", { projectRoot: root });
    const webp = await saveImageToDisk("AAA=", "image/webp", { projectRoot: root });
    const gif = await saveImageToDisk("AAA=", "image/gif", { projectRoot: root });
    expect(png.relPath.endsWith(".png")).toBe(true);
    expect(jpg.relPath.endsWith(".jpg")).toBe(true);
    expect(webp.relPath.endsWith(".webp")).toBe(true);
    expect(gif.relPath.endsWith(".gif")).toBe(true);
  });

  test("defaults to .png for unknown mime types", async () => {
    const { relPath } = await saveImageToDisk("AAA=", "image/bmp", { projectRoot: root });
    expect(relPath.endsWith(".png")).toBe(true);
  });

  test("emits a URL under /api/ext-files/<extension name>/", async () => {
    const { url } = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    expect(url.startsWith(`/api/ext-files/${EXTENSION_NAME}/generated/`)).toBe(true);
  });

  test("two calls produce distinct filenames", async () => {
    const a = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const b = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    expect(a.relPath).not.toBe(b.relPath);
  });

  test("creates parent directory if missing", async () => {
    // root dir exists but extension-data subtree doesn't — still works.
    const { relPath } = await saveImageToDisk("AAA=", "image/png", { projectRoot: root });
    const abs = join(root, ".ezcorp", "extension-data", EXTENSION_NAME, relPath);
    expect(existsSync(abs)).toBe(true);
  });
});
