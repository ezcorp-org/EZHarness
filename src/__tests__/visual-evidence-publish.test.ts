/**
 * Unit tests for the visual-evidence PUBLISHER's pure, security-critical
 * helpers (`scripts/visual-evidence/publish.ts`) plus the trusted builder's
 * sanitize/PNG helpers (`scripts/visual-evidence/build-manifest.ts`).
 *
 * These are the WF2 trust boundary: WF2 runs with a write token and consumes
 * UNTRUSTED PR-authored artifact bytes (labels, file paths, PNG bytes,
 * manifest fields). Every helper below exists to neutralize a specific attack
 * (markdown breakout, path traversal, ref injection, content smuggling), so we
 * test the adversarial cases directly — no git, no subprocess, no browser.
 *
 * Follows the `src/__tests__/gate-scripts.test.ts` convention (pure exported
 * functions exercised in isolation).
 */
import { describe, expect, test } from "bun:test";
import {
  parseReportJsonl,
  sanitize as sanitizeManifest,
} from "../../scripts/visual-evidence/build-manifest.ts";
import {
  COMMENT_MARKER,
  buildGalleryMarkdown,
  isPng,
  isSafeRelPath,
  sanitizeLabel,
  validatePrNumber,
} from "../../scripts/visual-evidence/publish.ts";

// ── sanitizeLabel ────────────────────────────────────────────────────────────
describe("publish: sanitizeLabel", () => {
  test("passes a normal label untouched", () => {
    expect(sanitizeLabel("dashboard after load")).toBe("dashboard after load");
    expect(sanitizeLabel("step-1.final_v2")).toBe("step-1.final_v2");
  });

  test("neutralizes a markdown-breakout payload", () => {
    // Classic attempt to escape the link/plain-text context and inject a
    // phishing link. Brackets/parens/colon/slash must all be stripped.
    const evil = "x)](http://evil)";
    const safe = sanitizeLabel(evil);
    expect(safe).not.toContain("(");
    expect(safe).not.toContain(")");
    expect(safe).not.toContain("[");
    expect(safe).not.toContain("]");
    expect(safe).not.toContain(":");
    expect(safe).not.toContain("/");
    expect(safe).toBe("x http evil");
  });

  test("strips backticks, html angle brackets, bang, pipe, and newlines", () => {
    expect(sanitizeLabel("a`b<img>c|d!e")).toBe("a b img c d e");
    expect(sanitizeLabel("line1\nline2")).toBe("line1 line2");
    expect(sanitizeLabel("a![nested](u)")).toBe("a nested u");
  });

  test("empty / whitespace-only / nullish → 'evidence'", () => {
    expect(sanitizeLabel("")).toBe("evidence");
    expect(sanitizeLabel("   ")).toBe("evidence");
    // @ts-expect-error — exercising the runtime null guard
    expect(sanitizeLabel(undefined)).toBe("evidence");
  });
});

// ── validatePrNumber ─────────────────────────────────────────────────────────
describe("publish: validatePrNumber", () => {
  test("accepts a digit string and trims surrounding whitespace", () => {
    expect(validatePrNumber("42")).toBe(42);
    expect(validatePrNumber("  7 ")).toBe(7);
    expect(validatePrNumber(123)).toBe(123);
  });

  test("rejects injection / empty / non-numeric", () => {
    expect(() => validatePrNumber("1; rm -rf")).toThrow();
    expect(() => validatePrNumber("")).toThrow();
    expect(() => validatePrNumber("abc")).toThrow();
    expect(() => validatePrNumber("12; echo")).toThrow();
    expect(() => validatePrNumber("../../etc")).toThrow();
    expect(() => validatePrNumber(null)).toThrow();
    expect(() => validatePrNumber("4.2")).toThrow();
  });
});

// ── isSafeRelPath ────────────────────────────────────────────────────────────
describe("publish: isSafeRelPath", () => {
  test("accepts a plain relative path", () => {
    expect(isSafeRelPath("a/b.png")).toBe(true);
    expect(isSafeRelPath("extracted/dash.png")).toBe(true);
    expect(isSafeRelPath("pr-1/99/spec/label.png")).toBe(true);
  });

  test("rejects traversal and absolute paths", () => {
    expect(isSafeRelPath("../x")).toBe(false);
    expect(isSafeRelPath("a/../../b")).toBe(false);
    expect(isSafeRelPath("/etc/x")).toBe(false);
    expect(isSafeRelPath("a/b/../../../etc/passwd")).toBe(false);
    expect(isSafeRelPath("..")).toBe(false);
  });

  test("rejects backslash traversal and empty/nullish", () => {
    expect(isSafeRelPath("..\\x")).toBe(false);
    expect(isSafeRelPath("")).toBe(false);
    // @ts-expect-error — runtime guard for non-string
    expect(isSafeRelPath(undefined)).toBe(false);
  });
});

// ── isPng ────────────────────────────────────────────────────────────────────
describe("publish: isPng", () => {
  test("true for PNG magic bytes", () => {
    expect(isPng(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe(true);
  });
  test("false for non-PNG bytes and too-short input", () => {
    expect(isPng(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe(false); // GIF8
    expect(isPng(new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(isPng(new Uint8Array([]))).toBe(false);
  });
});

// ── buildGalleryMarkdown ─────────────────────────────────────────────────────
describe("publish: buildGalleryMarkdown", () => {
  const base = {
    repo: "ezcorp-org/EZCorp",
    branch: "evidence/pr-42",
    commitSha: "abc123def456",
    pr: 42,
    runId: 99,
  };

  test("contains marker + immutable SHA URL per shot", () => {
    const md = buildGalleryMarkdown({
      ...base,
      shots: [{ spec: "web/e2e/dash.spec.ts", label: "after load", file: "x.png" }],
    });
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain(
      "https://raw.githubusercontent.com/ezcorp-org/EZCorp/abc123def456/pr-42/99/",
    );
    expect(md).toContain("![evidence](");
    // immutable: the commit sha (not a branch name) is in the URL
    expect(md).not.toContain("/evidence/pr-42/");
  });

  test("renders a hostile label inert (no markdown breakout, plain text only)", () => {
    const md = buildGalleryMarkdown({
      ...base,
      shots: [{ spec: "web/e2e/x.spec.ts", label: "x)](http://evil)", file: "x.png" }],
    });
    // The only parenthesis in the body belongs to the image link itself, never
    // to the attacker's payload.
    expect(md).not.toContain("(http://evil)");
    expect(md).not.toContain("](http://evil");
    // The sanitized label survives as plain text.
    expect(md).toContain("x http evil");
  });

  test("empty shots → ⚠️ body with marker and guidance", () => {
    const md = buildGalleryMarkdown({ ...base, shots: [] });
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain("⚠️");
    expect(md).toContain("@evidence");
    expect(md).not.toContain("![evidence](");
  });
});

// ── build-manifest: sanitize ─────────────────────────────────────────────────
describe("build-manifest: sanitize", () => {
  test("keeps the path-like safe charset (slash allowed) and drops the rest", () => {
    expect(sanitizeManifest("web/e2e/dash.spec.ts")).toBe("web/e2e/dash.spec.ts");
    expect(sanitizeManifest("a)(b][c`d")).toBe("a b c d");
  });
  test("empty → 'evidence'", () => {
    expect(sanitizeManifest("")).toBe("evidence");
    expect(sanitizeManifest("   ")).toBe("evidence");
  });
});

// ── build-manifest: parseReportJsonl ─────────────────────────────────────────
describe("build-manifest: parseReportJsonl", () => {
  // a 1x1 transparent PNG, base64
  const PNG_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  test("decodes an onAttach image/png and maps it to its spec via onProject", () => {
    const jsonl = [
      JSON.stringify({
        method: "onProject",
        params: {
          suites: [
            {
              title: "web/e2e/dash.spec.ts",
              entries: [
                {
                  testId: "t1",
                  title: "loads dashboard",
                  location: { file: "web/e2e/dash.spec.ts", line: 3, column: 1 },
                },
              ],
            },
          ],
        },
      }),
      JSON.stringify({
        method: "onAttach",
        params: {
          testId: "t1",
          attachments: [{ name: "after load", contentType: "image/png", base64: PNG_B64 }],
        },
      }),
    ].join("\n");
    const shots = parseReportJsonl(jsonl);
    expect(shots.length).toBe(1);
    expect(shots[0]!.spec).toBe("web/e2e/dash.spec.ts");
    expect(shots[0]!.label).toBe("after load");
    expect(isPng(shots[0]!.bytes)).toBe(true);
  });

  test("reads attachments nested under onTestEnd.result (old emitter)", () => {
    const jsonl = [
      JSON.stringify({
        method: "onProject",
        params: { suites: [{ title: "s", entries: [{ testId: "t2", location: { file: "e2e/a.spec.ts" } }] }] },
      }),
      JSON.stringify({
        method: "onTestEnd",
        params: {
          test: { testId: "t2" },
          result: {
            id: "r1",
            attachments: [{ name: "shot", contentType: "image/png", base64: PNG_B64 }],
          },
        },
      }),
    ].join("\n");
    const shots = parseReportJsonl(jsonl);
    expect(shots.length).toBe(1);
    expect(shots[0]!.spec).toBe("e2e/a.spec.ts");
  });

  test("drops non-PNG, non-base64, and malformed lines without throwing", () => {
    const jsonl = [
      "{not json}",
      JSON.stringify({
        method: "onAttach",
        params: {
          testId: "t",
          attachments: [
            { name: "txt", contentType: "text/plain", base64: "aGVsbG8=" },
            { name: "nob64", contentType: "image/png" },
            { name: "fake-png", contentType: "image/png", base64: "QUJDRA==" }, // "ABCD" — bad magic
          ],
        },
      }),
    ].join("\n");
    expect(parseReportJsonl(jsonl)).toEqual([]);
  });

  test("empty input → no shots", () => {
    expect(parseReportJsonl("")).toEqual([]);
  });
});
