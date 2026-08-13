import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // realpathSync: the resolver compares CANONICAL paths, so the test
  // root must itself be canonical (tmpdir is a symlink on some OSes).
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "extres-")));
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

  test("an absolute name cannot reset the path out of the data root", () => {
    // This resolver used to spell the layout itself as
    // `resolve(cwd, ".ezcorp", "extension-data", name)`, and `resolve` treats
    // a leading separator as a RESET: an absolute name yielded that absolute
    // path, escaping the data root entirely. Routing through
    // `extensionDataDir` (which uses `join`) neutralises it. `resolveExtFilesPath`
    // validates the name before ever reaching here, so this is defence in
    // depth — but a silent revert to `resolve` would restore the escape, and
    // nothing else would notice.
    expect(extensionDataRoot("/etc", cwd)).toBe(join(cwd, ".ezcorp", "extension-data", "etc"));
    expect(extensionDataRoot("/etc", cwd).startsWith(join(cwd, ".ezcorp", "extension-data"))).toBe(
      true,
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

  test("returns null for nonexistent files (realpath containment requires existence)", () => {
    // F4: containment is asserted on canonical paths, and realpath ENOENTs
    // for missing files. Both callers already treat null as "missing"
    // (route → 404, rehydrator → skip), so requiring existence is safe.
    expect(resolveExtFilesPath(EXT, "generated/nonexistent.png", cwd)).toBeNull();
  });

  test("mime type derives from the resolved path's extension", () => {
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    for (const f of ["a.jpeg", "a.webp", "a.bin"]) writeFileSync(join(dir, f), "X");
    expect(resolveExtFilesPath(EXT, "generated/a.jpeg", cwd)!.mimeType).toBe("image/jpeg");
    expect(resolveExtFilesPath(EXT, "generated/a.webp", cwd)!.mimeType).toBe("image/webp");
    expect(resolveExtFilesPath(EXT, "generated/a.bin", cwd)!.mimeType).toBe("application/octet-stream");
  });

  // ── F4: symlink escape ────────────────────────────────────────────

  test("symlink pointing outside the root is rejected (secret stays unreadable)", () => {
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    const target = join(cwd, "outside.png");
    writeFileSync(target, "JWT_SECRET=supersecret");
    symlinkSync(target, join(dir, "sym.png"));
    expect(resolveExtFilesPath(EXT, "generated/sym.png", cwd)).toBeNull();
  });

  test("symlinked DIRECTORY pointing outside the root is rejected", () => {
    // The realistic attack from the audit: `esc -> <repoRoot>/.ezcorp/data`
    // (the PGlite DB dir), then read files THROUGH the link.
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    const outsideDir = join(cwd, ".ezcorp", "data");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "db.png"), "DBBYTES");
    symlinkSync(outsideDir, join(dir, "esc"));
    expect(resolveExtFilesPath(EXT, "generated/esc/db.png", cwd)).toBeNull();
  });

  test("intra-root symlink is allowed and resolves to the canonical path", () => {
    const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
    symlinkSync(join(dir, "pic.png"), join(dir, "alias.png"));
    const out = resolveExtFilesPath(EXT, "generated/alias.png", cwd);
    expect(out).not.toBeNull();
    expect(out!.absPath).toBe(join(dir, "pic.png"));
    expect(out!.mimeType).toBe("image/png");
  });
});
