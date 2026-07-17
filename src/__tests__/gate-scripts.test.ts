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
  deletedOrRenamedTests,
  forbiddenTestAdditions,
  isPathAbsentAtRev,
  parseExcludeEntries,
  parseUnifiedDiff,
  stripBlockComments,
  testGuttingViolation,
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
    expect(f.removedTexts).toEqual([]);
  });
  test("collects removed lines (old-side), never the --- header", () => {
    const diff = [
      "diff --git a/x.test.ts b/x.test.ts",
      "--- a/x.test.ts",
      "+++ b/x.test.ts",
      "@@ -3,2 +3,1 @@",
      "-  expect(a).toBe(1);",
      "-  expect(b).toBe(2);",
      "+  expect(ab).toBe(3);",
    ].join("\n");
    const f = parseUnifiedDiff(diff).get("x.test.ts")!;
    expect(f.removedTexts).toEqual(["  expect(a).toBe(1);", "  expect(b).toBe(2);"]);
    expect(f.addedTexts).toEqual(["  expect(ab).toBe(3);"]);
  });
});

// ── gate-integrity: in-place test gutting (check 8) ─────────────────────────
describe("gate-integrity: testGuttingViolation", () => {
  const base = [
    "describe('s', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    "  it('c', () => { expect(3).toBe(3); });",
    "});",
  ].join("\n"); // 3 assertion/test lines at base

  test("flags a gutted file (removes most assertions, adds none)", () => {
    const removed = [
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { expect(2).toBe(2); });",
    ];
    const v = testGuttingViolation([], removed, base);
    expect(v).not.toBeNull();
    expect(v).toContain("GUTTED");
    expect(v).toContain("net -2 of 3");
  });
  test("does not flag a refactor that moves assertions (net ≈ 0)", () => {
    const moved = [
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { expect(2).toBe(2); });",
    ];
    expect(testGuttingViolation(moved, moved, base)).toBeNull();
  });
  test("does not flag a small trim of a large suite (≤50% of base)", () => {
    const bigBase = Array.from(
      { length: 10 },
      (_, i) => `  it('t${i}', () => { expect(${i}).toBe(${i}); });`,
    ).join("\n");
    const removed = [
      "  it('t0', () => { expect(0).toBe(0); });",
      "  it('t1', () => { expect(1).toBe(1); });",
    ];
    expect(testGuttingViolation([], removed, bigBase)).toBeNull();
  });
  test("exactly-50% loss is NOT flagged (loss must exceed half)", () => {
    const base4 = [
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { expect(2).toBe(2); });",
      "  it('c', () => { expect(3).toBe(3); });",
      "  it('d', () => { expect(4).toBe(4); });",
    ].join("\n");
    const removed = [
      "  it('a', () => { expect(1).toBe(1); });",
      "  it('b', () => { expect(2).toBe(2); });",
    ];
    expect(testGuttingViolation([], removed, base4)).toBeNull();
  });
  test("no base assertions → nothing to gut", () => {
    expect(testGuttingViolation([], ["  helper();"], "const x = 1;")).toBeNull();
  });
  test("assertion mentions inside strings/comments don't count", () => {
    const removed = ['  const s = "expect(1) it( test(";', "  // expect(2) in a comment"];
    expect(testGuttingViolation([], removed, base)).toBeNull();
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
  test("does not flag skip/only/empty-catch that only appear inside a string literal", () => {
    // A line that merely MENTIONS the pattern inside a quoted string (e.g. this
    // gate's own test fixtures) is not an executable cheat — stripNoise drops the
    // string before matching, so it must not be flagged.
    expect(forbiddenTestAdditions(['  expect(forbiddenTestAdditions(["it.skip(1)"])).toBe(1)'])).toEqual(
      [],
    );
    expect(forbiddenTestAdditions(['  const sql = "describe.only(x)";'])).toEqual([]);
    expect(forbiddenTestAdditions(['  const code = "try { x() } catch {}";'])).toEqual([]);
    // …but a REAL skip whose keyword is outside any string is still caught.
    expect(forbiddenTestAdditions(['  it.skip("still caught", () => {})']).length).toBe(1);
  });
  test("allows runtime-conditional skips, still flags static/unconditional ones", () => {
    // ALLOWED — Playwright runtime gate on environment/data, not a dodge.
    expect(forbiddenTestAdditions(['  test.skip(!RUN_REAL, "needs DOCKER_TEST=1")'])).toEqual([]);
    expect(forbiddenTestAdditions(["  test.skip(!pending, 'nothing real to accept')"])).toEqual([]);
    expect(forbiddenTestAdditions(["  it.skip(process.env.CI == null)"])).toEqual([]);
    // FORBIDDEN — static named skip, unconditional no-arg skip, static suite skip.
    expect(forbiddenTestAdditions(['  test.skip("permanently disabled", () => {})']).length).toBe(1);
    expect(forbiddenTestAdditions(["  it.skip()"]).length).toBe(1);
    expect(forbiddenTestAdditions(["  test.describe.skip('suite', () => {})"]).length).toBe(1);
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
  test("counts Playwright expect.poll / expect.soft as real assertions", () => {
    const polled = [
      "it('polls until settled', () => {",
      "  triggerAdd();",
      "  expect.poll(() => body).toEqual({ ok: true });",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(polled, new Set([2, 3]))).toEqual([]);
    const soft = [
      "it('soft asserts', () => {",
      "  doThing();",
      "  expect.soft(x).toBe(1);",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(soft, new Set([2, 3]))).toEqual([]);
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

// ── gate-integrity: stripBlockComments ──────────────────────────────────────
describe("gate-integrity: stripBlockComments", () => {
  test("blanks a JSDoc block, preserves line count, keeps following code", () => {
    const src = [
      "/**",
      " * e2e self-test (mockApi, no Docker).",
      " */",
      "const x = 1;",
    ].join("\n");
    const out = stripBlockComments(src);
    expect(out.split("\n").length).toBe(4); // newlines preserved
    expect(out).not.toContain("self-test"); // prose blanked
    expect(out).toContain("const x = 1;"); // real code survives
  });
  test("leaves a block-comment marker inside a string literal untouched", () => {
    const src = 'const s = "a /* not a comment */ b";';
    expect(stripBlockComments(src)).toBe(src);
  });
  test("does not treat /* appearing after // as a block comment", () => {
    const src = "const y = 2; // a /* b";
    expect(stripBlockComments(src)).toBe(src);
  });
  test("resumes code after the closing */", () => {
    const out = stripBlockComments("before /* mid */ after");
    expect(out).toContain("before");
    expect(out).toContain("after");
    expect(out).not.toContain("mid");
  });
});

// ── gate-integrity: unassertedAddedBlocks ignores block-comment prose ────────
describe("gate-integrity: unassertedAddedBlocks vs doc-comment prose", () => {
  test("a doc-comment 'self-test (…)' before a real test is NOT flagged", () => {
    // Before the fix the comment line matched TEST_OPENER → phantom vacuous
    // block. Regression guard for the false-positive hit on PR #24.
    const src = [
      "/**",
      " * Visual-evidence capture mechanism — e2e self-test (mockApi, no Docker).",
      " */",
      "test('real', () => {",
      "  expect(compute()).toBe(1);",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(src, new Set([1, 2, 3, 4, 5, 6]))).toEqual([]);
  });
  test("still flags a genuinely vacuous test that follows a doc comment", () => {
    const src = [
      "/**",
      " * helper self-test (no Docker).",
      " */",
      "test('vacuous', () => {",
      "  doThing();",
      "});",
    ].join("\n");
    const out = unassertedAddedBlocks(src, new Set([4, 5, 6]));
    expect(out.length).toBe(1);
    expect(out[0]).toContain("near line 4"); // the real test, not the comment
  });
});

// ── gate-integrity: deleted/renamed test files ──────────────────────────────
describe("gate-integrity: deletedOrRenamedTests", () => {
  test("flags a deleted test file", () => {
    const v = deletedOrRenamedTests("D\tsrc/__tests__/auth-tokens.test.ts");
    expect(v.length).toBe(1);
    expect(v[0]).toContain("DELETED");
    expect(v[0]).toContain("src/__tests__/auth-tokens.test.ts");
  });
  test("flags a renamed test file, including content-identical R100", () => {
    const v = deletedOrRenamedTests(
      "R100\tsrc/__tests__/auth-tokens.test.ts\tsrc/__tests__/tokens.test.ts",
    );
    expect(v.length).toBe(1);
    expect(v[0]).toContain("RENAMED");
    expect(v[0]).toContain("R100");
    expect(v[0]).toContain("src/__tests__/tokens.test.ts");
  });
  test("flags a partial-similarity rename (R87) and a .spec.ts", () => {
    const v = deletedOrRenamedTests("R087\tweb/e2e/hub.spec.ts\tweb/e2e/hub-view.spec.ts");
    expect(v.length).toBe(1);
    expect(v[0]).toContain("web/e2e/hub.spec.ts");
  });
  test("ignores added/modified test files and non-test deletions/renames", () => {
    const nameStatus = [
      "A\tsrc/__tests__/new.test.ts",
      "M\tsrc/__tests__/changed.test.ts",
      "D\tsrc/runtime/old-helper.ts",
      "R095\tsrc/runtime/a.ts\tsrc/runtime/b.ts",
      "",
    ].join("\n");
    expect(deletedOrRenamedTests(nameStatus)).toEqual([]);
  });
  test("a non-test file renamed TO a test path is not flagged (old side decides)", () => {
    expect(deletedOrRenamedTests("R090\tsrc/runtime/util.ts\tsrc/__tests__/util.test.ts")).toEqual(
      [],
    );
  });
  test("mixed multi-line diff reports each violation", () => {
    const nameStatus = [
      "D\tsrc/__tests__/a.test.ts",
      "R100\tsrc/__tests__/b.test.ts\tsrc/__tests__/c.test.ts",
      "M\tsrc/runtime/x.ts",
    ].join("\n");
    expect(deletedOrRenamedTests(nameStatus).length).toBe(2);
  });
  test("raw (core.quotePath=false) unicode/space paths are caught", () => {
    expect(deletedOrRenamedTests("D\tsrc/__tests__/wéird nàme.test.ts").length).toBe(1);
    expect(
      deletedOrRenamedTests("R100\tsrc/__tests__/ä b.test.ts\tsrc/__tests__/c.test.ts").length,
    ).toBe(1);
  });
  test("a C-quoted path (quotePath=true output) is still caught via the unquote fallback", () => {
    // The diff invocation pins -c core.quotePath=false; this fallback means a
    // quote-forcing filename can't dodge the suffix match even if quoted
    // output ever reaches the parser.
    const quoted = 'D\t"src/__tests__/w\\303\\251ird.test.ts"';
    const v = deletedOrRenamedTests(quoted);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("DELETED");
    const quotedRename =
      'R100\t"src/__tests__/w\\303\\251ird.test.ts"\t"src/__tests__/pl\\303\\244in.test.ts"';
    expect(deletedOrRenamedTests(quotedRename).length).toBe(1);
  });
});

// ── gate-integrity: fail-closed git-show classification ─────────────────────
describe("gate-integrity: isPathAbsentAtRev", () => {
  test("recognises git's two path-absent messages", () => {
    expect(
      isPathAbsentAtRev("fatal: path 'scripts/new.ts' does not exist in 'abc123'"),
    ).toBe(true);
    expect(
      isPathAbsentAtRev("fatal: path 'scripts/new.ts' exists on disk, but not in 'abc123'"),
    ).toBe(true);
  });
  test("any other git failure must NOT read as absence (fail closed)", () => {
    expect(isPathAbsentAtRev("fatal: invalid object name 'origin/nope'")).toBe(false);
    expect(isPathAbsentAtRev("fatal: bad revision 'HEAD~999'")).toBe(false);
    expect(isPathAbsentAtRev("")).toBe(false);
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
