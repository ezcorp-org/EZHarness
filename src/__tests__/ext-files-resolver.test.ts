import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  ALLOWED_EXTENSIONS,
  MIME_BY_EXT,
  extensionDataRoot,
  mimeTypeForPath,
  resolveExtFilesPath,
} from "../chat/attachments/ext-files-resolver";

const EXT = "openai-image-gen-2";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "extres-"));
  const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pic.png"), "PNGDATA");
});

afterEach(() => {
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    cwd = "";
  }
});

describe("ALLOWED_EXTENSIONS", () => {
  test("contains openai-image-gen-2", () => {
    expect(ALLOWED_EXTENSIONS.has("openai-image-gen-2")).toBe(true);
  });

  test("does not contain arbitrary extension names", () => {
    expect(ALLOWED_EXTENSIONS.has("../etc/passwd")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has("not-allowed")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has("")).toBe(false);
  });
});

describe("MIME_BY_EXT", () => {
  test("maps common image extensions", () => {
    expect(MIME_BY_EXT.png).toBe("image/png");
    expect(MIME_BY_EXT.jpg).toBe("image/jpeg");
    expect(MIME_BY_EXT.jpeg).toBe("image/jpeg");
    expect(MIME_BY_EXT.webp).toBe("image/webp");
    expect(MIME_BY_EXT.gif).toBe("image/gif");
  });
});

describe("extensionDataRoot", () => {
  test("returns <cwd>/.ezcorp/extension-data/<name>", () => {
    expect(extensionDataRoot(EXT, cwd)).toBe(
      join(cwd, ".ezcorp", "extension-data", EXT),
    );
  });
});

describe("mimeTypeForPath", () => {
  test.each([
    ["a.png", "image/png"],
    ["a.PNG", "image/png"],
    ["a.jpg", "image/jpeg"],
    ["a.jpeg", "image/jpeg"],
    ["a.JPEG", "image/jpeg"],
    ["a.webp", "image/webp"],
    ["a.gif", "image/gif"],
    ["a.bin", "application/octet-stream"],
    ["a", "application/octet-stream"],
    ["", "application/octet-stream"],
  ])("mimeTypeForPath(%p) → %p", (path, expected) => {
    expect(mimeTypeForPath(path)).toBe(expected);
  });
});

describe("resolveExtFilesPath", () => {
  test("resolves a valid name + path", () => {
    const out = resolveExtFilesPath(EXT, "generated/pic.png", cwd);
    expect(out).not.toBeNull();
    expect(out!.absPath).toBe(join(cwd, ".ezcorp", "extension-data", EXT, "generated", "pic.png"));
    expect(out!.mimeType).toBe("image/png");
  });

  test("returns null for undefined name", () => {
    expect(resolveExtFilesPath(undefined, "generated/pic.png", cwd)).toBeNull();
  });

  test("returns null for an extension not on the allowlist", () => {
    expect(resolveExtFilesPath("not-allowed", "generated/pic.png", cwd)).toBeNull();
  });

  test("returns null for empty / root-only relative paths", () => {
    expect(resolveExtFilesPath(EXT, "", cwd)).toBeNull();
    expect(resolveExtFilesPath(EXT, "/", cwd)).toBeNull();
    expect(resolveExtFilesPath(EXT, ".", cwd)).toBeNull();
    expect(resolveExtFilesPath(EXT, undefined, cwd)).toBeNull();
  });

  test("rejects traversal via leading ../", () => {
    expect(resolveExtFilesPath(EXT, "../../../etc/passwd", cwd)).toBeNull();
  });

  test("rejects traversal hidden mid-path", () => {
    expect(resolveExtFilesPath(EXT, "generated/../../../etc/passwd", cwd)).toBeNull();
  });

  test("rejects absolute path that resolves outside the root", () => {
    expect(resolveExtFilesPath(EXT, "/etc/passwd", cwd)).toBeNull();
  });

  test("does not check existence — returns a resolved path for nonexistent files", () => {
    // Existence is the caller's responsibility; this keeps the resolver
    // deterministic for path-only tests and avoids redundant stat calls.
    const out = resolveExtFilesPath(EXT, "generated/nonexistent.png", cwd);
    expect(out).not.toBeNull();
    expect(out!.absPath).toContain("nonexistent.png");
  });

  test("mime type derives from the resolved path's extension", () => {
    expect(resolveExtFilesPath(EXT, "generated/a.jpeg", cwd)!.mimeType).toBe("image/jpeg");
    expect(resolveExtFilesPath(EXT, "generated/a.webp", cwd)!.mimeType).toBe("image/webp");
    expect(resolveExtFilesPath(EXT, "generated/a.bin", cwd)!.mimeType).toBe("application/octet-stream");
  });

  test("symlink pointing outside the root is rejected by downstream I/O (resolver itself stays path-based)", () => {
    // The resolver itself does not resolve symlinks (it only normalises the
    // path). We verify the shape of its output here; end-to-end symlink
    // escape protection lives in the HTTP route via fs.stat on the
    // resolved path. The point is: this resolver never returns a path
    // whose string form contains `..${sep}` post-normalisation, so the
    // caller can safely pass it to fs.readFile knowing traversal via
    // string manipulation was caught.
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    const target = join(cwd, "outside.png");
    writeFileSync(target, "OUTSIDE");
    try {
      symlinkSync(target, join(dir, "sym.png"));
    } catch {
      // Some filesystems reject symlinks; skip the assertion if so.
      return;
    }
    const out = resolveExtFilesPath(EXT, "generated/sym.png", cwd);
    // The resolver returns the normalised path (still under root). The
    // decision to follow/reject the symlink is the HTTP route's job via
    // fs.statSync — which is covered by ext-files-route tests.
    expect(out!.absPath).toContain(`extension-data${sep}${EXT}${sep}generated${sep}sym.png`);
  });
});
