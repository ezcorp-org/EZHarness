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

import { describe, test, expect } from "bun:test";
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
  // c3-extension-install.test.ts stubs activate-extension (both alias
  // forms). The real module cannot be snapshotted: it imports
  // `$server/extensions/security` etc., which only resolve under that
  // file's own mocks, and adding it to MODULE_PATHS would eagerly
  // import the activation pipeline at preload (see the phase-2b-e2e
  // hang note in helpers/mock-cleanup.ts). Known residual leak —
  // benign today because no later test imports the real module.
  /^\$lib\/server\/extensions\/activate-extension$/,
  /web\/src\/lib\/server\/extensions\/activate-extension$/,
  // background-timers.test.ts stubs the preview daemons inert. The
  // stubs cannot be snapshotted: BOTH an eager preload import (via
  // MODULE_PATHS) and an in-file `await import(...)` of the real
  // preview graph flip phase-2b-e2e.test.ts's `$server/*`
  // registrations into a busy-hang (verified empirically 2026-06-10;
  // see the phase-2b-e2e note in helpers/mock-cleanup.ts). Known
  // residual leak — benign at the current suite order: the baseline
  // full-suite run has zero preview-test failures. Revisit if
  // preview-*.test.ts start failing in full-directory runs only.
  /^\.\.\/runtime\/preview\/preview-(port-watcher|port-source|consent|netns|uid-pool|detection-bridge|bus-registry)$/,
  // assert-bundled-not-stranded.test.ts stubs the bundled-extension
  // registry. It cannot be snapshotted: the eager preload import pulled
  // in the whole bundled-extension graph per spawn, so it was trimmed
  // from MODULE_PATHS in wave 3 (see the note in
  // helpers/mock-cleanup.ts). Known residual leak — inert under
  // scripts/test.sh's one-process-per-file pool, because that suite
  // mocks the path at module top level and never imports the real
  // module. Until issue #138 this entry was unnecessary only because
  // loadModulePaths() scraped the path back out of that helper's
  // COMMENT; the exemption now carries the justification explicitly.
  /^\.\.\/extensions\/bundled$/,
];

// Paths the cleanup helper snapshots. Keep in sync with MODULE_PATHS +
// the server-prefix translations in `./helpers/mock-cleanup.ts`. We
// compare against canonical forms (both `../` and `../../` collapse
// to the absolute path relative to `src/`).
import { readFileSync as rfs } from "node:fs";

/**
 * Drop `//` line comments and `*` continuation lines from a source
 * fragment before any quoted-string scrape.
 *
 * BOTH scrapers below depend on this, for the same reason and in both
 * directions: a path merely NAMED in prose must never be mistaken for a
 * real occurrence. On the mock side, preview-netns.test.ts's "we
 * deliberately do NOT mock.module(\"…\")" note must not count as a mock
 * target. On the MODULE_PATHS side, mock-cleanup.ts documents the paths
 * it deliberately does NOT snapshot (the wave-3 trims) by quoting them —
 * and a comment mention used to satisfy this meta-test for a mock that
 * `restoreModuleMocks()` cannot actually undo (issue #138).
 *
 * Keep this as the single shared filter: when only `extractMockPaths()`
 * had it, the two sides drifted and the gate silently passed.
 */
function stripCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");
}

/**
 * Scrape the quoted paths out of a `const MODULE_PATHS = [...]` literal.
 * Split from `loadModulePaths()` so the comment-stripping behaviour can
 * be asserted against synthetic sources without touching disk.
 */
function parseModulePaths(source: string): Set<string> {
  const paths = new Set<string>();
  const arrayMatch = source.match(/const MODULE_PATHS = \[([\s\S]*?)\];/);
  if (arrayMatch) {
    for (const m of stripCommentLines(arrayMatch[1]!).matchAll(/"([^"]+)"/g)) paths.add(m[1]!);
  }
  return paths;
}

function helperSource(): string {
  return rfs(join(import.meta.dir, "helpers", "mock-cleanup.ts"), "utf8");
}

function loadModulePaths(): Set<string> {
  return parseModulePaths(helperSource());
}

/** Quoted strings inside a named array/Set literal in the helper. */
function parseHelperList(source: string, pattern: RegExp): string[] {
  const body = source.match(pattern);
  if (!body) return [];
  return Array.from(stripCommentLines(body[1]!).matchAll(/"([^"]+)"/g), (m) => m[1]!);
}

const SKIP_RESTORE_LITERAL = /const SKIP_SERVER_ALIAS_RESTORE = new Set<string>\(\[([\s\S]*?)\]\)/;

/**
 * The `$server/*` aliases `restoreModuleMocks()` ACTUALLY re-registers,
 * derived from the helper rather than restated here.
 *
 * The restore loop walks MODULE_PATHS and, for each `../../<rel>`, registers
 * `$server/<rel>` — but only when `<rel>` starts with a `SERVER_ALIAS_PREFIXES`
 * entry and is not in `SKIP_SERVER_ALIAS_RESTORE`. Reading both lists out of
 * the helper is the point: this file used to keep its own copy of the namespace
 * list, and the copy had already DRIFTED (it carried `logger`, which is not a
 * served prefix, so a `$server/logger` mock was passing on a snapshot the
 * restore loop never uses). A gate that restates the mechanism it checks can
 * disagree with it silently — the exact failure mode the `$server` tail check
 * was introduced to close.
 */
function loadServedServerAliases(source: string): Set<string> {
  const prefixes = parseHelperList(source, /const SERVER_ALIAS_PREFIXES = \[([\s\S]*?)\];/);
  const skipped = new Set(parseHelperList(source, SKIP_RESTORE_LITERAL));
  const served = new Set<string>();
  for (const p of parseModulePaths(source)) {
    if (!p.startsWith("../../")) continue;
    const rel = p.slice("../../".length);
    if (prefixes.some((prefix) => rel.startsWith(prefix)) && !skipped.has(rel)) {
      served.add(`$server/${rel}`);
    }
  }
  return served;
}

/**
 * Aliases the helper DELIBERATELY does not restore — the documented-exception
 * surface. Each entry carries its reason beside it in the helper's
 * `SKIP_SERVER_ALIAS_RESTORE` docblock (today: `db/connection`, whose lazy
 * re-registration hangs `phase-2b-e2e.test.ts` at process exit). Reading it
 * here means an exception is honoured only while it is still written down.
 */
function loadSkippedServerAliases(source: string): Set<string> {
  return new Set(parseHelperList(source, SKIP_RESTORE_LITERAL).map((rel) => `$server/${rel}`));
}

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
  const matches = stripCommentLines(source).matchAll(/mock\.module\(\s*"([^"]+)"/g);
  return Array.from(matches, (m) => m[1]!);
}

/**
 * Canonicalize a mock target path to the form MODULE_PATHS uses.
 * - `../foo` (from `src/__tests__/*.test.ts`) → `../../foo` (from helpers/)
 * - `../../src/foo` (from web/test hops) → `../../foo`
 * - `$server/foo/bar` → return "$server" — handled by prefix check
 * - External package (e.g. @earendil-works/pi-ai) → unchanged
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

/**
 * ── `$server/*` PASS-THROUGH ALIAS SHIMS ─────────────────────────────────
 *
 * A shim is a registration whose factory returns the module the alias NAMES:
 *
 *     mock.module("$server/a/b", () => require("<path resolving to src/a/b>"))
 *     const real = require("<…src/a/b>");  mock.module("$server/a/b", () => real)
 *
 * It replaces nothing. Bun has no `$server/*` resolver outside SvelteKit's vite
 * build, so a suite that mounts a route handler has to give the alias a body,
 * and handing it the REAL module is the minimum that makes the import resolve.
 * There is no stub to leak, and the lazy `require()` form re-dispatches at every
 * resolution — so a later file's own `mock.module("../../a/b", …)` still wins
 * through the alias. That is the same mechanism `restoreModuleMocks()` installs
 * (see the "lazy factory is critical" note in `helpers/mock-cleanup.ts`):
 * restoring a shim would write back the byte-identical registration.
 *
 * So a shim is COVERED, with no snapshot and regardless of whether the restore
 * loop serves its namespace. That reasoning used to sit in prose beside the
 * `logger` entry of a hand-maintained namespace list; it is checked here
 * instead, per call site.
 *
 * TWO PROPERTIES MAKE THIS A CHECK AND NOT AN EXCUSE, and both matter:
 *
 *  1. The factory must return a whole module — an inline `require()` or a
 *     resolvable module binding. An object literal or a spread-with-overrides
 *     REPLACES exports and is not a shim.
 *  2. That module must be the one the alias NAMES. Otherwise
 *     `mock.module("$server/auth/extension-rbac", () =>
 *     require("../auth/middleware"))` would pass as a shim while substituting a
 *     different module — a redirect, which is exactly the silent-ALLOW class
 *     this file exists to prevent.
 *
 * Applied to the 16-entry `SERVER_ALIAS_BACKLOG` this replaced, 12 were shims.
 * It still REJECTS the offender that motivated the tail check:
 * `mock.module("$server/auth/extension-wire-authz", …)` was an allow-biased
 * object literal, not a shim.
 */

/**
 * Whole-module bindings a test file introduces, name → specifier.
 *
 * Both forms count, because both are in use: `const realLogger =
 * require("../logger")` (briefing-api, hub-api, hub-render-pull) and
 * `import * as realLogger from "../logger"` (extension-events-hub-branch,
 * which documents the top-level import as the ORDER-SAFE choice for a module
 * nothing mocks). A factory returning one of these bindings is a shim just as
 * much as an inline `require()` — resolve the binding rather than pushing four
 * files onto one spelling.
 *
 * A name rebound to a DIFFERENT specifier is dropped: fail closed rather than
 * guess which binding a factory closed over.
 */
function collectModuleBindings(source: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const re =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*"([^"]+)"\s*\)|import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)"/g;
  for (const m of stripCommentLines(source).matchAll(re)) {
    const name = m[1] ?? m[3]!;
    const spec = m[2] ?? m[4]!;
    if (!bindings.has(name)) bindings.set(name, spec);
    else if (bindings.get(name) !== spec) bindings.set(name, "");
  }
  return bindings;
}

function classifyServerAliasFactories(
  source: string,
  testFile: string,
): Map<string, "shim" | "redirect"> {
  const stripped = stripCommentLines(source);
  const bindings = collectModuleBindings(stripped);
  const byAlias = new Map<string, "shim" | "redirect">();

  const record = (alias: string, specifier: string | undefined) => {
    const tail = stripJsTsExt(alias.slice("$server/".length));
    const verdict =
      specifier && canonicalize(specifier, testFile) === `../../${tail}` ? "shim" : "redirect";
    // Fail closed: one redirect for an alias condemns it even if another
    // registration in the same file is well-formed.
    if (verdict === "redirect" || !byAlias.has(alias)) byAlias.set(alias, verdict);
  };

  // `() => require("<specifier>")`
  const inline = /mock\.module\(\s*"(\$server\/[^"]+)"\s*,\s*\(\)\s*=>\s*require\(\s*"([^"]+)"\s*\)\s*,?\s*\)/g;
  for (const m of stripped.matchAll(inline)) record(m[1]!, m[2]!);

  // `() => <module binding>`
  const viaBinding = /mock\.module\(\s*"(\$server\/[^"]+)"\s*,\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/g;
  for (const m of stripped.matchAll(viaBinding)) record(m[1]!, bindings.get(m[2]!) || undefined);

  return byAlias;
}

/** Convenience view for the shim tests below. */
function extractServerAliasShims(source: string, testFile: string): Set<string> {
  const out = new Set<string>();
  for (const [alias, kind] of classifyServerAliasFactories(source, testFile)) {
    if (kind === "shim") out.add(alias);
  }
  return out;
}

/**
 * Is a `$server/<tail>` mock covered? Three rules, in order:
 *
 *  1. NEVER, if the registration is a REDIRECT. `restoreModuleMocks()` only
 *     ever re-registers `$server/<rel>` → the module at `<rel>`, so it cannot
 *     undo an alias pointed at a DIFFERENT module. Fail closed even when the
 *     alias is served, or the snapshot waves the substitution through.
 *     (Measured when introduced: 78 `require()`-form `$server/*` registrations
 *     in the tree, 0 redirects.)
 *  2. YES, if it is a verified pass-through SHIM. Nothing was replaced, so
 *     there is nothing to restore — `served` is irrelevant here, which is why
 *     `$server/logger` is fine under a namespace the restore loop never
 *     touches.
 *  3. YES, if `restoreModuleMocks()` actually re-registers this alias
 *     (`served`), or if the helper explicitly and reasonedly declines to
 *     (`skipped`).
 *
 * Rule 3 is the one that was a hole in two directions. It accepted any
 * `$server/<known-top-level>/…` regardless of tail — which let an allow-biased
 * stub of the MCP wire gate (`$server/auth/extension-wire-authz`) pass while
 * its `afterAll` restore was a silent no-op — and then, once tightened to the
 * tail, it accepted a SNAPSHOT the restore loop does not use, because the
 * namespace list lived here instead of being read from the helper. `served` is
 * derived from the helper's own two lists, so the gate cannot drift from the
 * mechanism it is checking.
 */
function isServerPrefixed(
  path: string,
  served: Set<string>,
  skipped: Set<string>,
  aliasFactories: Map<string, "shim" | "redirect">,
): boolean {
  if (!path.startsWith("$server/")) return false;
  const alias = `$server/${stripJsTsExt(path.slice("$server/".length))}`;
  const factory = aliasFactories.get(path);
  if (factory === "redirect") return false;
  if (factory === "shim") return true;
  return served.has(alias) || skipped.has(alias);
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
    const helper = helperSource();
    const modulePaths = parseModulePaths(helper);
    const served = loadServedServerAliases(helper);
    const skipped = loadSkippedServerAliases(helper);
    // src/extensions/__tests__/ runs in the same bun-test process, so its
    // mock.module() calls leak the same way — the drafts-handler stub in
    // tool-executor.extensions-installed-emit.test.ts shipped exactly that
    // bug because this walker didn't cover the directory.
    const testFiles = [
      ...listTestFiles(import.meta.dir),
      ...listTestFiles(join(import.meta.dir, "..", "extensions", "__tests__")),
      // Web route __tests__ dirs run in the same per-file bun-test pool and
      // mock.module() the same shared modules. Scan the extension-control
      // route tests here (conversation-extensions-route.test.ts). NOT a
      // blanket walk of every web route dir — extend as those adopt the
      // restore convention.
      ...listTestFiles(
        join(import.meta.dir, "..", "..", "web", "src", "routes", "api", "extensions", "__tests__"),
      ),
    ];

    const missing: Array<{ file: string; path: string }> = [];

    for (const file of testFiles) {
      const src = readFileSync(file, "utf8");
      const paths = extractMockPaths(src);
      const aliasFactories = classifyServerAliasFactories(src, file);
      // In-file restore pattern: a file that mock.module()s the same
      // path twice snapshots the real exports before stubbing and
      // re-registers them in afterAll (used where the path cannot go
      // in MODULE_PATHS because an eager preload import of its module
      // graph hangs phase-2b-e2e — drafts-handler, author-install,
      // runtime/preview/*). Such paths are covered without a snapshot.
      const counts = new Map<string, number>();
      for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
      for (const raw of paths) {
        // The in-file restore rule counts registrations, which for a
        // `$server/*` alias proves only that the file wrote SOMETHING back —
        // not that it wrote back the module the alias NAMES. A restore aimed at
        // the wrong module reads exactly like a good one and leaves the alias
        // answering for a module nobody asked for. So `$server/*` targets skip
        // the count short-circuit and must satisfy `isServerPrefixed()` below.
        // Measured free when introduced: all nine `$server/*` in-file restores
        // in the tree resolve to a verified shim.
        if (!raw.startsWith("$server/") && (counts.get(raw) ?? 0) >= 2) continue;
        if (isExempt(raw)) continue;
        if (modulePaths.has(raw)) continue;
        if (isServerPrefixed(raw, served, skipped, aliasFactories)) continue;
        if (isLibAliasCovered(raw, modulePaths)) continue;
        if (isWebLibRelativeCovered(raw, modulePaths)) continue;
        const canonical = canonicalize(raw, file);
        if (modulePaths.has(canonical)) continue;
        // Report the uncovered path — the test file that mocks it is
        // a potential polluter of subsequent test files.
        missing.push({ file: relative(join(import.meta.dir, "..", ".."), file), path: raw });
      }
    }

    // Surface the remediation before asserting — the expect() diff below
    // names each offender, but this block explains what to DO about them.
    if (missing.length > 0) {
      const lines = missing.map((m) => `  ${m.file}: mock.module("${m.path}")`);
      console.error(
        `mock.module targets missing from MODULE_PATHS (or a known $server/* top level) in ` +
          `src/__tests__/helpers/mock-cleanup.ts. Without a snapshot, restoreModuleMocks() ` +
          `cannot undo the mock and it will leak into subsequent test files. Add the ` +
          `canonical form of each path to the allowlist:\n${lines.join("\n")}`,
      );
    }
    expect(missing).toEqual([]);
  });

  // IDX-07 regression pin: several memory test files (e.g.
  // memory-embeddings-state.test.ts, save-memory-integration.test.ts,
  // memory-dedup.test.ts) mock.module() "../../memory/embeddings"; if a future
  // refactor drops that path from MODULE_PATHS, restoreModuleMocks() silently
  // stops re-registering it and the fake extractor leaks into subsequent test
  // files. The walker above already catches that, but this explicit assertion
  // names the path so the failure is unmistakable. (MODULE_PATHS is a private
  // const in the helper, so we read it from source like loadModulePaths() does.)
  test("IDX-07: '../../memory/embeddings' stays registered in MODULE_PATHS", () => {
    const modulePaths = loadModulePaths();
    expect(modulePaths.has("../../memory/embeddings")).toBe(true);
  });

  // Issue #138 regression pin. loadModulePaths() used to scrape EVERY quoted
  // string out of the MODULE_PATHS body, comments included, so a path that
  // mock-cleanup.ts explicitly documents as NOT snapshotted still counted as
  // covered — and the gate passed for a mock restoreModuleMocks() cannot undo.
  // A commented-out entry must not satisfy the gate.
  test("a commented-out MODULE_PATHS entry is not treated as snapshotted", () => {
    const source = [
      'const MODULE_PATHS = [',
      '  "../../real/snapshotted",',
      '  // "../../line-commented/trimmed" was trimmed — zero mockers.',
      '  /**',
      '   * "../../block-commented/trimmed" is only named in prose here.',
      '   */',
      '  "../../also/real",',
      '];',
    ].join("\n");

    const parsed = parseModulePaths(source);

    expect([...parsed].sort()).toEqual(["../../also/real", "../../real/snapshotted"]);
    expect(parsed.has("../../line-commented/trimmed")).toBe(false);
    expect(parsed.has("../../block-commented/trimmed")).toBe(false);
  });

  // The live consequence from the issue, pinned against the REAL helper.
  // `../../extensions/bundled` is deliberately TRIMMED from MODULE_PATHS
  // (its eager preload import pulls the whole bundled-extension graph per
  // spawn), so assert-bundled-not-stranded.test.ts's stub is held by an
  // explicit exemption — NOT by loadModulePaths() scraping the path back out
  // of the helper's own comment, which is what used to happen. Both halves
  // matter: re-snapshotting the path or dropping the exemption should each
  // be a deliberate decision, not a silent one.
  test("'../extensions/bundled' is held by an exemption, not a comment scrape", () => {
    expect(loadModulePaths().has("../../extensions/bundled")).toBe(false);
    expect(isExempt("../extensions/bundled")).toBe(true);
  });

  // ── Pass-through alias shims (replaces the 16-entry SERVER_ALIAS_BACKLOG) ──
  //
  // The backlog was a frozen list of strings, so it could go stale in both
  // directions: an entry stayed "excused" after its call site changed shape,
  // and clearing one was a manual edit nothing re-checked. These tests pin the
  // predicate that replaced it, per call site, on every run.
  //
  // `join(import.meta.dir, "x.test.ts")` stands in for a real file under
  // `src/__tests__/` — canonicalize() only reads the path, never the disk.
  const FAKE = join(import.meta.dir, "fixture.test.ts");
  // Keeps the fixtures' quotes out of a literal `mock.module("` form, so this
  // meta-test's own walker does not scrape them as real mock targets (the same
  // self-reference the `${` exemption covers).
  const Q = '"';

  /**
   * `isServerPrefixed` against the classified factories of one source.
   * `served` names the aliases `restoreModuleMocks()` would actually
   * re-register; `skipped` the ones the helper reasonedly declines to.
   */
  function covered(
    source: string,
    alias: string,
    served: string[] = [],
    skipped: string[] = [],
  ): boolean {
    return isServerPrefixed(
      alias,
      new Set(served),
      new Set(skipped),
      classifyServerAliasFactories(source, FAKE),
    );
  }

  test("a $server shim re-exporting the module the alias names is covered", () => {
    const src = `mock.module(${Q}$server/runtime/hub-pages${Q}, () => require(${Q}../runtime/hub-pages${Q}));`;

    expect([...extractServerAliasShims(src, FAKE)]).toEqual(["$server/runtime/hub-pages"]);
    // …and that is what makes it covered with NO MODULE_PATHS snapshot.
    expect(covered(src, "$server/runtime/hub-pages")).toBe(true);

    // The multi-line form the tool-permission / feature-scan suites use scrapes
    // identically — the regex spans newlines.
    const wrapped = `mock.module(${Q}$server/routes/tool-permission${Q}, () =>\n  require(${Q}../routes/tool-permission${Q}),\n);`;
    expect(covered(wrapped, "$server/routes/tool-permission")).toBe(true);
  });

  test("a $server alias REDIRECTED to another module is never covered", () => {
    // Reads like a shim, substitutes a different module — an RBAC alias answered
    // by the auth middleware. `restoreModuleMocks()` only re-registers
    // `$server/<tail>` → `<tail>`, so it cannot undo a redirect; the snapshot
    // must NOT excuse it. Fail closed even when the tail IS snapshotted.
    const src = `mock.module(${Q}$server/auth/extension-rbac${Q}, () => require(${Q}../auth/middleware${Q}));`;

    expect([...extractServerAliasShims(src, FAKE)]).toEqual([]);
    expect(covered(src, "$server/auth/extension-rbac")).toBe(false);
    expect(covered(src, "$server/auth/extension-rbac", ["$server/auth/extension-rbac"])).toBe(false);
  });

  test("a redirect in the same file condemns a well-formed sibling registration", () => {
    // Fail-closed tie-break: two registrations of one alias, one good and one
    // redirected, must not average out to "covered".
    const src = [
      `mock.module(${Q}$server/memory/chunking${Q}, () => require(${Q}../memory/chunking${Q}));`,
      `mock.module(${Q}$server/memory/chunking${Q}, () => require(${Q}../memory/embeddings${Q}));`,
    ].join("\n");

    expect(covered(src, "$server/memory/chunking")).toBe(false);
  });

  test("a $server STUB is not a shim — the wire-gate offender still fails", () => {
    // Verbatim shape of the mock that motivated the tail check: an allow-biased
    // object literal behind an `$server/*` alias.
    const stub = [
      `mock.module(${Q}$server/auth/extension-wire-authz${Q}, () => ({`,
      `  partitionWirableExtensions: () => ({ allowed: candidates }),`,
      `}));`,
    ].join("\n");

    expect([...extractServerAliasShims(stub, FAKE)]).toEqual([]);
    expect(covered(stub, "$server/auth/extension-wire-authz")).toBe(false);
    // An actually-restored alias is then the only way to cover it — which is
    // where the real helper puts it today.
    expect(
      covered(stub, "$server/auth/extension-wire-authz", ["$server/auth/extension-wire-authz"]),
    ).toBe(true);
  });

  test("a SNAPSHOT the restore loop never uses does not cover a stub", () => {
    // `restoreModuleMocks()` derives `$server/<rel>` only for a rel whose prefix
    // is in the helper's SERVER_ALIAS_PREFIXES. `logger` is not one, so
    // `../../logger` being in MODULE_PATHS says nothing about the alias — which
    // is why `served` is derived from the helper instead of restated here. A
    // stub behind such an alias is uncovered; a SHIM behind it is fine, because
    // a shim needs no restoration at all.
    const stub = `mock.module(${Q}$server/logger${Q}, () => ({ extensionLogger: () => ({}) }));`;
    const shim = `mock.module(${Q}$server/logger${Q}, () => require(${Q}../logger${Q}));`;

    expect(covered(stub, "$server/logger")).toBe(false);
    expect(covered(shim, "$server/logger")).toBe(true);
    // Pinned against the REAL helper: `logger` genuinely is not served.
    expect(loadServedServerAliases(helperSource()).has("$server/logger")).toBe(false);
  });

  test("a module BINDING is as good a shim as an inline require", () => {
    // Four suites use `const realLogger = require("../logger")` /
    // `import * as realLogger from "../logger"` and hand the binding to the
    // factory — extension-events-hub-branch documents the top-level import as
    // the ORDER-SAFE form. Resolve the binding rather than forcing those files
    // onto one spelling, and still catch a binding that names another module.
    const viaConst = [
      `const realLogger = require(${Q}../logger${Q});`,
      `mock.module(${Q}$server/logger${Q}, () => realLogger);`,
    ].join("\n");
    const viaImport = [
      `import * as realLogger from ${Q}../logger${Q};`,
      `mock.module(${Q}$server/logger${Q}, () => realLogger);`,
    ].join("\n");
    const wrongModule = [
      `const realLogger = require(${Q}../runtime/hub-pages${Q});`,
      `mock.module(${Q}$server/logger${Q}, () => realLogger);`,
    ].join("\n");
    const ambiguous = [
      `const realLogger = require(${Q}../logger${Q});`,
      `let realLogger = require(${Q}../runtime/hub-pages${Q});`,
      `mock.module(${Q}$server/logger${Q}, () => realLogger);`,
    ].join("\n");

    expect(covered(viaConst, "$server/logger")).toBe(true);
    expect(covered(viaImport, "$server/logger")).toBe(true);
    expect(covered(wrongModule, "$server/logger")).toBe(false);
    // Rebound to a different module — fail closed rather than guess.
    expect(covered(ambiguous, "$server/logger")).toBe(false);
  });

  test("a documented SKIP_SERVER_ALIAS_RESTORE entry is the only excuse left", () => {
    // The one alias the helper deliberately does not restore is
    // `$server/db/connection` (a lazy re-registration there hangs
    // phase-2b-e2e.test.ts at process exit — the reason is written beside the
    // entry). Four suites stub it. The gate honours that exception only while
    // the helper still declares it.
    const stub = `mock.module(${Q}$server/db/connection${Q}, () => ({ getDb: () => fakeDb }));`;

    expect(covered(stub, "$server/db/connection")).toBe(false);
    expect(covered(stub, "$server/db/connection", [], ["$server/db/connection"])).toBe(true);

    // Pinned against the REAL helper, both directions.
    const helper = helperSource();
    expect(loadSkippedServerAliases(helper).has("$server/db/connection")).toBe(true);
    expect(loadServedServerAliases(helper).has("$server/db/connection")).toBe(false);
    // …and a normal namespace IS served, so the derivation is not vacuous.
    expect(loadServedServerAliases(helper).has("$server/auth/extension-wire-authz")).toBe(true);
  });

  test("a commented-out shim does not count as one", () => {
    // Same hazard as issue #138 on the MODULE_PATHS side: prose naming a
    // registration must not satisfy the gate.
    const src = `// mock.module(${Q}$server/memory/chunking${Q}, () => require(${Q}../memory/chunking${Q}));`;

    expect([...extractServerAliasShims(src, FAKE)]).toEqual([]);
    expect(covered(src, "$server/memory/chunking")).toBe(false);
  });

  test("a $server in-file restore must name the module its alias names", () => {
    // The two mentions-search suites rely on the in-file restore pattern for
    // their `$server/*` stubs, and the walker's count short-circuit would have
    // accepted ANY second registration — including one aimed at a different
    // module. That is the redirect hazard again, so `$server/*` targets are
    // excluded from the count rule and re-checked here.
    const stub = `mock.module(${Q}$server/runtime/tools/builtin-registry${Q}, () => ({ getBuiltInCategories: () => [] }));`;
    const good = `${stub}\nmock.module(${Q}$server/runtime/tools/builtin-registry${Q}, () => require(${Q}../runtime/tools/builtin-registry${Q}));`;
    const bad = `${stub}\nmock.module(${Q}$server/runtime/tools/builtin-registry${Q}, () => require(${Q}../runtime/hub-pages${Q}));`;

    expect(covered(good, "$server/runtime/tools/builtin-registry")).toBe(true);
    expect(covered(bad, "$server/runtime/tools/builtin-registry")).toBe(false);
    // The stub alone — no restore at all — is also uncovered.
    expect(covered(stub, "$server/runtime/tools/builtin-registry")).toBe(false);
  });

  test("the whole backlog is gone — no frozen $server allowlist remains", () => {
    // The ratchet is retired: every former entry is now either snapshotted in
    // MODULE_PATHS, a verified shim, or restored in-file. Nothing is excused by
    // a hardcoded string, so a stale excuse cannot outlive its call site.
    const source = rfs(join(import.meta.dir, "mock-cleanup-coverage.test.ts"), "utf8");
    const declarations = source.match(/^const SERVER_ALIAS_BACKLOG\b/m);

    expect(declarations).toBeNull();
  });

  // The same filter guards the other scrape direction — prose naming a
  // mock.module() target must not count as a real one. Both scrapers share
  // stripCommentLines() precisely so they cannot drift apart again.
  test("extractMockPaths and parseModulePaths share the comment filter", () => {
    // `q` keeps the fixture's quotes out of the literal `mock.module("` form,
    // so the walker above does not scrape this meta-test's own fixture as a
    // real mock target (the same self-reference the `${` exemption covers).
    const q = '"';
    const commented = [
      `// we deliberately do NOT mock.module(${q}../commented/only${q}) here`,
      ` * mock.module(${q}../block-commented/only${q})`,
      `mock.module(${q}../genuinely/mocked${q}, () => ({}));`,
    ].join("\n");

    expect(extractMockPaths(commented)).toEqual(["../genuinely/mocked"]);
    expect(stripCommentLines(`// ${q}x${q}\n${q}y${q}`)).toBe(`${q}y${q}`);
  });
});
