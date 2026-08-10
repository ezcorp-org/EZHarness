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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCLUDES,
  escapeGlob,
  isExcluded,
  isSourceFile,
  parseHitLines,
  parseLcov,
  wildcardTreeDropouts,
  type FileCov,
} from "../../scripts/coverage-config.ts";
import {
  addedExcludes,
  biomeConfigFileViolations,
  biomeGateWeakenings,
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
import { addedOrRewrittenFiles, newFileViolations } from "../../scripts/check-new-file-coverage.ts";
import {
  binaryDiffFiles,
  shouldFailOnLcovAbsence,
  uncoveredAddedLines,
} from "../../scripts/check-patch-coverage.ts";
import {
  BACKEND_RATCHET_BASELINE,
  BACKEND_RATCHET_CEILING,
  E2E_RATCHET_BASELINE,
  E2E_RATCHET_CEILING,
  ratchetViolation,
} from "../../scripts/typecheck-tests.ts";
import {
  type AllowlistEntry,
  AuditUnavailableError,
  daysUntilExpiry,
  diffFindings,
  EXPIRY_WARN_DAYS,
  type Finding,
  isExpired,
  isFailing,
  meetsFloor,
  parseAllowlist,
  parseArgs,
  parseAuditJson,
  severityRank,
  utcToday,
} from "../../scripts/audit-deps.ts";
import {
  checkEdge,
  checkSource,
  extractSpecifiers,
  isTestPath,
  resolveSpecifier,
  WORKER_ALLOWED_EXACT,
  WORKER_ALLOWED_PREFIXES,
  WORKER_FORBIDDEN_SUBSYSTEMS,
} from "../../scripts/check-boundaries.ts";

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

  test("a DELETED file's lines land on ITSELF, never on the file before it", () => {
    // The bug this pins (found 2026-08-03 retiring `ez-code-factory`): a
    // deleted file's new-side header is `+++ /dev/null`, not `+++ b/<path>`.
    // Keying only off `+++ b/` left the parser pointing at the PREVIOUS file
    // and shovelled every deleted line into its `removedTexts` — so the
    // gutting check (8) accused whichever modified test file happened to sort
    // just before the deletion of being hollowed out. Five deleted specs put
    // 172 phantom removals on a file the same diff only ADDED 130 lines to.
    //
    // Why that matters more than a wrong message: the only way past check 8
    // is the `gate-change-approved` label, which bypasses ALL the other
    // checks. A routine deletion must not be what buys a PR a blanket bypass.
    const diff = [
      "diff --git a/keep.test.ts b/keep.test.ts",
      "--- a/keep.test.ts",
      "+++ b/keep.test.ts",
      "@@ -1,0 +2,1 @@",
      "+  expect(added).toBe(true);",
      "diff --git a/gone.test.ts b/gone.test.ts",
      "deleted file mode 100644",
      "--- a/gone.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-  expect(x).toBe(1);",
      "-  expect(y).toBe(2);",
    ].join("\n");
    const map = parseUnifiedDiff(diff);
    // The survivor is untouched by the deletion that followed it.
    expect(map.get("keep.test.ts")!.removedTexts).toEqual([]);
    expect(map.get("keep.test.ts")!.addedTexts).toEqual(["  expect(added).toBe(true);"]);
    // The deleted file gets its OWN entry, keyed by its old path.
    expect(map.get("gone.test.ts")!.removedTexts).toEqual([
      "  expect(x).toBe(1);",
      "  expect(y).toBe(2);",
    ]);
    expect(map.get("gone.test.ts")!.addedTexts).toEqual([]);
  });

  test("an ADDED file (`--- /dev/null`) still keys off its `+++ b/` path", () => {
    // The mirror case: the old-side header of a new file is `/dev/null`, and
    // it must not be mistaken for the previous file's old path or for a
    // removed line.
    const diff = [
      "diff --git a/new.test.ts b/new.test.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.test.ts",
      "@@ -0,0 +1,1 @@",
      "+  expect(fresh).toBe(1);",
    ].join("\n");
    const map = parseUnifiedDiff(diff);
    expect([...map.keys()]).toEqual(["new.test.ts"]);
    expect(map.get("new.test.ts")!.addedTexts).toEqual(["  expect(fresh).toBe(1);"]);
    expect(map.get("new.test.ts")!.removedTexts).toEqual([]);
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
  /**
   * The detector is content-aware (file text + the set of added line numbers),
   * so these fixtures are written as LINES and joined — every line counts as
   * added, which is what a brand-new hunk looks like.
   */
  const scan = (...lines: string[]): string[] =>
    forbiddenTestAdditions(lines.join("\n"), new Set(lines.map((_, i) => i + 1)));

  test("flags .skip / .only / .todo and x/f variants", () => {
    expect(scan("  it.skip('x', () => {})").length).toBe(1);
    expect(scan("  describe.only('x', () => {})").length).toBe(1);
    expect(scan("  test.todo('later')").length).toBe(1);
    expect(scan("  xit('x', () => {})").length).toBe(1);
    expect(scan("  fdescribe('x', () => {})").length).toBe(1);
  });
  test("flags empty catch blocks", () => {
    expect(scan("  try { x() } catch {}").length).toBe(1);
    expect(scan("  } catch (e) {}").length).toBe(1);
  });
  test("does not flag normal test code or commented-out skips", () => {
    expect(scan("  it('real', () => { expect(1).toBe(1) })")).toEqual([]);
    expect(scan("  // it.skip('disabled')")).toEqual([]);
    expect(scan("  } catch (e) { handle(e) }")).toEqual([]);
  });
  test("does not flag skip/only/empty-catch that only appear inside a string literal", () => {
    // A line that merely MENTIONS the pattern inside a quoted string (e.g. this
    // gate's own test fixtures) is not an executable cheat — stripNoise drops the
    // string before matching, so it must not be flagged.
    expect(scan('  expect(forbiddenTestAdditions(["it.skip(1)"])).toBe(1)')).toEqual([]);
    expect(scan('  const sql = "describe.only(x)";')).toEqual([]);
    expect(scan('  const code = "try { x() } catch {}";')).toEqual([]);
    // …but a REAL skip whose keyword is outside any string is still caught.
    expect(scan('  it.skip("still caught", () => {})').length).toBe(1);
  });
  test("allows runtime-conditional skips, still flags static/unconditional ones", () => {
    // ALLOWED — Playwright runtime gate on environment/data, not a dodge.
    expect(scan('  test.skip(!RUN_REAL, "needs DOCKER_TEST=1")')).toEqual([]);
    expect(scan("  test.skip(!pending, 'nothing real to accept')")).toEqual([]);
    expect(scan("  it.skip(process.env.CI == null)")).toEqual([]);
    // FORBIDDEN — static named skip, unconditional no-arg skip, static suite skip.
    expect(scan('  test.skip("permanently disabled", () => {})').length).toBe(1);
    expect(scan("  it.skip()").length).toBe(1);
    expect(scan("  test.describe.skip('suite', () => {})").length).toBe(1);
  });

  // ── layout insensitivity ──────────────────────────────────────────────────
  // A line break must not hide a cheat. This is not hypothetical: a formatter
  // broke `test.describe.skip(` into `test.describe` / `.skip(` in three e2e
  // specs, and the per-line scan that preceded this stopped seeing all three
  // (repo-wide detector-visible skips fell 23 -> 20). Hand-wrapping a long
  // title past the margin does the same thing.
  test("catches a skip/only/todo whose member chain is SPLIT across lines", () => {
    expect(scan("test.describe", '  .skip("Landing page", () => {', "});").length).toBe(1);
    expect(scan("test", '  .only("x", () => {});').length).toBe(1);
    expect(scan("it", '  .todo("later");').length).toBe(1);
    expect(scan("test", '  .skip("name", fn);').length).toBe(1);
    // The whole construct is reported as one finding, not one per line.
    expect(scan("test.describe", '  .skip("Landing page", () => {', "});")[0]).toContain(
      "test.describe .skip",
    );
  });
  test("catches an empty catch whose braces are SPLIT across lines", () => {
    expect(scan("try { x(); } catch (e)", "{", "}").length).toBe(1);
    expect(scan("} catch {", "}").length).toBe(1);
  });
  test("a comment-only catch body is NOT an empty catch", () => {
    // The rule is unchanged by this hardening: a documented swallow keeps its
    // body. Stripping comments before matching would turn ~180 existing
    // `catch { /* why */ }` into violations — a change to the RULE, not to
    // line-break tolerance. EMPTY_CATCH must therefore hold in the RAW source.
    expect(scan("} catch {", "  // best-effort, nothing to do", "}")).toEqual([]);
    expect(scan("try { x(); } catch { /* swallow */ }")).toEqual([]);
  });
  test("prose in a BLOCK comment is not a cheat", () => {
    // `\bfit\b` matches the English word "fit"; `describe.skip` appears in
    // doc comments that explain how to re-enable a suite. Neither is code.
    expect(scan("/**", " * trims whole turns to fit a per-model budget.", " */")).toEqual([]);
    expect(scan("/**", " * → flip `test.describe.skip` to `test.describe`.", " */")).toEqual([]);
    expect(scan("/* try { x() } catch {} */")).toEqual([]);
  });
  test("an unrelated .skip() method call is not a test skip", () => {
    expect(scan("const rows = cursor.skip(10);")).toEqual([]);
    expect(scan("const rows = query", "  .skip(5)", "  .take(10);")).toEqual([]);
  });
  test("only findings that INTERSECT an added line are reported", () => {
    // Diff-scoping is unchanged: an untouched pre-existing skip stays silent.
    const src = ["test.describe", '  .skip("old suite", () => {});', 'test("new", () => {});'].join(
      "\n",
    );
    expect(forbiddenTestAdditions(src, new Set([3]))).toEqual([]);
    expect(forbiddenTestAdditions(src, new Set([2])).length).toBe(1);
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
  // ── extent correctness (parser-grade scan, not a per-line brace walk) ─────

  test("a MULTI-LINE TEMPLATE LITERAL no longer truncates the block", () => {
    // The per-line scanner reset its quote state at every newline, so braces
    // inside a multi-line template leaked into the brace count and ended the
    // block early — the assertion below fell OUTSIDE the scanned range and the
    // test was reported vacuous. 18 blocks on this tree were mis-scoped this way.
    const src = [
      "test('writes a config', async () => {",
      "  const cfg = `export default ${JSON.stringify({",
      "    name: 'x',",
      "    tools: [],",
      "  })};`;",
      "  await write(cfg);",
      "  expect(cfg).toContain('export default');",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(src, new Set([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });

  test("a CONCISE ARROW body is examined at all (it used to be skipped)", () => {
    // `test("x", () => f())` has no `{`, so the old scanner never found an
    // opening brace, bailed, and never judged the block. A genuinely vacuous
    // concise-arrow test was invisible to the gate.
    const vacuous = `test("rejects loopback", () => doThing("127.0.0.1"));`;
    expect(unassertedAddedBlocks(vacuous, new Set([1])).length).toBe(1);
    const asserts = `test("rejects loopback", () => expect(check("127.0.0.1")).toBe(false));`;
    expect(unassertedAddedBlocks(asserts, new Set([1]))).toEqual([]);
  });

  test("an assertion mentioned only in a COMMENT no longer satisfies the gate", () => {
    // The old scan tested the RAW line, so the word "assert" in a comment
    // credited the block. Writing `// just assert it doesn't crash` above a
    // bare call was enough to pass an anti-cheat gate.
    const src = [
      "test('unarmed conversation does not crash', async () => {",
      "  // just assert that calling the default does not crash",
      "  await host.start();",
      "  host.stop();",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(src, new Set([1, 2, 3, 4, 5])).length).toBe(1);
  });

  test("an assertion inside a STRING LITERAL no longer satisfies the gate", () => {
    const src = [
      "test('renders sample source', async () => {",
      "  const sample = \"expect(1).toBe(1)\";",
      "  await render(sample);",
      "});",
    ].join("\n");
    expect(unassertedAddedBlocks(src, new Set([1, 2, 3, 4])).length).toBe(1);
  });

  test("a REGEX literal carrying quotes/parens does not desync the scan", () => {
    // `/from\s+["']x["']/` holds both quote characters; untracked, one of them
    // opens a phantom string that poisons the mask for the rest of the FILE.
    const src = [
      "test('imports from the shared module', async () => {",
      "  const ok = /from\\s+[\"']\\$server\\/fs[\"']/.test(src);",
      "  const c = [...html.matchAll(/color:(rgb\\([^)]*\\))/g)];",
      "  expect(ok).toBe(true);",
      "});",
      "test('a later vacuous test is still seen', () => {",
      "  doThing();",
      "});",
    ].join("\n");
    const all = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    const found = unassertedAddedBlocks(src, all);
    // First test asserts → silent. Second is vacuous → exactly one finding,
    // which also proves the mask recovered rather than desyncing.
    expect(found.length).toBe(1);
    expect(found[0]).toContain("a later vacuous test is still seen");
  });

  test("hooks and describe blocks are never judged as tests", () => {
    const src = [
      "test.beforeEach(async ({ page }) => {",
      "  await page.setViewportSize({ width: 400, height: 800 });",
      "});",
      "describe('a suite', () => {",
      "  setup();",
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
    const perFile = new Map([["src/runtime/new.ts", cov(10, 10)]]);
    expect(newFileViolations(["src/runtime/new.ts"], perFile, ["src/runtime/**"])).toEqual([]);
  });
  test("file present in lcov but with 0 measured lines is treated as unmeasured", () => {
    const perFile = new Map([["src/runtime/new.ts", cov(0, 0)]]);
    const v = newFileViolations(["src/runtime/new.ts"], perFile, ["src/runtime/**"]);
    expect(v[0]).toContain("no measured coverage");
  });
  test("a CATCH-ALL key does NOT count as gated — new files still need their own key", () => {
    // src/** is a ratchet-floor catch-all (CATCHALL_THRESHOLD_KEYS); if it
    // satisfied this gate, the new-file-gets-a-100-key policy would
    // silently retire the day the catch-all landed.
    const perFile = new Map([["src/new.ts", cov(10, 10)]]);
    const v = newFileViolations(["src/new.ts"], perFile, ["src/**", "web/src/**"]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("not gated");
  });
  test("a specific key still gates even when a catch-all is also present", () => {
    const perFile = new Map([["src/new.ts", cov(10, 10)]]);
    expect(newFileViolations(["src/new.ts"], perFile, ["src/**", "src/new.ts"])).toEqual([]);
  });
});

describe("check-new-file-coverage: addedOrRewrittenFiles (R>=50 rename dodge)", () => {
  test("A rows and rename rows >= R50 are included (new path); others ignored", () => {
    const ns = [
      "A\tsrc/brand-new.ts",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
      "R073\tsrc/rewritten.ts\tsrc/rewritten-v2.ts",
      "R049\tsrc/below-git-floor.ts\tsrc/below-v2.ts",
      "M\tsrc/modified.ts",
      "D\tsrc/deleted.ts",
      "",
    ].join("\n");
    expect(addedOrRewrittenFiles(ns)).toEqual([
      "src/brand-new.ts",
      "src/new-name.ts",
      "src/rewritten-v2.ts",
    ]);
  });
  test("an R row with an unparseable score fails CLOSED (treated like A)", () => {
    expect(addedOrRewrittenFiles("R\tsrc/a.ts\tsrc/b.ts")).toEqual(["src/b.ts"]);
  });
  test("empty / whitespace input yields nothing", () => {
    expect(addedOrRewrittenFiles("")).toEqual([]);
    expect(addedOrRewrittenFiles("\n \n")).toEqual([]);
  });
});

// ── check-patch-coverage: lcov-absence policy ───────────────────────────────
describe("check-patch-coverage: shouldFailOnLcovAbsence", () => {
  test("changed .ts source with added lines and no lcov data FAILS", () => {
    expect(shouldFailOnLcovAbsence("src/runtime/foo.ts", 3)).toBe(true);
  });
  test(".svelte absence stays skip (only vitest-included components are measurable)", () => {
    expect(shouldFailOnLcovAbsence("web/src/lib/components/X.svelte", 3)).toBe(false);
  });
  test("pure-deletion hunks (no added lines) never fail on absence", () => {
    expect(shouldFailOnLcovAbsence("src/runtime/foo.ts", 0)).toBe(false);
  });
});

// ── typecheck-tests: ratchet validation (subset-of-baseline) ────────────────
describe("typecheck-tests: ratchetViolation", () => {
  const baseline = ["src/__tests__/a.test.ts", "src/__tests__/b.test.ts", "src/__tests__/c.test.ts"];

  test("subset of the baseline within the ceiling passes", () => {
    expect(ratchetViolation("k", ["src/__tests__/a.test.ts"], 3, baseline)).toBeNull();
    expect(ratchetViolation("k", [], 3, baseline)).toBeNull();
  });

  test("SWAP is rejected even at constant length (remove b, add d)", () => {
    const v = ratchetViolation(
      "k",
      ["src/__tests__/a.test.ts", "src/__tests__/d.test.ts"],
      3,
      baseline,
    );
    expect(v).toContain("not in the landing-time baseline");
  });

  test("growth past the ceiling is rejected", () => {
    expect(ratchetViolation("k", baseline, 2, baseline)).toContain("> ceiling");
  });

  test("duplicates and non-string shapes are rejected", () => {
    const dup = ["src/__tests__/a.test.ts", "src/__tests__/a.test.ts"];
    expect(ratchetViolation("k", dup, 3, baseline)).toContain("duplicates");
    expect(ratchetViolation("k", "nope", 3, baseline)).toContain("string array");
    expect(ratchetViolation("k", [42], 3, baseline)).toContain("string array");
  });

  test("the COMMITTED ratchet passes against the committed baselines + ceilings", async () => {
    const raw = (await Bun.file(
      join(import.meta.dir, "..", "..", "scripts/typecheck-tests-ratchet.json"),
    ).json()) as { backendTests: string[]; e2eSpecs: string[] };
    expect(
      ratchetViolation("backendTests", raw.backendTests, BACKEND_RATCHET_CEILING, BACKEND_RATCHET_BASELINE),
    ).toBeNull();
    expect(
      ratchetViolation("e2eSpecs", raw.e2eSpecs, E2E_RATCHET_CEILING, E2E_RATCHET_BASELINE),
    ).toBeNull();
  });
});

// ── merge-lcov: empty-input guard (CLI-level — the script runs at import) ──
describe("merge-lcov: refuses to write an empty merge", () => {
  const REPO_ROOT_ML = join(import.meta.dir, "..", "..");
  function runMerge(globArg: string, out: string) {
    const proc = Bun.spawnSync(["bun", "scripts/merge-lcov.ts", globArg, out], {
      cwd: REPO_ROOT_ML,
    });
    return { code: proc.exitCode, err: proc.stderr.toString() };
  }

  test("glob matching no lcov input → exit 1, no output written", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-lcov-guard-"));
    const out = join(dir, "out.info");
    const { code, err } = runMerge(join(dir, "nope-does-not-exist.info"), out);
    expect(code).toBe(1);
    expect(err).toContain("matched no lcov input");
    expect(existsSync(out)).toBe(false);
  });

  test("real input still merges (guard doesn't over-trigger)", () => {
    const dir = mkdtempSync(join(tmpdir(), "merge-lcov-ok-"));
    writeFileSync(
      join(dir, "one.info"),
      "TN:\nSF:src/example-under-test.ts\nDA:1,1\nLF:1\nLH:1\nend_of_record\n",
    );
    const out = join(dir, "out.info");
    const { code } = runMerge(join(dir, "*.info"), out);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
  });
});

// ── check-coverage: wildcard whole-tree dropout ─────────────────────────────
describe("check-coverage: wildcardTreeDropouts", () => {
  test("tree present in lcov → no dropout (even when shadowed by specific keys)", () => {
    const v = wildcardTreeDropouts(["src/suggest/**"], ["src/suggest/enhance.ts"], () => [
      "src/suggest/enhance.ts",
    ]);
    expect(v).toEqual([]);
  });
  test("tree with on-disk source files but ZERO lcov matches → violation", () => {
    const v = wildcardTreeDropouts(["src/suggest/**"], ["src/other/x.ts"], () => [
      "src/suggest/enhance.ts",
      "src/suggest/config.ts",
    ]);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("NONE of them");
  });
  test("tree whose only on-disk matches are tests/types → no violation", () => {
    const v = wildcardTreeDropouts(["src/suggest/**"], [], () => [
      "src/suggest/__tests__/enhance.test.ts",
      "src/suggest/types.d.ts",
    ]);
    expect(v).toEqual([]);
  });
  test("pattern matching nothing on disk (dead key) → no violation", () => {
    expect(wildcardTreeDropouts(["src/gone/**"], [], () => [])).toEqual([]);
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

// A binary-classified source emits no hunks, so parseUnifiedDiff never sees it
// and every per-file check is skipped while the gate still says PASSED. These
// pin the explicit detection that closes that hole.
describe("check-patch-coverage: binaryDiffFiles", () => {
  // Verbatim shape git emits for a NEW file it considers binary — this is
  // exactly what one raw NUL in a .ts source produced in PR #37.
  const NEW_BINARY = [
    "diff --git a/scripts/routing-export.ts b/scripts/routing-export.ts",
    "new file mode 100644",
    "index 00000000..7e95a672",
    "Binary files /dev/null and b/scripts/routing-export.ts differ",
    "",
  ].join("\n");

  test("flags a new binary-classified file", () => {
    expect(binaryDiffFiles(NEW_BINARY)).toEqual(["scripts/routing-export.ts"]);
  });

  test("flags a MODIFIED binary file (both sides present)", () => {
    const diff = [
      "diff --git a/src/runtime/x.ts b/src/runtime/x.ts",
      "index aaaaaaa..bbbbbbb 100644",
      "Binary files a/src/runtime/x.ts and b/src/runtime/x.ts differ",
    ].join("\n");
    expect(binaryDiffFiles(diff)).toEqual(["src/runtime/x.ts"]);
  });

  test("ignores a DELETED binary file — no added lines to cover", () => {
    const diff = [
      "diff --git a/src/runtime/gone.ts b/src/runtime/gone.ts",
      "deleted file mode 100644",
      "Binary files a/src/runtime/gone.ts and /dev/null differ",
    ].join("\n");
    expect(binaryDiffFiles(diff)).toEqual([]);
  });

  test("an ordinary text diff yields nothing", () => {
    const diff = [
      "diff --git a/src/runtime/y.ts b/src/runtime/y.ts",
      "--- a/src/runtime/y.ts",
      "+++ b/src/runtime/y.ts",
      "@@ -1,0 +2,1 @@",
      "+const a = 1;",
    ].join("\n");
    expect(binaryDiffFiles(diff)).toEqual([]);
  });

  test("an added line that merely LOOKS like the marker is not matched", () => {
    // `+Binary files … differ` is diff CONTENT, not a git status line.
    const diff = [
      "+++ b/src/runtime/z.ts",
      "@@ -0,0 +1 @@",
      "+Binary files a/fake.ts and b/fake.ts differ",
    ].join("\n");
    expect(binaryDiffFiles(diff)).toEqual([]);
  });

  test("collects every binary source in a multi-file diff", () => {
    expect(binaryDiffFiles(`${NEW_BINARY}\nBinary files a/b.ts and b/src/c.ts differ`)).toEqual([
      "scripts/routing-export.ts",
      "src/c.ts",
    ]);
  });

  test("empty diff yields nothing", () => {
    expect(binaryDiffFiles("")).toEqual([]);
  });
});

// ── audit-deps: severity floor ──────────────────────────────────────────────
describe("audit-deps: severity ordering", () => {
  test("ranks ascending and rejects unknown severities", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("moderate"));
    expect(severityRank("moderate")).toBeGreaterThan(severityRank("low"));
    expect(severityRank("banana")).toBe(-1);
  });

  test("meetsFloor is inclusive at the floor and never true for unknown", () => {
    expect(meetsFloor("high", "high")).toBe(true);
    expect(meetsFloor("critical", "high")).toBe(true);
    expect(meetsFloor("moderate", "high")).toBe(false);
    // An unranked severity must never block — a schema change at npm must not
    // turn every advisory into a hard failure.
    expect(meetsFloor("banana", "low")).toBe(false);
  });
});

// ── audit-deps: parseAuditJson ──────────────────────────────────────────────
describe("audit-deps: parseAuditJson", () => {
  test("maps the flat {package: Advisory[]} payload into findings", () => {
    const raw = JSON.stringify({
      tar: [
        {
          id: 1,
          url: "https://github.com/advisories/GHSA-23hp-3jrh-7fpw",
          title: "node-tar DoS",
          severity: "critical",
          vulnerable_versions: "<=7.5.18",
        },
      ],
    });
    expect(parseAuditJson(raw, "web")).toEqual([
      {
        root: "web",
        pkg: "tar",
        ghsa: "GHSA-23hp-3jrh-7fpw",
        severity: "critical",
        title: "node-tar DoS",
        vulnerableVersions: "<=7.5.18",
      },
    ]);
  });

  test("dedupes the SAME advisory repeated per major range, keeping the worst severity", () => {
    // npm really does emit one row per vulnerable major (observed on
    // brace-expansion: GHSA-mh99-v99m-4gvg twice, ids 1130588 + 1130589).
    const raw = JSON.stringify({
      "brace-expansion": [
        { id: 1, url: ".../GHSA-mh99-v99m-4gvg", severity: "moderate", vulnerable_versions: "<1.1.17" },
        { id: 2, url: ".../GHSA-mh99-v99m-4gvg", severity: "high", vulnerable_versions: ">=2.0.0 <2.1.3" },
      ],
    });
    const findings = parseAuditJson(raw, ".");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("high");
    expect(findings[0]?.vulnerableVersions).toBe(">=2.0.0 <2.1.3");
  });

  test("sorts worst-first so the log leads with the criticals", () => {
    const raw = JSON.stringify({
      aaa: [{ id: 1, url: ".../GHSA-aaaa-aaaa-aaaa", severity: "high" }],
      zzz: [{ id: 2, url: ".../GHSA-zzzz-zzzz-zzzz", severity: "critical" }],
    });
    expect(parseAuditJson(raw, ".").map((f) => f.pkg)).toEqual(["zzz", "aaa"]);
  });

  test("falls back to the numeric npm id when the url carries no GHSA", () => {
    const raw = JSON.stringify({ foo: [{ id: 42, url: "https://example.com/x", severity: "high" }] });
    expect(parseAuditJson(raw, ".")[0]?.ghsa).toBe("npm-42");
  });

  test("skips junk rows without discarding the good ones", () => {
    const raw = JSON.stringify({
      good: [{ id: 1, url: ".../GHSA-good-good-good", severity: "high" }],
      notAnArray: { nope: true },
      hasNulls: [null, { url: ".../GHSA-ok11-ok11-ok11", severity: "low" }],
      noId: [{ severity: "critical" }],
    });
    expect(parseAuditJson(raw, ".").map((f) => f.ghsa).sort()).toEqual([
      "GHSA-good-good-good",
      "GHSA-ok11-ok11-ok11",
    ]);
  });

  test("empty stdout is UNAVAILABLE, not a clean audit", () => {
    // The whole point: a registry blip must never read as zero advisories.
    expect(() => parseAuditJson("", ".")).toThrow(AuditUnavailableError);
    expect(() => parseAuditJson("   \n ", ".")).toThrow(AuditUnavailableError);
  });

  test("non-JSON and non-object payloads are UNAVAILABLE", () => {
    expect(() => parseAuditJson("ConnectionRefused: audit request failed", ".")).toThrow(
      AuditUnavailableError,
    );
    expect(() => parseAuditJson("[]", ".")).toThrow(AuditUnavailableError);
    expect(() => parseAuditJson("null", ".")).toThrow(AuditUnavailableError);
  });

  test("a genuinely clean audit ({}) is zero findings, NOT unavailable", () => {
    expect(parseAuditJson("{}", ".")).toEqual([]);
  });
});

// ── audit-deps: allowlist parsing/validation ────────────────────────────────
describe("audit-deps: parseAllowlist", () => {
  const REASON = "A substantive justification that comfortably clears the minimum length bar.";
  const OK = {
    ghsa: "GHSA-f88m-g3jw-g9cj",
    package: "sharp",
    path: "a › b › sharp",
    severity: "high",
    reason: REASON,
    expires: "2099-01-01",
  };
  const wrap = (entries: unknown[]) => JSON.stringify({ ignore: entries });

  test("accepts a well-formed entry", () => {
    const { entries, problems } = parseAllowlist(wrap([OK]));
    expect(problems).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.package).toBe("sharp");
  });

  test("rejects invalid JSON and a missing ignore array", () => {
    expect(parseAllowlist("{not json").problems[0]).toContain("not valid JSON");
    expect(parseAllowlist("{}").problems[0]).toContain('"ignore" array');
    expect(parseAllowlist(JSON.stringify({ ignore: {} })).problems[0]).toContain('"ignore" array');
  });

  test("rejects missing or blank required fields", () => {
    const { entries, problems } = parseAllowlist(wrap([{ ...OK, reason: "   ", path: undefined }]));
    expect(entries).toEqual([]);
    expect(problems[0]).toContain("missing/blank");
    expect(problems[0]).toContain("path");
    expect(problems[0]).toContain("reason");
  });

  test("rejects a non-object entry", () => {
    expect(parseAllowlist(wrap(["GHSA-nope"])).problems[0]).toContain("not an object");
  });

  test("rejects an expiry that is not a real YYYY-MM-DD date", () => {
    expect(parseAllowlist(wrap([{ ...OK, expires: "soon" }])).problems[0]).toContain("YYYY-MM-DD");
    expect(parseAllowlist(wrap([{ ...OK, expires: "2026-13-45" }])).problems[0]).toContain(
      "YYYY-MM-DD",
    );
  });

  test("rejects a rubber-stamp reason — the file suppresses security findings", () => {
    const { entries, problems } = parseAllowlist(wrap([{ ...OK, reason: "no fix" }]));
    expect(entries).toEqual([]);
    expect(problems[0]).toContain("real justification");
  });

  test("rejects a duplicate package+ghsa pair", () => {
    const { entries, problems } = parseAllowlist(wrap([OK, { ...OK, expires: "2099-06-01" }]));
    expect(entries).toHaveLength(1);
    expect(problems[0]).toContain("duplicate entry");
  });

  test("the COMMITTED allowlist is well-formed", async () => {
    const raw = await Bun.file(
      join(import.meta.dir, "..", "..", "scripts/audit-allowlist.json"),
    ).text();
    const { entries, problems } = parseAllowlist(raw);
    expect(problems).toEqual([]);
    // Every committed suppression must still be in date — a landed-but-expired
    // entry would red the gate on main.
    for (const entry of entries) expect(isExpired(entry, utcToday())).toBe(false);
  });
});

// ── audit-deps: expiry arithmetic ───────────────────────────────────────────
describe("audit-deps: expiry", () => {
  const entry = (expires: string): AllowlistEntry => ({
    ghsa: "GHSA-x",
    package: "p",
    path: "p",
    severity: "high",
    reason: "r",
    expires,
  });

  test("expiry is inclusive — the entry dies ON its expires date", () => {
    expect(isExpired(entry("2026-08-05"), "2026-08-05")).toBe(true);
    expect(isExpired(entry("2026-08-06"), "2026-08-05")).toBe(false);
    expect(isExpired(entry("2026-08-04"), "2026-08-05")).toBe(true);
  });

  test("daysUntilExpiry counts forward and goes negative once past", () => {
    expect(daysUntilExpiry(entry("2026-08-15"), "2026-08-05")).toBe(10);
    expect(daysUntilExpiry(entry("2026-08-05"), "2026-08-05")).toBe(0);
    expect(daysUntilExpiry(entry("2026-08-01"), "2026-08-05")).toBe(-4);
  });

  test("utcToday is a UTC YYYY-MM-DD, not a local one", () => {
    // 23:30 UTC — a local-time formatter east of UTC would roll to the 6th.
    expect(utcToday(new Date("2026-08-05T23:30:00Z"))).toBe("2026-08-05");
    expect(utcToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── audit-deps: findings × allowlist ────────────────────────────────────────
describe("audit-deps: diffFindings", () => {
  const TODAY = "2026-08-05";
  const finding = (over: Partial<Finding> = {}): Finding => ({
    root: ".",
    pkg: "sharp",
    ghsa: "GHSA-f88m-g3jw-g9cj",
    severity: "high",
    title: "libvips",
    vulnerableVersions: "<0.35.0",
    ...over,
  });
  const allow = (over: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
    ghsa: "GHSA-f88m-g3jw-g9cj",
    package: "sharp",
    path: "t › sharp",
    severity: "high",
    reason: "r",
    expires: "2099-01-01",
    ...over,
  });

  test("an unallowlisted finding at the floor BLOCKS", () => {
    const r = diffFindings({ findings: [finding()], allowlist: [], floor: "high", today: TODAY });
    expect(r.blocking).toHaveLength(1);
    expect(isFailing(r)).toBe(true);
  });

  test("a live allowlist entry suppresses it", () => {
    const r = diffFindings({
      findings: [finding()],
      allowlist: [allow()],
      floor: "high",
      today: TODAY,
    });
    expect(r.blocking).toEqual([]);
    expect(r.suppressed).toHaveLength(1);
    expect(r.stale).toEqual([]);
    expect(isFailing(r)).toBe(false);
  });

  test("one entry covers the SAME advisory in both lockfiles", () => {
    const r = diffFindings({
      findings: [finding(), finding({ root: "web" })],
      allowlist: [allow()],
      floor: "high",
      today: TODAY,
    });
    expect(r.suppressed).toHaveLength(2);
    expect(isFailing(r)).toBe(false);
  });

  test("below-floor findings are reported but never block", () => {
    const r = diffFindings({
      findings: [finding({ severity: "moderate" })],
      allowlist: [],
      floor: "high",
      today: TODAY,
    });
    expect(r.blocking).toEqual([]);
    expect(r.belowFloor).toHaveLength(1);
    expect(isFailing(r)).toBe(false);
  });

  test("lowering the floor promotes a below-floor finding to blocking", () => {
    const r = diffFindings({
      findings: [finding({ severity: "moderate" })],
      allowlist: [],
      floor: "moderate",
      today: TODAY,
    });
    expect(r.blocking).toHaveLength(1);
  });

  test("an EXPIRED entry stops suppressing AND is itself a failure", () => {
    const r = diffFindings({
      findings: [finding()],
      allowlist: [allow({ expires: "2026-01-01" })],
      floor: "high",
      today: TODAY,
    });
    expect(r.blocking).toHaveLength(1);
    expect(r.suppressed).toEqual([]);
    expect(r.expired).toHaveLength(1);
    expect(r.stale).toEqual([]); // it matched a live advisory, it's just out of date
    expect(isFailing(r)).toBe(true);
  });

  test("a STALE entry matching nothing fails even with zero findings", () => {
    const r = diffFindings({ findings: [], allowlist: [allow()], floor: "high", today: TODAY });
    expect(r.blocking).toEqual([]);
    expect(r.expired).toEqual([]);
    expect(r.stale).toHaveLength(1);
    expect(isFailing(r)).toBe(true);
  });

  test("staleness is judged against ALL findings, not just those above the floor", () => {
    // An advisory re-scored high → moderate is still live, so its entry is not
    // yet rot; deleting it would just re-block the day npm re-scores it back.
    const r = diffFindings({
      findings: [finding({ severity: "moderate" })],
      allowlist: [allow()],
      floor: "high",
      today: TODAY,
    });
    expect(r.stale).toEqual([]);
    expect(isFailing(r)).toBe(false);
  });

  test("an entry for a different package with the same GHSA does not match", () => {
    const r = diffFindings({
      findings: [finding()],
      allowlist: [allow({ package: "not-sharp" })],
      floor: "high",
      today: TODAY,
    });
    expect(r.blocking).toHaveLength(1);
    expect(r.stale).toHaveLength(1);
  });

  test("an entry inside the warn window is flagged but stays green", () => {
    const soon = new Date(Date.parse(`${TODAY}T00:00:00Z`) + (EXPIRY_WARN_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = diffFindings({
      findings: [finding()],
      allowlist: [allow({ expires: soon })],
      floor: "high",
      today: TODAY,
    });
    expect(r.expiringSoon).toHaveLength(1);
    expect(isFailing(r)).toBe(false);
  });

  test("a far-future entry is not flagged as expiring soon", () => {
    const r = diffFindings({
      findings: [finding()],
      allowlist: [allow()],
      floor: "high",
      today: TODAY,
    });
    expect(r.expiringSoon).toEqual([]);
  });

  test("a clean tree with an empty allowlist passes", () => {
    const r = diffFindings({ findings: [], allowlist: [], floor: "high", today: TODAY });
    expect(isFailing(r)).toBe(false);
  });
});

// ── audit-deps: argv ────────────────────────────────────────────────────────
describe("audit-deps: parseArgs", () => {
  const ROOT = "/repo";

  test("defaults audit BOTH lockfiles at the high floor", () => {
    const o = parseArgs([], ROOT);
    expect(o.roots).toEqual([".", "web"]);
    expect(o.floor).toBe("high");
    expect(o.allowlistPath).toBe("/repo/scripts/audit-allowlist.json");
  });

  test("accepts space- and equals-separated flags", () => {
    expect(parseArgs(["--severity", "moderate"], ROOT).floor).toBe("moderate");
    expect(parseArgs(["--severity=critical"], ROOT).floor).toBe("critical");
    expect(parseArgs(["--roots=.,web,other"], ROOT).roots).toEqual([".", "web", "other"]);
    expect(parseArgs(["--allowlist", "tmp/a.json"], ROOT).allowlistPath).toBe("/repo/tmp/a.json");
  });

  test("a typo'd flag is a hard error, never a silently wider gate", () => {
    expect(() => parseArgs(["--serverity", "high"], ROOT)).toThrow("unknown flag");
    expect(() => parseArgs(["--severity"], ROOT)).toThrow("missing value");
    expect(() => parseArgs(["--severity", "banana"], ROOT)).toThrow("--severity must be one of");
  });
});

// ── gate-integrity: biome.json weakening (checks 9 + 10) ────────────────────
//
// `biome.json` is the LINT gate's un-gating surface — structurally identical
// to `EXCLUDES` (issue #143). These fixtures are deliberately adversarial: for
// every shape that MUST fire there is a paired shape that must stay SILENT,
// because a gate that fires on strengthening gets routed around, and a gate
// nobody tried to bypass has not been tested.

type BiomeLinterFixture = { enabled?: boolean; rules?: Record<string, unknown> };
type BiomeFixture = {
  files?: { includes?: string[] };
  formatter?: { enabled?: boolean };
  linter?: BiomeLinterFixture;
  overrides?: Array<{ includes?: string[]; linter?: BiomeLinterFixture }>;
};

/** Mirrors the real config's shape: bare-string AND object-form severities. */
const BIOME_BASE: BiomeFixture = {
  files: { includes: ["**", "!**/node_modules", "!**/*.svelte"] },
  formatter: { enabled: false },
  linter: {
    enabled: true,
    rules: {
      recommended: true,
      suspicious: { noExplicitAny: "error", noThenProperty: "off" },
      style: {
        noNonNullAssertion: "off",
        noRestrictedImports: {
          level: "error",
          options: { paths: { express: "use Bun.serve()", vitest: "use bun:test" } },
        },
      },
    },
  },
  overrides: [
    {
      includes: ["**/*.test.ts", "**/__tests__/**"],
      linter: { rules: { suspicious: { noExplicitAny: "off" } } },
    },
  ],
};

/** Rule group (`suspicious`, `style`, …) of a fixture linter, for mutation. */
function fixtureGroup(
  linter: BiomeLinterFixture | undefined,
  name: string,
): Record<string, unknown> {
  const rules = (linter?.rules ?? {}) as Record<string, Record<string, unknown>>;
  return rules[name] as Record<string, unknown>;
}

/** Apply `mutate` to a fresh copy of BIOME_BASE and diff it against the base. */
function biomeDiff(mutate: (head: BiomeFixture) => void): string[] {
  const head = structuredClone(BIOME_BASE);
  mutate(head);
  return biomeGateWeakenings(JSON.stringify(BIOME_BASE), JSON.stringify(head));
}

describe("gate-integrity: biome.json — shapes that MUST fire", () => {
  test("shape 1: a new `!<path>` in files.includes un-lints for every rule", () => {
    const v = biomeDiff((head) => {
      head.files?.includes?.push("!src/providers/router.ts");
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("files.includes gained the exclusion");
    expect(v[0]).toContain("!src/providers/router.ts");
  });

  test("shape 1b: NARROWING a positive include un-lints without any `!`", () => {
    // Swapping "**" for "src/**" drops web/ out of linting entirely, and no
    // exclusion token appears in the diff at all.
    const v = biomeDiff((head) => {
      head.files = { includes: ["src/**", "!**/node_modules", "!**/*.svelte"] };
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('files.includes lost "**"');
  });

  test("shape 2: a NEW override entry setting a rule to off", () => {
    const v = biomeDiff((head) => {
      head.overrides?.push({
        includes: ["src/providers/**"],
        linter: { rules: { suspicious: { noExplicitAny: "off" } } },
      });
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("DISARMED");
    expect(v[0]).toContain("suspicious/noExplicitAny");
    expect(v[0]).toContain("src/providers/**");
  });

  test("shape 2b: WIDENED — a new path added to an existing off-override", () => {
    const v = biomeDiff((head) => {
      head.overrides?.[0]?.includes?.push("src/db/**");
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("src/db/**");
  });

  test("shape 2c: WIDENED — a new rule turned off inside an existing override", () => {
    const v = biomeDiff((head) => {
      fixtureGroup(head.overrides?.[0]?.linter, "suspicious").noThenProperty = "off";
    });
    // One finding per path the override reaches, so the message names the
    // scope that lost the rule. Only the newly-off rule fires; the
    // pre-existing noExplicitAny does not.
    expect(v).toHaveLength(2);
    expect(v.every((m) => m.includes("suspicious/noThenProperty"))).toBe(true);
    expect(v.some((m) => m.includes("**/*.test.ts"))).toBe(true);
    expect(v.some((m) => m.includes("**/__tests__/**"))).toBe(true);
  });

  test("shape 2d: WIDENED — an override's `!` exemption removed", () => {
    // The path set grows with no new array element to notice in review.
    const widened = structuredClone(BIOME_BASE);
    widened.overrides?.[0]?.includes?.push("!web/e2e/**");
    const v = biomeGateWeakenings(JSON.stringify(widened), JSON.stringify(BIOME_BASE));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("exemption REMOVED");
    expect(v[0]).toContain("!web/e2e/**");
  });

  test("shape 2e: an override with NO includes disarms everywhere", () => {
    const v = biomeDiff((head) => {
      head.overrides?.push({ linter: { rules: { suspicious: { noExplicitAny: "off" } } } });
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("**");
  });

  test("shape 3: error → warn on a bare-string severity", () => {
    const v = biomeDiff((head) => {
      fixtureGroup(head.linter, "suspicious").noExplicitAny = "warn";
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('"error" → "warn"');
    expect(v[0]).toContain('only "error" blocks');
  });

  test("shape 3b: error → warn on the OBJECT severity form (the bypass)", () => {
    // `noRestrictedImports` on main is `{ "level": "error", "options": {…} }`.
    // A checker that only understood bare strings would wave this straight
    // through while the denylist stopped enforcing anything.
    const v = biomeDiff((head) => {
      const rule = fixtureGroup(head.linter, "style").noRestrictedImports as { level: string };
      rule.level = "warn";
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("style/noRestrictedImports");
    expect(v[0]).toContain('"error" → "warn"');
  });

  test("shape 3c: error → off, and error → the indeterminate `on`", () => {
    const off = biomeDiff((head) => {
      fixtureGroup(head.linter, "suspicious").noExplicitAny = "off";
    });
    expect(off).toHaveLength(1);
    expect(off[0]).toContain('"error" → "off"');
    // `"on"` means "the rule's own default", which may resolve below error —
    // ranked under error so the drop is caught fail-closed.
    const on = biomeDiff((head) => {
      fixtureGroup(head.linter, "suspicious").noExplicitAny = "on";
    });
    expect(on).toHaveLength(1);
    expect(on[0]).toContain('"error" → "on"');
  });

  test("shape 3d: a rule DELETED while it stood at error", () => {
    const v = biomeDiff((head) => {
      delete fixtureGroup(head.linter, "suspicious").noExplicitAny;
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('DELETED while at "error"');
    expect(v[0]).toContain("suspicious/noExplicitAny");
  });

  test("a rule's options.paths denylist losing an entry, still at error", () => {
    const v = biomeDiff((head) => {
      const rule = fixtureGroup(head.linter, "style").noRestrictedImports as {
        options: { paths: Record<string, string> };
      };
      delete rule.options.paths.express;
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('stopped denying "express"');
  });

  test("blanket disarms: linter.enabled false, recommended false, preset none", () => {
    const disabled = biomeDiff((head) => {
      if (head.linter) head.linter.enabled = false;
    });
    expect(disabled).toHaveLength(1);
    expect(disabled[0]).toContain("<all rules>");

    const unrecommended = biomeDiff((head) => {
      if (head.linter?.rules) head.linter.rules.recommended = false;
    });
    expect(unrecommended).toHaveLength(1);
    expect(unrecommended[0]).toContain("<all rules>");

    const presetNone = biomeDiff((head) => {
      if (head.linter?.rules) {
        delete head.linter.rules.recommended;
        head.linter.rules.preset = "none";
      }
    });
    expect(presetNone).toHaveLength(1);
    expect(presetNone[0]).toContain("<all rules>");
  });

  test("an override that disables the linter outright for a path set", () => {
    const v = biomeDiff((head) => {
      head.overrides?.push({ includes: ["src/db/**"], linter: { enabled: false } });
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("<all rules>");
    expect(v[0]).toContain("src/db/**");
  });

  test("a whole rule GROUP switched off in one line", () => {
    const v = biomeDiff((head) => {
      if (head.linter?.rules) head.linter.rules.suspicious = "off";
    });
    // The group-wide record fires; the two rules it replaced were deleted, and
    // noExplicitAny stood at error, so that deletion is reported too.
    expect(v.some((m) => m.includes("suspicious/*"))).toBe(true);
    expect(v.some((m) => m.includes('DELETED while at "error"'))).toBe(true);
  });

  test("an unparseable HEAD is itself a finding (biome discards it silently)", () => {
    const v = biomeGateWeakenings(JSON.stringify(BIOME_BASE), "{ not json");
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("not valid JSON in HEAD");
    // A non-object HEAD (valid JSON, useless config) is caught too.
    expect(biomeGateWeakenings(JSON.stringify(BIOME_BASE), "[]")).toEqual([
      "biome.json is not a JSON object in HEAD",
    ]);
  });
});

describe("gate-integrity: biome.json — shapes that must stay SILENT", () => {
  test("an unchanged config produces nothing", () => {
    expect(biomeDiff(() => {})).toEqual([]);
  });

  test("REMOVING a files.includes exclusion (the #143 prior art itself)", () => {
    const v = biomeDiff((head) => {
      head.files = { includes: ["**", "!**/node_modules"] };
    });
    expect(v).toEqual([]);
  });

  test("ADDING a positive include (widening what biome lints)", () => {
    const v = biomeDiff((head) => {
      head.files?.includes?.push("docs/**");
    });
    expect(v).toEqual([]);
  });

  test("RAISING a severity: off → error, warn → error, on → error", () => {
    expect(
      biomeDiff((head) => {
        fixtureGroup(head.linter, "style").noNonNullAssertion = "error";
      }),
    ).toEqual([]);
    const fromWarn = structuredClone(BIOME_BASE);
    fixtureGroup(fromWarn.linter, "suspicious").noExplicitAny = "warn";
    expect(biomeGateWeakenings(JSON.stringify(fromWarn), JSON.stringify(BIOME_BASE))).toEqual([]);
    const fromOn = structuredClone(BIOME_BASE);
    fixtureGroup(fromOn.linter, "suspicious").noExplicitAny = "on";
    expect(biomeGateWeakenings(JSON.stringify(fromOn), JSON.stringify(BIOME_BASE))).toEqual([]);
  });

  test("SHRINKING a disarming override — issue #142's exact edit", () => {
    // #142 removes paths from the noExplicitAny opt-out override. That is a
    // strengthening: fewer files stop being linted. It must pass cleanly, both
    // when paths are trimmed and when the whole override is retired.
    const shrunk = biomeDiff((head) => {
      const first = head.overrides?.[0];
      if (first) first.includes = ["**/*.test.ts"];
    });
    expect(shrunk).toEqual([]);
    expect(
      biomeDiff((head) => {
        head.overrides = [];
      }),
    ).toEqual([]);
  });

  test("a NEW override that sets a rule to error", () => {
    const v = biomeDiff((head) => {
      head.overrides?.push({
        includes: ["src/db/**"],
        linter: { rules: { suspicious: { noThenProperty: "error" } } },
      });
    });
    expect(v).toEqual([]);
  });

  test("a NEW `!` exemption inside an override (narrowing its reach)", () => {
    const v = biomeDiff((head) => {
      head.overrides?.[0]?.includes?.push("!web/e2e/**");
    });
    expect(v).toEqual([]);
  });

  test("dropping an override that only RESTATED the root at error", () => {
    // Falls back to the root pin, which still says error — a cleanup, not a
    // hole. Flagging it would make redundancy permanent.
    const withRestatement = structuredClone(BIOME_BASE);
    withRestatement.overrides?.push({
      includes: ["web/**"],
      linter: {
        rules: {
          style: { noRestrictedImports: { level: "error", options: { paths: { express: "x" } } } },
        },
      },
    });
    expect(
      biomeGateWeakenings(JSON.stringify(withRestatement), JSON.stringify(BIOME_BASE)),
    ).toEqual([]);
  });

  test("deleting a rule that stood BELOW error (it can only re-arm)", () => {
    const v = biomeDiff((head) => {
      delete fixtureGroup(head.linter, "style").noNonNullAssertion;
    });
    expect(v).toEqual([]);
  });

  test("ADDING a denied path to options.paths", () => {
    const v = biomeDiff((head) => {
      const rule = fixtureGroup(head.linter, "style").noRestrictedImports as {
        options: { paths: Record<string, string> };
      };
      rule.options.paths.ioredis = "use Bun.redis";
    });
    expect(v).toEqual([]);
  });

  test('`recommended: true` dropped, or migrated to `preset: "recommended"`', () => {
    // `true` is biome's default, and 2.5 deprecates the key in favour of
    // `preset`. Neither edit changes what is enforced.
    expect(
      biomeDiff((head) => {
        if (head.linter?.rules) delete head.linter.rules.recommended;
      }),
    ).toEqual([]);
    expect(
      biomeDiff((head) => {
        if (head.linter?.rules) {
          delete head.linter.rules.recommended;
          head.linter.rules.preset = "recommended";
        }
      }),
    ).toEqual([]);
  });

  test("an unrelated edit outside the linter", () => {
    const v = biomeDiff((head) => {
      head.formatter = { enabled: true };
    });
    expect(v).toEqual([]);
  });

  test("an unreadable BASE yields no findings (nothing to compare against)", () => {
    expect(biomeGateWeakenings("{ not json", JSON.stringify(BIOME_BASE))).toEqual([]);
    expect(biomeGateWeakenings("null", JSON.stringify(BIOME_BASE))).toEqual([]);
  });
});

describe("gate-integrity: biome.json — against the REAL config", () => {
  const readReal = async (): Promise<string> =>
    await Bun.file(join(import.meta.dir, "..", "..", "biome.json")).text();

  test("the committed biome.json does not flag itself", async () => {
    const real = await readReal();
    expect(real.length).toBeGreaterThan(0);
    expect(biomeGateWeakenings(real, real)).toEqual([]);
  });

  test("re-adding the 8 exclusions PR #144 deleted is flagged, one per path", async () => {
    // The prior art from issue #143: these accumulated with no reason comments
    // and were hiding 25 `any` plus 4 real diagnostics. Nothing flagged them
    // going in. Re-adding them now must cost a maintainer label.
    const PRIOR_ART = [
      "!src/api-registry.ts",
      "!src/extensions/bundled.ts",
      "!src/providers/registry.ts",
      "!src/providers/router.ts",
      "!src/providers/model-discovery.ts",
      "!web/src/lib/api.ts",
      "!web/src/routes/api/models",
      "!web/src/routes/api/providers/\\[provider\\]/refresh-models",
    ];
    const real = await readReal();
    const head = JSON.parse(real) as BiomeFixture;
    head.files?.includes?.push(...PRIOR_ART);
    const v = biomeGateWeakenings(real, JSON.stringify(head));
    expect(v).toHaveLength(PRIOR_ART.length);
    for (const path of PRIOR_ART) {
      expect(v.some((m) => m.includes(`"${path}"`))).toBe(true);
    }
  });

  test("shrinking the real noExplicitAny opt-out list is silent (#142)", async () => {
    const real = await readReal();
    const head = JSON.parse(real) as BiomeFixture;
    // Find the opt-out by the RULE it disarms, not by a path inside it. This
    // named `src/db/seed-marketplace.ts` until #142 closed the last row and
    // deleted that entry outright — so a hardcoded path makes the test die of
    // the cleanup it is meant to bless, rather than of the behaviour it pins.
    // Whichever override turns noExplicitAny off, shrinking its `includes` is
    // a strengthening ("must only ever shrink", per dependency-denylist.test.ts)
    // and must stay silent.
    const target = (head.overrides ?? []).find(
      (o) => fixtureGroup(o.linter, "suspicious")?.noExplicitAny === "off",
    );
    expect(target).toBeDefined();
    const kept = (target?.includes ?? []).slice(0, 2);
    expect(kept.length).toBeGreaterThan(0);
    target!.includes = kept;
    expect(biomeGateWeakenings(real, JSON.stringify(head))).toEqual([]);
  });

  test("flipping the real noRestrictedImports to warn is caught", async () => {
    const real = await readReal();
    const head = JSON.parse(real) as BiomeFixture;
    const style = fixtureGroup(head.linter, "style");
    (style.noRestrictedImports as { level: string }).level = "warn";
    const v = biomeGateWeakenings(real, JSON.stringify(head));
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("style/noRestrictedImports");
  });
});

describe("gate-integrity: biome CONFIG FILE moves (check 10)", () => {
  test("the root biome.json deleted or renamed away", () => {
    expect(biomeConfigFileViolations("D\tbiome.json")[0]).toContain("biome.json DELETED");
    const renamed = biomeConfigFileViolations("R100\tbiome.json\tbiome.old.json");
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toContain("RENAMED to biome.old.json");
  });

  test("a NESTED biome config added anywhere else", () => {
    const v = biomeConfigFileViolations(["A\tweb/biome.json", "A\tsrc/db/biome.jsonc"].join("\n"));
    expect(v).toHaveLength(2);
    expect(v[0]).toContain("web/biome.json");
    expect(v[1]).toContain("src/db/biome.jsonc");
    // A nested config arriving by RENAME is the same hole.
    const moved = biomeConfigFileViolations("R090\tconfig/lint.json\tworker/biome.json");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toContain("worker/biome.json");
  });

  test("a C-quoted path is still recognised", () => {
    const v = biomeConfigFileViolations('A\t"packages/@ezcorp/sd\\303\\244k/biome.json"');
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("nested biome config ADDED");
  });

  test("routine changes are silent", () => {
    const quiet = [
      "M\tbiome.json", // editing it is check 9's job, not a file-move
      "A\tbiome.json", // bootstrap: creating the root config
      "D\tweb/biome.json", // REMOVING a nested config re-arms the subtree
      "A\tsrc/runtime/biome-helpers.ts", // not a config, despite the name
      "R100\tsrc/a.ts\tsrc/b.ts",
      "", // blank lines and short/garbage rows are skipped
      "X",
    ].join("\n");
    expect(biomeConfigFileViolations(quiet)).toEqual([]);
  });
});

// ── check-boundaries ────────────────────────────────────────────────────────

describe("check-boundaries: resolveSpecifier", () => {
  test("relative specifiers resolve against the IMPORTING FILE's directory", () => {
    // The whole reason this is a resolver and not a glob: the same textual
    // specifier means different things depending on where it is written.
    expect(resolveSpecifier("web/src/lib/x.ts", "../../../src/types")).toBe("src/types");
    expect(resolveSpecifier("worker/src/index.ts", "../../src/runtime/events")).toBe(
      "src/runtime/events",
    );
    expect(resolveSpecifier("packages/@ezcorp/ai-kit/test/unit/a.test.ts", "../../src/client")).toBe(
      "packages/@ezcorp/ai-kit/src/client",
    );
  });

  test("SvelteKit aliases resolve to their real trees", () => {
    expect(resolveSpecifier("web/src/lib/x.ts", "$server/auth/types")).toBe("src/auth/types");
    expect(resolveSpecifier("web/src/routes/+page.svelte", "$lib/api")).toBe("web/src/lib/api");
  });

  test("non-first-party specifiers are not our business", () => {
    for (const spec of ["bun:test", "node:path", "@ezcorp/sdk", "zod", "@sveltejs/kit"]) {
      expect(resolveSpecifier("src/a.ts", spec)).toBeNull();
    }
    // Escaping the repo entirely resolves to null rather than a bogus path.
    expect(resolveSpecifier("src/a.ts", "../../../../../etc/passwd")).toBeNull();
  });
});

describe("check-boundaries: the cases a glob CANNOT distinguish", () => {
  // Every specifier below contains the substring `src/`. A biome
  // `noRestrictedImports` pattern like `**/src/**` matches the raw specifier
  // and would flag all three; only the first is actually a violation. These
  // are the measured in-tree shapes that ruled out the lint-rule approach.
  test("package-local ../src/client is LEGAL (does not escape the package)", () => {
    expect(checkEdge("packages/@ezcorp/ai-kit/test/unit/client.test.ts", "../../src/client")).toBeNull();
    expect(checkEdge("packages/@ezcorp/sdk/test/loop.test.ts", "../src/runtime/loop")).toBeNull();
  });

  test("intra-web ../src/lib/api.js from web/e2e is LEGAL", () => {
    expect(checkEdge("web/e2e/fixtures/api-mocks.ts", "../../src/lib/fuzzy-match.js")).toBeNull();
    expect(checkEdge("web/e2e/provider-settings.spec.ts", "../src/lib/api.js")).toBeNull();
  });

  test("a package escaping to the app IS a violation, at any ../ depth", () => {
    const shallow = checkEdge("packages/@ezcorp/sdk/src/a.ts", "../../../../src/db/connection");
    expect(shallow?.rule).toBe("packages-no-app-imports");
    const deep = checkEdge(
      "packages/@ezcorp/ai-kit/src/mcp/tools/deep.ts",
      "../../../../../../src/extensions/manifest",
    );
    expect(deep?.rule).toBe("packages-no-app-imports");
  });
});

describe("check-boundaries: packages must not import the app", () => {
  test("production package code importing src/ or web/ is rejected", () => {
    const a = checkEdge("packages/@ezcorp/harness-client/src/index.ts", "../../../../src/api-registry");
    expect(a?.rule).toBe("packages-no-app-imports");
    expect(a?.why).toContain("would not resolve for a consumer");

    const b = checkEdge(
      "packages/@ezcorp/harness-client/src/index.ts",
      "../../../../web/src/lib/runtime-event-names",
    );
    expect(b?.rule).toBe("packages-no-app-imports");
  });

  test("the rule is PRODUCTION-only — package tests may assert parity against the app", () => {
    // Deliberate scope, not an allowlist: harness-client's suite imports the
    // app's canonical RUNTIME_EVENT_NAMES precisely to assert the package's
    // copy has not drifted, and ai-kit validates its manifest with the host's
    // authoritative validator. Forbidding those would force duplicating the
    // very constant the guard exists to compare against.
    expect(
      checkEdge(
        "packages/@ezcorp/harness-client/src/index.test.ts",
        "../../../../web/src/lib/runtime-event-names",
      ),
    ).toBeNull();
    expect(
      checkEdge(
        "packages/@ezcorp/ai-kit/test/integration/extension.test.ts",
        "../../../../../src/extensions/manifest",
      ),
    ).toBeNull();
    // …and the distinction is carried by isTestPath, not by a path list.
    expect(isTestPath("packages/@ezcorp/harness-client/src/index.test.ts")).toBe(true);
    expect(isTestPath("packages/@ezcorp/harness-client/src/index.ts")).toBe(false);
  });
});

describe("check-boundaries: the worker runtime allowlist", () => {
  test("the legal surface passes — exactly what worker/src/index.ts imports today", () => {
    for (const spec of [
      "../../src/types",
      "../../src/runtime/events",
      "../../src/runtime/executor",
      "../../src/runtime/loader",
    ]) {
      expect(checkEdge("worker/src/index.ts", spec), `${spec} must be legal`).toBeNull();
    }
  });

  test("every node-only subsystem is named in the diagnostic, not just refused", () => {
    for (const sub of WORKER_FORBIDDEN_SUBSYSTEMS) {
      const v = checkEdge("worker/src/index.ts", `../../src/${sub}/anything`);
      expect(v?.rule, `src/${sub} must be forbidden`).toBe("worker-no-node-only-subsystems");
      expect(v?.why).toContain(`src/${sub}/**`);
      expect(v?.why).toContain("Workers");
    }
  });

  test("ALLOWLIST shape: a new src/ import outside the surface fails by default", () => {
    // The point of an allowlist over a denylist — a subsystem nobody has
    // thought of yet is refused without anyone editing this file.
    const v = checkEdge("worker/src/index.ts", "../../src/brand-new-subsystem/thing");
    expect(v?.rule).toBe("worker-runtime-allowlist");
    expect(v?.why).toContain("src/runtime/");
  });

  test("the allowlist constants are the ones the rule actually enforces", () => {
    // Guards against the constants drifting into decoration.
    expect(WORKER_ALLOWED_PREFIXES).toContain("src/runtime/");
    expect(WORKER_ALLOWED_EXACT).toContain("src/types");
    expect(checkEdge("worker/src/index.ts", "../../src/types.ts")).toBeNull();
  });

  test("worker importing its own files, or a bare package, is untouched", () => {
    expect(checkEdge("worker/src/index.ts", "./helper")).toBeNull();
    expect(checkEdge("worker/src/index.ts", "@ezcorp/sdk")).toBeNull();
  });
});

describe("check-boundaries: source scanning", () => {
  test("extractSpecifiers finds every import form the repo uses", () => {
    const src = [
      `import a from "./a";`,
      `import { b } from '../b';`,
      `export { c } from "./c";`,
      `const d = await import("./d");`,
      `const e = require("./e");`,
      `import type { F } from "$server/f";`,
    ].join("\n");
    expect(extractSpecifiers(src)).toEqual(["./a", "../b", "./c", "./d", "./e", "$server/f"]);
  });

  test("checkSource reports every violating edge in a file", () => {
    const src = [
      `import { a } from "../../src/db/connection";`,
      `import { b } from "../../src/runtime/events";`, // legal
      `import { c } from "../../src/auth/middleware";`,
    ].join("\n");
    const vs = checkSource("worker/src/index.ts", src);
    expect(vs.map((v) => v.target)).toEqual(["src/db/connection", "src/auth/middleware"]);
  });

  test("THE REPO ITSELF PASSES — the gate is green on the real tree", async () => {
    // Not a smoke test: this is the assertion that the three shipped rules are
    // genuinely at zero, so the gate needs no baseline file. If someone adds a
    // violating import, this fails here before CI.
    const proc = Bun.spawnSync(["git", "ls-files"], {
      cwd: join(import.meta.dir, "..", ".."),
      stdout: "pipe",
    });
    const files = proc.stdout
      .toString()
      .split("\n")
      .filter((f) => /\.(?:ts|tsx|js|mjs|cjs|svelte)$/.test(f));
    expect(files.length).toBeGreaterThan(100); // not vacuous
    const violations = [];
    for (const f of files) {
      const text = await Bun.file(join(import.meta.dir, "..", "..", f)).text().catch(() => "");
      if (text) violations.push(...checkSource(f, text));
    }
    expect(
      violations.map((v) => `${v.from} -> ${v.spec} [${v.rule}]`),
      "the shipped rules must stay at zero — this gate has no baseline by design",
    ).toEqual([]);
  }, 120_000);
});
