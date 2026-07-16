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
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath, resolve as resolvePath } from "node:path";
import {
  parseReportJsonl,
  sanitize as sanitizeManifest,
} from "../../scripts/visual-evidence/build-manifest.ts";
import {
  COMMENT_MARKER,
  MAX_INLINE_SHOTS,
  buildGalleryMarkdown,
  buildSkippedMarkdown,
  isChangedShotSpec,
  isPng,
  isSafeRelPath,
  parseChangedSpecPaths,
  safeSegment,
  sanitizeLabel,
  validatePrNumber,
} from "../../scripts/visual-evidence/publish.ts";

// Shared gallery fixtures (used by both buildGalleryMarkdown describe blocks).
const base = {
  repo: "ezcorp-org/EZCorp",
  branch: "evidence/pr-42",
  commitSha: "abc123def456",
  pr: 42,
  runId: 99,
};
const countImages = (md: string): number => (md.match(/!\[evidence\]\(/g) ?? []).length;
const makeShots = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const idx = String(i).padStart(2, "0");
    return { spec: `web/e2e/s${idx}.spec.ts`, label: `shot ${idx}`, file: `${idx}.png` };
  });

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

// ── safeSegment ──────────────────────────────────────────────────────────────
describe("publish: safeSegment", () => {
  test("reduces a value to a single separator-free segment", () => {
    expect(safeSegment("web/e2e/dash.spec.ts")).toBe("web-e2e-dash.spec.ts");
    expect(safeSegment("after load")).toBe("after-load");
  });
  test("maps path-hostile dotted/empty segments to 'evidence'", () => {
    // After sanitize+hyphenate these would still collapse under join() — must
    // never become an empty / "." / ".." path segment.
    expect(safeSegment("..")).toBe("evidence");
    expect(safeSegment(".")).toBe("evidence");
    expect(safeSegment("")).toBe("evidence");
    expect(safeSegment("/")).toBe("evidence");
    // Embedded separators are stripped to a single hyphenated segment — the
    // result is one safe segment (no "/", never exactly ".."), so it can't
    // traverse even though it contains dots.
    const seg = safeSegment("../../etc");
    expect(seg).toBe("..-..-etc");
    expect(seg.includes("/")).toBe(false);
    expect(seg).not.toBe("..");
  });
  test("is idempotent (a safe segment passes through unchanged)", () => {
    expect(safeSegment("web-e2e-dash.spec.ts")).toBe("web-e2e-dash.spec.ts");
  });
  test("a deduped label suffix survives sanitize so URL == on-disk path", () => {
    // main() builds the on-disk seg via safeSegment(`${label} ${n}`); the
    // gallery URL recomputes the seg from the same display label — they must
    // agree, or the rendered image 404s.
    const onDisk = safeSegment("dashboard 2");
    const galleryUrlSeg = sanitizeLabel("dashboard 2").replace(/ /g, "-");
    expect(onDisk).toBe("dashboard-2");
    expect(galleryUrlSeg).toBe(onDisk);
  });
});

// ── buildGalleryMarkdown ─────────────────────────────────────────────────────
describe("publish: buildGalleryMarkdown", () => {
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

  test("renders shots in deterministic (spec, label) order regardless of input order", () => {
    const shots = [
      { spec: "web/e2e/b.spec.ts", label: "zulu", file: "3.png" },
      { spec: "web/e2e/a.spec.ts", label: "zulu", file: "2.png" },
      { spec: "web/e2e/a.spec.ts", label: "alpha", file: "1.png" },
    ];
    const md = buildGalleryMarkdown({ ...base, shots });
    // Expected sort: a/alpha, a/zulu, b/zulu.
    const iAlpha = md.indexOf("alpha");
    const iAZulu = md.indexOf("zulu");
    const iBSpec = md.indexOf("web-e2e-b.spec.ts");
    expect(iAlpha).toBeGreaterThan(-1);
    expect(iAlpha).toBeLessThan(iAZulu);
    expect(iAZulu).toBeLessThan(iBSpec);
    // Order is a pure function of the SET, not the input array order.
    const reversed = buildGalleryMarkdown({ ...base, shots: [...shots].reverse() });
    expect(reversed).toBe(md);
  });

  test("exactly MAX_INLINE_SHOTS renders all inline with no <details> block", () => {
    const md = buildGalleryMarkdown({ ...base, shots: makeShots(MAX_INLINE_SHOTS) });
    expect(countImages(md)).toBe(MAX_INLINE_SHOTS);
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("</details>");
  });

  test("MAX_INLINE_SHOTS + 1 folds the overflow into one <details> block", () => {
    const md = buildGalleryMarkdown({ ...base, shots: makeShots(MAX_INLINE_SHOTS + 1) });
    // Every shot still linked (12 inline + 1 folded).
    expect(countImages(md)).toBe(MAX_INLINE_SHOTS + 1);
    // Exactly one details block, summary counts the remainder.
    expect((md.match(/<details>/g) ?? []).length).toBe(1);
    expect((md.match(/<\/details>/g) ?? []).length).toBe(1);
    expect(md).toContain("<details><summary>1 more screenshot(s)</summary>");
    // The details block opens AFTER the 12 inline images.
    const detailsAt = md.indexOf("<details>");
    const inlineImages = (md.slice(0, detailsAt).match(/!\[evidence\]\(/g) ?? []).length;
    expect(inlineImages).toBe(MAX_INLINE_SHOTS);
    // The overflow shot (s12) is rendered inside the folded block.
    expect(md.slice(detailsAt)).toContain("web-e2e-s12.spec.ts");
    // A blank line follows the summary so GitHub parses the enclosed markdown.
    expect(md).toContain("<details><summary>1 more screenshot(s)</summary>\n\n");
  });

  test("large overflow summary reports the correct remainder count", () => {
    const md = buildGalleryMarkdown({ ...base, shots: makeShots(MAX_INLINE_SHOTS + 5) });
    expect(md).toContain("<details><summary>5 more screenshot(s)</summary>");
    expect(countImages(md)).toBe(MAX_INLINE_SHOTS + 5);
  });
});

// ── parseChangedSpecPaths (P3) ───────────────────────────────────────────────
describe("publish: parseChangedSpecPaths", () => {
  test("keeps only web/e2e spec paths, drops non-spec / non-e2e / blank lines", () => {
    const content = [
      "web/e2e/dash.spec.ts",
      "web/src/lib/components/chat/Foo.svelte",
      "src/runtime/foo.ts",
      "web/e2e/nested/deep.spec.ts",
      "web/e2e/helpers.ts", // under e2e but not a *.spec.ts
      "docs/x.md",
      "",
    ].join("\n");
    expect(parseChangedSpecPaths(content)).toEqual([
      "web/e2e/dash.spec.ts",
      "web/e2e/nested/deep.spec.ts",
    ]);
  });

  test("blank / whitespace-only content → []", () => {
    expect(parseChangedSpecPaths("")).toEqual([]);
    expect(parseChangedSpecPaths("   \n  \n")).toEqual([]);
  });

  test("trims surrounding whitespace and a trailing CR on each line", () => {
    expect(parseChangedSpecPaths("  web/e2e/a.spec.ts\r\n")).toEqual(["web/e2e/a.spec.ts"]);
  });
});

// ── isChangedShotSpec (P3) ───────────────────────────────────────────────────
describe("publish: isChangedShotSpec", () => {
  const changed = ["web/e2e/dash.spec.ts", "web/e2e/nested/deep.spec.ts"];

  test("matches the repo-relative shape (equal paths)", () => {
    expect(isChangedShotSpec("web/e2e/dash.spec.ts", changed)).toBe(true);
    expect(isChangedShotSpec("web/e2e/nested/deep.spec.ts", changed)).toBe(true);
  });

  test("matches the rootDir-relative manifest shape via segment-suffix", () => {
    expect(isChangedShotSpec("e2e/dash.spec.ts", changed)).toBe(true);
    expect(isChangedShotSpec("e2e/nested/deep.spec.ts", changed)).toBe(true);
  });

  test("does NOT match a different spec or a partial-segment collision", () => {
    expect(isChangedShotSpec("e2e/other.spec.ts", changed)).toBe(false);
    // segment-aligned: `mydash.spec.ts` must not match `dash.spec.ts`.
    expect(isChangedShotSpec("e2e/mydash.spec.ts", changed)).toBe(false);
  });

  test("empty shot spec or empty changed list → false", () => {
    expect(isChangedShotSpec("", changed)).toBe(false);
    expect(isChangedShotSpec("e2e/dash.spec.ts", [])).toBe(false);
  });
});

// ── buildGalleryMarkdown: diff-scoped partition (P3) ──────────────────────────
describe("publish: buildGalleryMarkdown diff-scoped partition", () => {
  test("floats the changed spec inline and folds the rest into <details>", () => {
    const shots = [
      { spec: "web/e2e/dash.spec.ts", label: "dash", file: "1.png" },
      { spec: "web/e2e/chat.spec.ts", label: "chat", file: "2.png" },
      { spec: "web/e2e/settings.spec.ts", label: "settings", file: "3.png" },
    ];
    const md = buildGalleryMarkdown({ ...base, shots, changedSpecs: ["web/e2e/chat.spec.ts"] });
    const detailsAt = md.indexOf("<details>");
    expect(detailsAt).toBeGreaterThan(-1);
    const head = md.slice(0, detailsAt);
    const tail = md.slice(detailsAt);
    // Only chat's spec was in the diff → chat inline, dash + settings folded.
    expect(head).toContain("web-e2e-chat.spec.ts");
    expect(head).not.toContain("web-e2e-dash.spec.ts");
    expect(head).not.toContain("web-e2e-settings.spec.ts");
    expect(tail).toContain("web-e2e-dash.spec.ts");
    expect(tail).toContain("web-e2e-settings.spec.ts");
    // P3 summary title + remainder count.
    expect(md).toContain("<details><summary>2 more screenshot(s) from the full suite</summary>");
    // Every shot still linked (1 inline + 2 folded).
    expect(countImages(md)).toBe(3);
  });

  test("matches the rootDir-relative manifest shape via rawSpec (main()'s shape)", () => {
    // main() stores spec=safeSegment(original) + rawSpec=original. A rootDir-
    // relative rawSpec must still match a repo-relative changed path.
    const shots = [
      { spec: "e2e-dash.spec.ts", rawSpec: "e2e/dash.spec.ts", label: "dash", file: "1.png" },
      { spec: "e2e-chat.spec.ts", rawSpec: "e2e/chat.spec.ts", label: "chat", file: "2.png" },
    ];
    const md = buildGalleryMarkdown({ ...base, shots, changedSpecs: ["web/e2e/dash.spec.ts"] });
    const detailsAt = md.indexOf("<details>");
    expect(detailsAt).toBeGreaterThan(-1);
    expect(md.slice(0, detailsAt)).toContain("e2e-dash.spec.ts");
    expect(md.slice(detailsAt)).toContain("e2e-chat.spec.ts");
    expect(md).toContain("<details><summary>1 more screenshot(s) from the full suite</summary>");
  });

  test("no changedSpecs (undefined) OR empty list → byte-identical to the P1 body", () => {
    const shots = makeShots(20); // > MAX_INLINE_SHOTS so the details path is exercised
    const p1 = buildGalleryMarkdown({ ...base, shots });
    expect(buildGalleryMarkdown({ ...base, shots, changedSpecs: undefined })).toBe(p1);
    expect(buildGalleryMarkdown({ ...base, shots, changedSpecs: [] })).toBe(p1);
    // The P1 summary title is preserved (no "from the full suite" suffix).
    expect(p1).toContain("more screenshot(s)</summary>");
    expect(p1).not.toContain("from the full suite");
  });

  test("changedSpecs present but NOTHING matches → P1 layout (no partition, fail-soft)", () => {
    const shots = makeShots(15); // > cap so a details block exists in P1 too
    const p1 = buildGalleryMarkdown({ ...base, shots });
    const noMatch = buildGalleryMarkdown({
      ...base,
      shots,
      changedSpecs: ["web/e2e/does-not-exist.spec.ts"],
    });
    expect(noMatch).toBe(p1);
    expect(noMatch).not.toContain("from the full suite");
  });

  test("MAX_INLINE_SHOTS cap applies to the changed section; overflow is changed-first then rest", () => {
    const changedShots = Array.from({ length: 14 }, (_, i) => {
      const idx = String(i).padStart(2, "0");
      return { spec: `web/e2e/c${idx}.spec.ts`, label: `c ${idx}`, file: `c${idx}.png` };
    });
    const otherShots = Array.from({ length: 3 }, (_, i) => {
      const idx = String(i).padStart(2, "0");
      return { spec: `web/e2e/z${idx}.spec.ts`, label: `z ${idx}`, file: `z${idx}.png` };
    });
    const changedSpecs = changedShots.map((s) => s.spec);
    const md = buildGalleryMarkdown({
      ...base,
      // interleave so the result can't accidentally rely on input order
      shots: [...otherShots, ...changedShots],
      changedSpecs,
    });
    const detailsAt = md.indexOf("<details>");
    const head = md.slice(0, detailsAt);
    const tail = md.slice(detailsAt);
    // Exactly MAX_INLINE_SHOTS *changed* shots inline; no unchanged shot inline.
    expect((head.match(/!\[evidence\]\(/g) ?? []).length).toBe(MAX_INLINE_SHOTS);
    expect(head).not.toContain("web-e2e-z00.spec.ts");
    // Overflow = (14 - 12) changed-overflow + 3 unchanged = 5.
    expect(md).toContain("<details><summary>5 more screenshot(s) from the full suite</summary>");
    // Changed-overflow (c12, c13) precede the unchanged z-shots in the fold.
    const iC12 = tail.indexOf("web-e2e-c12.spec.ts");
    const iC13 = tail.indexOf("web-e2e-c13.spec.ts");
    const iZ00 = tail.indexOf("web-e2e-z00.spec.ts");
    expect(iC12).toBeGreaterThan(-1);
    expect(iZ00).toBeGreaterThan(-1);
    expect(iC12).toBeLessThan(iZ00);
    expect(iC13).toBeLessThan(iZ00);
    // All 17 shots linked.
    expect(countImages(md)).toBe(17);
  });

  test("a hostile shot spec that self-promotes to inline stays inert plain text", () => {
    const shots = [
      // rawSpec matches the changed path → this shot floats into the inline
      // section; its `spec` carries a markdown-breakout payload to prove the
      // inline render path still neutralizes it (renderShot → sanitizeLabel).
      { spec: "x)](http://evil).spec.ts", rawSpec: "web/e2e/x.spec.ts", label: "shot", file: "1.png" },
      { spec: "web/e2e/other.spec.ts", label: "other", file: "2.png" },
    ];
    const md = buildGalleryMarkdown({ ...base, shots, changedSpecs: ["web/e2e/x.spec.ts"] });
    const detailsAt = md.indexOf("<details>");
    expect(detailsAt).toBeGreaterThan(-1);
    const head = md.slice(0, detailsAt);
    // No markdown breakout survived anywhere in the body.
    expect(md).not.toContain("(http://evil)");
    expect(md).not.toContain("](http://evil");
    // The hostile spec self-promoted (it's in the inline section) but is inert,
    // sanitized text in a code span — never a live link.
    expect(head).toContain("x-http-evil-.spec.ts");
  });

  test("hyphen-collapsed spec WITHOUT rawSpec cannot partition — rawSpec is load-bearing", () => {
    // main()'s staging ALWAYS sets rawSpec; this pins why: the safeSegment'd
    // spec has no path separators left, so suffix-matching is impossible and a
    // refactor that drops rawSpec silently degrades to the unpartitioned body.
    const shots = [
      { spec: "web-e2e-dash.spec.ts", label: "dash", file: "1.png" },
      { spec: "web-e2e-chat.spec.ts", label: "chat", file: "2.png" },
    ];
    const md = buildGalleryMarkdown({ ...base, shots, changedSpecs: ["web/e2e/dash.spec.ts"] });
    expect(md).not.toContain("from the full suite");
  });
});

// ── buildSkippedMarkdown ─────────────────────────────────────────────────────
describe("publish: buildSkippedMarkdown", () => {
  test("carries the sticky marker (so upsert can find/replace) and no images or ⚠️", () => {
    const md = buildSkippedMarkdown();
    expect(md).toContain(COMMENT_MARKER);
    expect(md).toContain("No user-visible changes");
    expect(md).not.toContain("![evidence](");
    expect(md).not.toContain("⚠️");
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

// ── main(): staging → markdown integration (subprocess) ─────────────────────
// The pure-fn tests above hand-build shots; this block runs the REAL main()
// over a crafted artifact dir so the staging loop's shapes (safeSegment'd spec
// + rawSpec) — not fixture approximations — feed buildGalleryMarkdown. Pins
// the skipped/update-only path and the partition path end to end.
describe("publish: main() integration", () => {
	const PUBLISH = joinPath(resolvePath(import.meta.dir, "..", ".."), "scripts/visual-evidence/publish.ts");
	// Smallest valid PNG (1x1 RGB), enough to pass the magic-byte + stage checks.
	const PNG = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
		"base64",
	);

	const sandboxes: string[] = [];
	afterEach(() => {
		for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function runMain(opts: {
		manifest: unknown;
		pngs?: string[];
		changedFiles?: string;
	}): Promise<{ body: string; outputs: string }> {
		const root = mkdtempSync(joinPath(tmpdir(), "evpub-"));
		sandboxes.push(root);
		const artifact = joinPath(root, "artifact");
		mkdirSync(joinPath(artifact, "extracted"), { recursive: true });
		await Bun.write(joinPath(artifact, "manifest.json"), JSON.stringify(opts.manifest));
		for (const rel of opts.pngs ?? []) await Bun.write(joinPath(artifact, rel), PNG);
		const env: Record<string, string> = {
			...process.env,
			EVIDENCE_ARTIFACT_DIR: artifact,
			EVIDENCE_STAGE_DIR: joinPath(root, "stage"),
			EVIDENCE_COMMENT_FILE: joinPath(root, "comment.md"),
			EVIDENCE_COMMIT_SHA: "cafef00d",
			GITHUB_OUTPUT: joinPath(root, "outputs.txt"),
		};
		if (opts.changedFiles !== undefined) {
			await Bun.write(joinPath(root, "changed.txt"), opts.changedFiles);
			env.EVIDENCE_CHANGED_FILES = joinPath(root, "changed.txt");
		} else {
			delete env.EVIDENCE_CHANGED_FILES;
		}
		const proc = Bun.spawn(["bun", PUBLISH], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
		await proc.exited;
		const body = await Bun.file(joinPath(root, "comment.md")).text().catch(() => "");
		const outputs = await Bun.file(joinPath(root, "outputs.txt")).text().catch(() => "");
		return { body, outputs };
	}

	test("skipped manifest with zero shots → neutral body + update_only=1", async () => {
		const { body, outputs } = await runMain({
			manifest: { pr: 7, headSha: "abc", runId: 3, shots: [], skipped: true },
		});
		expect(body).toContain(COMMENT_MARKER);
		expect(body).toContain("No user-visible changes");
		expect(body).not.toContain("⚠️");
		expect(outputs).toContain("update_only<<");
		expect(outputs).toMatch(/update_only<<[^\n]+\n1\n/);
	});

	test("hostile skipped=true WITH shots still renders the normal gallery (not update-only)", async () => {
		const { body, outputs } = await runMain({
			manifest: {
				pr: 7,
				headSha: "abc",
				runId: 3,
				skipped: true,
				shots: [{ spec: "e2e/dash.spec.ts", label: "dash", file: "extracted/a.png" }],
			},
			pngs: ["extracted/a.png"],
		});
		expect(body).toContain("![evidence](");
		expect(body).not.toContain("No user-visible changes");
		expect(outputs).toMatch(/update_only<<[^\n]+\n\n/);
	});

	test("real staging shapes partition against a changed-files list (rawSpec end to end)", async () => {
		const { body } = await runMain({
			manifest: {
				pr: 7,
				headSha: "abc",
				runId: 3,
				shots: [
					{ spec: "e2e/dash.spec.ts", label: "dash", file: "extracted/a.png" },
					{ spec: "e2e/chat.spec.ts", label: "chat", file: "extracted/b.png" },
				],
			},
			pngs: ["extracted/a.png", "extracted/b.png"],
			changedFiles: "web/e2e/dash.spec.ts\nweb/src/lib/components/Chat.svelte\n",
		});
		const detailsAt = body.indexOf("<details>");
		expect(detailsAt).toBeGreaterThan(-1);
		expect(body.slice(0, detailsAt)).toContain("e2e-dash.spec.ts");
		expect(body.slice(detailsAt)).toContain("e2e-chat.spec.ts");
		expect(body).toContain("1 more screenshot(s) from the full suite");
	});
});
