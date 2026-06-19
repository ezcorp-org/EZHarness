/**
 * Unit tests for the cheat-proof gate scripts' pure logic:
 *   scripts/coverage-config.ts   (shared helpers)
 *   scripts/gate-integrity.ts    (anti-tamper / anti-cheat detection)
 *   scripts/check-new-file-coverage.ts
 *   scripts/check-patch-coverage.ts
 *
 * These exercise the exported pure functions directly (no git/subprocess), so
 * they're fast and deterministic. The git-wiring main()s are validated by the
 * end-to-end verification in the plan, not here.
 */
import { test, expect, describe } from "bun:test";
import {
  EXCLUDES,
  escapeGlob,
  isExcluded,
  isSourceFile,
  parseHitLines,
  parseLcov,
  type FileCov,
} from "../../scripts/coverage-config.ts";
import {
  addedExcludes,
  forbiddenTestAdditions,
  parseExcludeEntries,
  parseUnifiedDiff,
  thresholdRatchetViolations,
  unassertedAddedBlocks,
} from "../../scripts/gate-integrity.ts";
import { newFileViolations } from "../../scripts/check-new-file-coverage.ts";
import { uncoveredAddedLines } from "../../scripts/check-patch-coverage.ts";

// ── coverage-config ─────────────────────────────────────────────────────────
describe("coverage-config helpers", () => {
  test("escapeGlob escapes SvelteKit bracket segments", () => {
    expect(escapeGlob("web/src/routes/api/x/[id]/+server.ts")).toBe(
      "web/src/routes/api/x/\\[id\\]/+server.ts",
    );
    expect(escapeGlob("src/plain.ts")).toBe("src/plain.ts");
  });

  test("isExcluded matches EXCLUDES patterns (and only those)", () => {
    expect(isExcluded("src/db/migrations/001.ts")).toBe(true);
    expect(isExcluded("web/src/lib/api.ts")).toBe(true);
    expect(isExcluded("src/runtime/brand-new.ts")).toBe(false);
  });

  test("isSourceFile accepts product code, rejects tests/specs/types", () => {
    expect(isSourceFile("src/runtime/foo.ts")).toBe(true);
    expect(isSourceFile("web/src/lib/bar.svelte")).toBe(true);
    expect(isSourceFile("packages/@ezcorp/sdk/src/x.ts")).toBe(true);
    expect(isSourceFile("src/__tests__/foo.test.ts")).toBe(false);
    expect(isSourceFile("web/e2e/x.spec.ts")).toBe(false);
    expect(isSourceFile("src/types.d.ts")).toBe(false);
    expect(isSourceFile("README.md")).toBe(false);
  });

  test("parseLcov derives totals + missed lines from DA records", () => {
    const lcov = [
      "SF:/repo/src/a.ts",
      "DA:1,1",
      "DA:2,0",
      "DA:3,5",
      "end_of_record",
    ].join("\n");
    // Use a relative key the parser produces; assert structure regardless of root.
    const map = parseLcov(lcov);
    const rec = [...map.values()][0] as FileCov;
    expect(rec.totalLines).toBe(3);
    expect(rec.coveredLines).toBe(2);
    expect(rec.missed).toEqual([2]);
  });

  test("parseHitLines collects only >0-hit line numbers", () => {
    const lcov = ["SF:/repo/src/a.ts", "DA:1,1", "DA:2,0", "DA:3,9", "end_of_record"].join("\n");
    const map = parseHitLines(lcov);
    const set = [...map.values()][0] as Set<number>;
    expect([...set].sort()).toEqual([1, 3]);
  });

  test("EXCLUDES is non-empty and frozen-shaped", () => {
    expect(EXCLUDES.length).toBeGreaterThan(10);
    expect(EXCLUDES).toContain("web/e2e/**");
  });
});

// ── gate-integrity: EXCLUDES growth ─────────────────────────────────────────
describe("gate-integrity: EXCLUDES growth", () => {
  const base = `export const EXCLUDES: readonly string[] = [\n  "a/**",\n  "b.ts",\n];`;
  test("parseExcludeEntries extracts entries, ignoring comments", () => {
    const src = `export const EXCLUDES: readonly string[] = [\n  // a comment\n  "a/**",\n  "b.ts", // trailing\n];`;
    expect([...parseExcludeEntries(src)].sort()).toEqual(["a/**", "b.ts"]);
  });

  test("addedExcludes flags a newly-added pattern", () => {
    const head = `export const EXCLUDES: readonly string[] = [\n  "a/**",\n  "b.ts",\n  "sneaky.ts",\n];`;
    expect(addedExcludes(base, head)).toEqual(["sneaky.ts"]);
  });

  test("addedExcludes flags a swap-for-broader (different pattern)", () => {
    const head = `export const EXCLUDES: readonly string[] = [\n  "a/**",\n  "src/**",\n];`;
    expect(addedExcludes(base, head)).toEqual(["src/**"]);
  });

  test("addedExcludes allows removals (tightening)", () => {
    const head = `export const EXCLUDES: readonly string[] = [\n  "a/**",\n];`;
    expect(addedExcludes(base, head)).toEqual([]);
  });
});

// ── gate-integrity: threshold ratchet ───────────────────────────────────────
describe("gate-integrity: threshold ratchet", () => {
  const base = JSON.stringify({ "a.ts": 100, "b.ts": 90, "c/**": 95 });
  test("flags a lowered value", () => {
    const head = JSON.stringify({ "a.ts": 100, "b.ts": 80, "c/**": 95 });
    const v = thresholdRatchetViolations(base, head);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("b.ts");
    expect(v[0]).toContain("lowered");
  });
  test("flags a removed key", () => {
    const head = JSON.stringify({ "a.ts": 100, "b.ts": 90 });
    const v = thresholdRatchetViolations(base, head);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("c/**");
    expect(v[0]).toContain("removed");
  });
  test("allows raised values and new keys", () => {
    const head = JSON.stringify({ "a.ts": 100, "b.ts": 95, "c/**": 95, "d.ts": 100 });
    expect(thresholdRatchetViolations(base, head)).toEqual([]);
  });
  test("flags invalid HEAD JSON", () => {
    expect(thresholdRatchetViolations(base, "{not json")).toHaveLength(1);
  });
});

// ── gate-integrity: unified diff parsing ────────────────────────────────────
describe("gate-integrity: parseUnifiedDiff", () => {
  test("maps added lines to new-side line numbers per file", () => {
    const diff = [
      "diff --git a/x.test.ts b/x.test.ts",
      "--- a/x.test.ts",
      "+++ b/x.test.ts",
      "@@ -0,0 +5,2 @@",
      "+const a = 1;",
      "+const b = 2;",
    ].join("\n");
    const map = parseUnifiedDiff(diff);
    const f = map.get("x.test.ts")!;
    expect([...f.addedLines].sort((a, b) => a - b)).toEqual([5, 6]);
    expect(f.addedTexts).toEqual(["const a = 1;", "const b = 2;"]);
  });
});

// ── gate-integrity: forbidden test additions ────────────────────────────────
describe("gate-integrity: forbidden test additions", () => {
  test("flags .skip / .only / .todo and x/f variants", () => {
    expect(forbiddenTestAdditions(["  it.skip('x', () => {})"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  describe.only('x', () => {})"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  test.todo('later')"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  xit('x', () => {})"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  fdescribe('x', () => {})"]).length).toBe(1);
  });
  test("flags empty catch blocks", () => {
    expect(forbiddenTestAdditions(["  try { x() } catch {}"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  } catch (e) {}"]).length).toBe(1);
  });
  test("does not flag normal test code or commented-out skips", () => {
    expect(forbiddenTestAdditions(["  it('real', () => { expect(1).toBe(1) })"])).toEqual([]);
    expect(forbiddenTestAdditions(["  // it.skip('disabled')"])).toEqual([]);
    expect(forbiddenTestAdditions(["  } catch (e) { handle(e) }"])).toEqual([]);
  });
});

// ── gate-integrity: vacuous (assertion-free) test detection ──────────────────
describe("gate-integrity: unassertedAddedBlocks", () => {
  const withAssert = [
    "describe('s', () => {",
    "  it('asserts', () => {",
    "    const x = compute();",
    "    expect(x).toBe(1);",
    "  });",
    "});",
  ].join("\n");
  const noAssert = [
    "describe('s', () => {",
    "  it('vacuous', () => {",
    "    compute();",
    "    doThing();",
    "  });",
    "});",
  ].join("\n");

  test("flags a touched test block with no assertion", () => {
    const added = new Set([2, 3, 4]); // inside the it() body
    expect(unassertedAddedBlocks(noAssert, added).length).toBe(1);
  });
  test("passes a touched test block that asserts", () => {
    const added = new Set([2, 3, 4]);
    expect(unassertedAddedBlocks(withAssert, added)).toEqual([]);
  });
  test("ignores blocks not touched by the diff", () => {
    expect(unassertedAddedBlocks(noAssert, new Set([999]))).toEqual([]);
  });
  test("does not count braces inside strings as block boundaries", () => {
    const tricky = [
      "it('s', () => {",
      "  const s = 'a } b {';",
      "  expect(s).toContain('}');",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(tricky, new Set([2]))).toEqual([]);
  });
});

// ── check-new-file-coverage ─────────────────────────────────────────────────
describe("check-new-file-coverage: newFileViolations", () => {
  const cov = (lines: number, covered: number): FileCov => ({
    totalLines: lines,
    coveredLines: covered,
    missed: [],
  });
  test("flags a new file with no measured coverage", () => {
    const v = newFileViolations(["src/new.ts"], new Map(), ["src/**"]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("no measured coverage");
  });
  test("flags a measured new file with no threshold key", () => {
    const perFile = new Map([["src/new.ts", cov(10, 10)]]);
    const v = newFileViolations(["src/new.ts"], perFile, ["other/**"]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("not gated");
  });
  test("passes a measured + gated new file", () => {
    const perFile = new Map([["src/new.ts", cov(10, 10)]]);
    expect(newFileViolations(["src/new.ts"], perFile, ["src/**"])).toEqual([]);
  });
  test("file present in lcov but with 0 measured lines is treated as unmeasured", () => {
    const perFile = new Map([["src/new.ts", cov(0, 0)]]);
    const v = newFileViolations(["src/new.ts"], perFile, ["src/**"]);
    expect(v[0]).toContain("no measured coverage");
  });
});

// ── check-patch-coverage ────────────────────────────────────────────────────
describe("check-patch-coverage: uncoveredAddedLines", () => {
  test("returns executable added lines that are missed", () => {
    const added = new Set([10, 11, 12, 13]);
    const hits = new Set([10, 12]);
    const missed = new Set([11, 13]);
    expect(uncoveredAddedLines(added, hits, missed)).toEqual([11, 13]);
  });
  test("ignores non-executable added lines (in neither hit nor missed)", () => {
    const added = new Set([10, 99]); // 99 is a comment/blank — no DA record
    const hits = new Set([10]);
    const missed = new Set<number>();
    expect(uncoveredAddedLines(added, hits, missed)).toEqual([]);
  });
  test("all-covered change passes", () => {
    expect(uncoveredAddedLines(new Set([1, 2]), new Set([1, 2]), new Set())).toEqual([]);
  });
});
