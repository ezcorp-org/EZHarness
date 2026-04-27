// preview.test.ts — coverage for runtime/preview.ts (Phase A1).
//
// All three exports are pure functions; no channel needed.
//   - SANDBOX_FLAGS_STRICT: exact string assertion.
//   - extensionDataUrl: builds a URL, validates inputs, escapes
//     path segments, refuses traversal.
//   - assertContentType / contentTypeForPath: extension → type
//     lookup with strict expected-vs-actual comparison.

import { describe, expect, test } from "bun:test";

import {
  SANDBOX_FLAGS_STRICT,
  assertContentType,
  contentTypeForPath,
  extensionDataUrl,
} from "../src/runtime/preview";

// ── SANDBOX_FLAGS_STRICT ────────────────────────────────────────────

describe("SANDBOX_FLAGS_STRICT", () => {
  test("equals 'allow-scripts allow-same-origin'", () => {
    expect(SANDBOX_FLAGS_STRICT).toBe("allow-scripts allow-same-origin");
  });

  test("does NOT include any escape-hatch flags", () => {
    const forbidden = [
      "allow-top-navigation",
      "allow-popups",
      "allow-forms",
      "allow-modals",
      "allow-pointer-lock",
      "allow-presentation",
      "allow-orientation-lock",
    ];
    for (const flag of forbidden) {
      expect(SANDBOX_FLAGS_STRICT).not.toContain(flag);
    }
  });
});

// ── extensionDataUrl ────────────────────────────────────────────────

describe("extensionDataUrl — happy paths", () => {
  test("builds a relative URL under /api/extensions/<extName>/data/", () => {
    const url = extensionDataUrl("claude-design", "projects/web/drafts/abc.html");
    expect(url).toBe("/api/extensions/claude-design/data/projects/web/drafts/abc.html");
  });

  test("encodes URL meta-characters in path segments", () => {
    const url = extensionDataUrl("ext", "weird name?with#hash.html");
    expect(url).toBe(
      "/api/extensions/ext/data/weird%20name%3Fwith%23hash.html",
    );
  });

  test("normalizes Windows-style backslashes to forward slashes", () => {
    const url = extensionDataUrl("ext", "drafts\\subdir\\file.html");
    expect(url).toBe("/api/extensions/ext/data/drafts/subdir/file.html");
  });

  test("collapses repeated slashes", () => {
    const url = extensionDataUrl("ext", "drafts////sub///file.html");
    expect(url).toBe("/api/extensions/ext/data/drafts/sub/file.html");
  });

  test("handles single-segment paths", () => {
    const url = extensionDataUrl("ext", "file.html");
    expect(url).toBe("/api/extensions/ext/data/file.html");
  });
});

describe("extensionDataUrl — validation", () => {
  test("rejects empty extName", () => {
    expect(() => extensionDataUrl("", "x.html")).toThrow(/invalid extName/);
  });

  test("rejects extName with spaces or uppercase", () => {
    expect(() => extensionDataUrl("Bad Name", "x.html")).toThrow(/invalid extName/);
    expect(() => extensionDataUrl("UPPER", "x.html")).toThrow(/invalid extName/);
  });

  test("rejects extName longer than 64 chars", () => {
    expect(() => extensionDataUrl("a".repeat(65), "x.html")).toThrow(/invalid extName/);
  });

  test("rejects empty relativePath", () => {
    expect(() => extensionDataUrl("ext", "")).toThrow(/relativePath must be non-empty/);
  });

  test("rejects absolute relativePath (leading /)", () => {
    expect(() => extensionDataUrl("ext", "/abs/path.html")).toThrow(
      /must be relative, not absolute/,
    );
  });

  test("rejects absolute relativePath (leading \\)", () => {
    expect(() => extensionDataUrl("ext", "\\abs\\path.html")).toThrow(
      /must be relative, not absolute/,
    );
  });

  test("rejects path traversal via ..", () => {
    expect(() => extensionDataUrl("ext", "drafts/../../etc/passwd")).toThrow(
      /segment forbidden/,
    );
  });

  test("rejects bare ..", () => {
    expect(() => extensionDataUrl("ext", "..")).toThrow(/segment forbidden/);
  });
});

// ── contentTypeForPath ──────────────────────────────────────────────

describe("contentTypeForPath", () => {
  test("recognizes html / htm", () => {
    expect(contentTypeForPath("index.html")).toBe("text/html");
    expect(contentTypeForPath("index.htm")).toBe("text/html");
  });

  test("recognizes common image types", () => {
    expect(contentTypeForPath("a.png")).toBe("image/png");
    expect(contentTypeForPath("a.jpg")).toBe("image/jpeg");
    expect(contentTypeForPath("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeForPath("a.svg")).toBe("image/svg+xml");
    expect(contentTypeForPath("a.webp")).toBe("image/webp");
  });

  test("is case-insensitive on the extension", () => {
    expect(contentTypeForPath("INDEX.HTML")).toBe("text/html");
    expect(contentTypeForPath("photo.JPG")).toBe("image/jpeg");
  });

  test("returns undefined for unknown extensions", () => {
    expect(contentTypeForPath("file.xyz")).toBeUndefined();
  });

  test("returns undefined when there is no extension", () => {
    expect(contentTypeForPath("README")).toBeUndefined();
  });

  test("returns undefined when the path ends with a dot", () => {
    expect(contentTypeForPath("file.")).toBeUndefined();
  });

  test("uses the LAST dot as extension separator", () => {
    expect(contentTypeForPath("a.b.html")).toBe("text/html");
    expect(contentTypeForPath("a.html.b")).toBeUndefined();
  });
});

// ── assertContentType ──────────────────────────────────────────────

describe("assertContentType", () => {
  test("passes when path's type matches expected", () => {
    expect(() => assertContentType("draft.html", "text/html")).not.toThrow();
    expect(() => assertContentType("logo.svg", "image/svg+xml")).not.toThrow();
  });

  test("throws when path's type differs from expected", () => {
    expect(() => assertContentType("script.js", "text/html")).toThrow(
      /resolves to application\/javascript, expected text\/html/,
    );
  });

  test("throws when path's extension is unknown", () => {
    expect(() => assertContentType("file.xyz", "text/html")).toThrow(
      /unknown extension/,
    );
  });

  test("throws when path is empty", () => {
    expect(() => assertContentType("", "text/html")).toThrow(/path must be a non-empty/);
  });

  test("throws when expected is empty", () => {
    expect(() => assertContentType("file.html", "")).toThrow(
      /expected must be a non-empty/,
    );
  });

  test("includes both actual and expected types in the error message", () => {
    try {
      assertContentType("script.js", "text/html");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("application/javascript");
      expect(msg).toContain("text/html");
      expect(msg).toContain("script.js");
    }
  });
});
