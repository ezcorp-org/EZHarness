/**
 * Meta-test that enforces the `mock.module` leak-prevention invariant:
 * every target path passed to `mock.module(...)` anywhere under
 * `src/__tests__/` MUST be snapshotted by
 * `./helpers/mock-cleanup.ts`, otherwise `restoreModuleMocks()` in a
 * polluter's `afterAll` is a silent no-op and the mock bleeds into
 * subsequent test files.
 *
 * The Phase 1 scratchpad work shipped with exactly this bug —
 * `mock.module("../db/queries/audit-log", ...)` was not in
 * MODULE_PATHS so the restoration skipped it. This test would have
 * caught it at CI time. See commits 545cb1d (Phase 1) and 7a9a696
 * (fix) for the history.
 */

import { describe, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Allow-list: paths that appear in `mock.module(...)` calls but are
// intentionally NOT cached (e.g. SvelteKit `./$types` stubs which have
// no real module to snapshot, or one-off external packages that are
// only mocked in a single file and cause no cross-file leak).
const EXEMPT_PATTERNS: RegExp[] = [
  /\$types$/,          // SvelteKit route-type stubs
  /^@sveltejs\/kit$/,  // mocked in preload.ts itself
  /^svelte\/store$/,
  /^@huggingface\/transformers$/,
  /^node:/,            // node builtins
  /^\.\/schema$/,      // test-local schema fixtures
  /\$\{/,              // template-literal matches from this meta-test's own error message
  /^\$lib\/foo$/,       // JSDoc example inside this meta-test
  /^\.\.\/extensions\/sdk\/test-runner$/,  // one-off, only used by ext-publish.test.ts
  /routes\/api\/extensions\/schema$/,       // request-schema file; only mocked in one security test
];

// Paths the cleanup helper snapshots. Keep in sync with MODULE_PATHS +
// the server-prefix translations in `./helpers/mock-cleanup.ts`. We
// compare against canonical forms (both `../` and `../../` collapse
// to the absolute path relative to `src/`).
import { readFileSync as rfs } from "node:fs";

function loadModulePaths(): Set<string> {
  const src = rfs(join(import.meta.dir, "helpers", "mock-cleanup.ts"), "utf8");
  const paths = new Set<string>();
  const arrayMatch = src.match(/const MODULE_PATHS = \[([\s\S]*?)\];/);
  if (arrayMatch) {
    for (const m of arrayMatch[1]!.matchAll(/"([^"]+)"/g)) paths.add(m[1]!);
  }
  return paths;
}

// `$server/<top>/<…>` paths that match a known top-level `$server/*`
// namespace are considered covered: every test file that wants one of
// these aliases calls `mockServerAlias()` (or a sibling helper) at
// module load, so leaks from prior files don't bleed in through the
// `$server/*` surface. The tighter allowlist that
// `restoreModuleMocks()` re-registers is `SERVER_ALIAS_SUFFIXES` in
// `helpers/mock-cleanup.ts`; for coverage we only need to ensure the
// top-level namespace is one Bun actually serves under `$server/*`.
const SERVER_ALIAS_TOP_LEVELS = new Set([
  "db",
  "auth",
  "extensions",
  "providers",
  "memory",
  "chat",
  "lib",
  "mcp",
  "routes",
  "runtime",
  "observability",
]);

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    // Skip the cleanup helper itself and this meta-test.
    if (entry === "helpers" || entry === "preload.ts") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTestFiles(full));
    else if (/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function extractMockPaths(source: string): string[] {
  const matches = source.matchAll(/mock\.module\(\s*"([^"]+)"/g);
  return Array.from(matches, (m) => m[1]!);
}

/**
 * Canonicalize a mock target path to the form MODULE_PATHS uses.
 * - `../foo` (from `src/__tests__/*.test.ts`) → `../../foo` (from helpers/)
 * - `../../src/foo` (from web/test hops) → `../../foo`
 * - `$server/foo/bar` → return "$server" — handled by prefix check
 * - External package (e.g. @mariozechner/pi-ai) → unchanged
 */
function canonicalize(p: string, testFile: string): string {
  if (p.startsWith("$server/")) return p;
  if (p.startsWith("@") || p.startsWith("node:") || !p.includes("/")) return p;

  // Test files live at varying depths. Normalize by joining with the
  // test-file's dir, then re-relativizing against `src/`. This maps
  // both `../foo` and `../../foo` to `../../foo` as seen from helpers/.
  const srcRoot = join(import.meta.dir, "..");
  const testDir = join(testFile, "..");
  const abs = join(testDir, p);
  const relFromSrc = relative(srcRoot, abs);
  return relFromSrc.startsWith("..")
    ? p                         // escapes src/ entirely — treat as opaque
    : `../../${relFromSrc}`;
}

function isExempt(path: string): boolean {
  return EXEMPT_PATTERNS.some((re) => re.test(path));
}

function isServerPrefixed(path: string, topLevels: Set<string>): boolean {
  if (!path.startsWith("$server/")) return false;
  const tail = path.slice("$server/".length);
  const top = tail.split("/")[0];
  return top !== undefined && topLevels.has(top);
}

/**
 * `$lib/foo` is covered when `../../../web/src/lib/foo` is in MODULE_PATHS
 * (the restore helper walks MODULE_PATHS and writes `mock.module("$lib/foo")`
 * using the snapshotted exports). Treat a `$lib/...` mock as covered iff
 * its web-path form is in MODULE_PATHS.
 */
// Strip a trailing `.js` / `.ts` — Bun's module resolver treats
// `$lib/api.js` and `$lib/api` as the same module, and we only snapshot
// one form.
function stripJsTsExt(p: string): string {
  return p.replace(/\.(js|ts)$/, "");
}

function isLibAliasCovered(path: string, modulePaths: Set<string>): boolean {
  if (!path.startsWith("$lib/")) return false;
  const rel = stripJsTsExt(path.slice("$lib/".length));
  return modulePaths.has(`../../../web/src/lib/${rel}`);
}

/**
 * `../../../web/src/lib/foo` and `../../web/src/lib/foo` are the two
 * relative forms tests use to reach the web-lib tree directly (no alias).
 * Both collapse to the same absolute path; normalize and check against
 * the web-rooted entries in MODULE_PATHS.
 */
function isWebLibRelativeCovered(path: string, modulePaths: Set<string>): boolean {
  const m = path.match(/^(\.\.\/)+web\/src\/lib\/(.+)$/);
  if (!m) return false;
  return modulePaths.has(`../../../web/src/lib/${stripJsTsExt(m[2]!)}`);
}

describe("mock-cleanup coverage (meta-test)", () => {
  test("every mock.module target is either snapshotted or exempt", () => {
    const modulePaths = loadModulePaths();
    const testFiles = listTestFiles(import.meta.dir);

    const missing: Array<{ file: string; path: string }> = [];

    for (const file of testFiles) {
      const src = readFileSync(file, "utf8");
      for (const raw of extractMockPaths(src)) {
        if (isExempt(raw)) continue;
        if (modulePaths.has(raw)) continue;
        if (isServerPrefixed(raw, SERVER_ALIAS_TOP_LEVELS)) continue;
        if (isLibAliasCovered(raw, modulePaths)) continue;
        if (isWebLibRelativeCovered(raw, modulePaths)) continue;
        const canonical = canonicalize(raw, file);
        if (modulePaths.has(canonical)) continue;
        // Report the uncovered path — the test file that mocks it is
        // a potential polluter of subsequent test files.
        missing.push({ file: relative(join(import.meta.dir, "..", ".."), file), path: raw });
      }
    }

    if (missing.length > 0) {
      const lines = missing.map((m) => `  ${m.file}: mock.module("${m.path}")`);
      throw new Error(
        `mock.module targets missing from MODULE_PATHS (or a known $server/* top level) in ` +
          `src/__tests__/helpers/mock-cleanup.ts. Without a snapshot, restoreModuleMocks() ` +
          `cannot undo the mock and it will leak into subsequent test files. Add the ` +
          `canonical form of each path to the allowlist:\n${lines.join("\n")}`,
      );
    }
  });
});
