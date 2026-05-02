import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCEPTED_IMAGE_REF_HELP,
  isAcceptedImageRef,
  isExtFileUrl,
  readExtFileBytes,
  resolveExtFileUrl,
} from "./ext-files";

const EXT = "openai-image-gen-2";
const PREFIX = `/api/ext-files/${EXT}/`;

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oig2-extfiles-"));
  const dir = join(cwd, ".ezcorp", "extension-data", EXT, "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pic.png"), "PNGBYTES");
});

afterEach(() => {
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    cwd = "";
  }
});

describe("isExtFileUrl", () => {
  test("matches the canonical prefix", () => {
    expect(isExtFileUrl(`${PREFIX}generated/pic.png`)).toBe(true);
  });
  test("rejects other ext-file namespaces", () => {
    expect(isExtFileUrl("/api/ext-files/some-other-ext/x.png")).toBe(false);
  });
  test("rejects unrelated URL forms", () => {
    expect(isExtFileUrl("https://x.test/a.png")).toBe(false);
    expect(isExtFileUrl("data:image/png;base64,AAA")).toBe(false);
    expect(isExtFileUrl("ftp://x")).toBe(false);
  });
  test("rejects non-strings and empties", () => {
    expect(isExtFileUrl(undefined)).toBe(false);
    expect(isExtFileUrl(null)).toBe(false);
    expect(isExtFileUrl("")).toBe(false);
    expect(isExtFileUrl(123)).toBe(false);
  });
});

describe("resolveExtFileUrl", () => {
  test("resolves a valid url to absPath + mimeType", () => {
    const out = resolveExtFileUrl(`${PREFIX}generated/pic.png`, cwd);
    expect(out).not.toBeNull();
    expect(out!.absPath).toBe(join(cwd, ".ezcorp", "extension-data", EXT, "generated", "pic.png"));
    expect(out!.mimeType).toBe("image/png");
  });

  test("derives mimeType from path extension (jpg → image/jpeg, etc.)", () => {
    expect(resolveExtFileUrl(`${PREFIX}generated/a.jpg`, cwd)!.mimeType).toBe("image/jpeg");
    expect(resolveExtFileUrl(`${PREFIX}generated/a.JPEG`, cwd)!.mimeType).toBe("image/jpeg");
    expect(resolveExtFileUrl(`${PREFIX}generated/a.webp`, cwd)!.mimeType).toBe("image/webp");
    expect(resolveExtFileUrl(`${PREFIX}generated/a.gif`, cwd)!.mimeType).toBe("image/gif");
    expect(resolveExtFileUrl(`${PREFIX}generated/a.bin`, cwd)!.mimeType).toBe("application/octet-stream");
  });

  test("returns null for non-strings, empty, undefined", () => {
    expect(resolveExtFileUrl(undefined, cwd)).toBeNull();
    expect(resolveExtFileUrl("", cwd)).toBeNull();
  });

  test("returns null for URLs not starting with the canonical prefix", () => {
    expect(resolveExtFileUrl("/api/ext-files/other-ext/x.png", cwd)).toBeNull();
    expect(resolveExtFileUrl("https://x.test/a.png", cwd)).toBeNull();
    expect(resolveExtFileUrl("data:image/png;base64,AAA", cwd)).toBeNull();
  });

  test("returns null for empty / root-only relative paths", () => {
    expect(resolveExtFileUrl(`${PREFIX}`, cwd)).toBeNull();
    expect(resolveExtFileUrl(`${PREFIX}/`, cwd)).toBeNull();
    expect(resolveExtFileUrl(`${PREFIX}.`, cwd)).toBeNull();
  });

  test("rejects traversal via leading ../", () => {
    expect(resolveExtFileUrl(`${PREFIX}../../../etc/passwd`, cwd)).toBeNull();
  });

  test("rejects traversal hidden mid-path", () => {
    expect(resolveExtFileUrl(`${PREFIX}generated/../../../etc/passwd`, cwd)).toBeNull();
  });

  test("rejects an absolute path that escapes the root", () => {
    // After the canonical prefix the rest is "/etc/passwd", which
    // resolves outside the root.
    expect(resolveExtFileUrl(`${PREFIX}/etc/passwd`, cwd)).toBeNull();
  });

  test("does NOT check on-disk existence — caller's responsibility", () => {
    const out = resolveExtFileUrl(`${PREFIX}generated/nonexistent.png`, cwd);
    expect(out).not.toBeNull();
    expect(out!.absPath).toContain("nonexistent.png");
  });
});

describe("readExtFileBytes", () => {
  test("reads bytes for an existing file and infers mime type", async () => {
    const resolved = resolveExtFileUrl(`${PREFIX}generated/pic.png`, cwd)!;
    const { bytes, mimeType } = await readExtFileBytes(resolved.absPath);
    expect(mimeType).toBe("image/png");
    expect(new TextDecoder().decode(bytes)).toBe("PNGBYTES");
  });

  test("throws for a missing file (caller wraps into a domain error)", async () => {
    const resolved = resolveExtFileUrl(`${PREFIX}generated/missing.png`, cwd)!;
    await expect(readExtFileBytes(resolved.absPath)).rejects.toThrow(/does not exist/);
  });
});

describe("symlink behavior (pinned — intentionally NOT realpath-resolved)", () => {
  // The resolver does NOT call realpath/lstat — see the WHY-comment in
  // ext-files.ts. This extension owns every byte that lands in its data
  // root (writes go through Bun.write in image-storage.ts), so a symlink
  // pointing outward could only be created by an out-of-band actor with
  // filesystem access — outside the threat model. This mirrors the
  // host's `src/chat/attachments/ext-files-resolver.ts` semantics.
  //
  // These tests pin that behavior so a future change that adds realpath
  // checking is a deliberate decision, not an accidental break.
  test("symlink under data root resolves to its target's bytes (by design)", async () => {
    // Place a real file outside the data root, then symlink to it from
    // inside. The resolver passes the in-root path through containment
    // checks; readExtFileBytes follows the symlink at I/O time.
    const outside = join(cwd, "outside-fixture.png");
    writeFileSync(outside, "OUTSIDE");
    const linkPath = join(cwd, ".ezcorp", "extension-data", EXT, "generated", "link.png");
    symlinkSync(outside, linkPath);

    const resolved = resolveExtFileUrl(`${PREFIX}generated/link.png`, cwd);
    expect(resolved).not.toBeNull();
    const { bytes } = await readExtFileBytes(resolved!.absPath);
    // PINNED: bytes come from the symlink target, NOT from a realpath
    // rejection. If this assertion ever flips, update the WHY-comment
    // in ext-files.ts to match the new policy.
    expect(new TextDecoder().decode(bytes)).toBe("OUTSIDE");
  });
});

describe("isAcceptedImageRef", () => {
  test("accepts data:image/, https://, and the canonical ext-files prefix", () => {
    expect(isAcceptedImageRef("data:image/png;base64,AA")).toBe(true);
    expect(isAcceptedImageRef("https://x.test/a.png")).toBe(true);
    expect(isAcceptedImageRef(`${PREFIX}generated/pic.png`)).toBe(true);
  });
  test("rejects other schemes and other ext namespaces", () => {
    expect(isAcceptedImageRef("ftp://x")).toBe(false);
    expect(isAcceptedImageRef("file:///etc/passwd")).toBe(false);
    expect(isAcceptedImageRef("/api/ext-files/some-other-ext/foo.png")).toBe(false);
    expect(isAcceptedImageRef("http://insecure.test/a.png")).toBe(false);
  });
  test("rejects non-strings and empty", () => {
    expect(isAcceptedImageRef(undefined)).toBe(false);
    expect(isAcceptedImageRef(null)).toBe(false);
    expect(isAcceptedImageRef("")).toBe(false);
    expect(isAcceptedImageRef(42)).toBe(false);
  });
  test("ACCEPTED_IMAGE_REF_HELP names all three forms", () => {
    expect(ACCEPTED_IMAGE_REF_HELP).toMatch(/data/);
    expect(ACCEPTED_IMAGE_REF_HELP).toMatch(/https/);
    expect(ACCEPTED_IMAGE_REF_HELP).toMatch(/ext-files/);
  });
});
