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

function loadModulePaths(): Set<string> {
  return parseModulePaths(rfs(join(import.meta.dir, "helpers", "mock-cleanup.ts"), "utf8"));
}

// Top-level `$server/*` namespaces that `restoreModuleMocks()` can serve at
// all. It derives each alias from a MODULE_PATHS entry (`$server/<rel>` for
// every `../../<rel>` whose prefix is in the helper's
// `SERVER_ALIAS_PREFIXES`), so a mock under a namespace missing from this set
// can never be restored — checking it FIRST keeps the failure message
// pointed at the right fix. Membership here is necessary, never sufficient:
// `isServerPrefixed()` below still requires the full tail to be snapshotted
// or the registration to be a verified pass-through shim.
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
  // `src/logger.ts` — a top-level MODULE rather than a directory, but served
  // under `$server/*` exactly like the namespaces above. Route handlers import
  // it (`web/src/routes/api/knowledge-base/+server.ts`), so any suite mounting
  // one has to alias it. `../../logger` is in MODULE_PATHS, so the tail check
  // covers it; the pass-through-shim rule below is the general form of the
  // "the registration re-exports the REAL module" argument this entry used to
  // make in prose.
  "logger",
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
 * Scrape the `$server/*` PASS-THROUGH ALIAS SHIMS out of a test source.
 *
 * A shim is a registration of the exact form
 *
 *     mock.module("$server/a/b", () => require("<path that resolves to src/a/b>"))
 *
 * It replaces nothing. Bun has no `$server/*` resolver outside SvelteKit's
 * vite build, so a suite that mounts a route handler has to give the alias a
 * body; handing it the REAL module is the minimum that makes the import
 * resolve. There is no stub to leak, and the lazy `require()` inside the
 * factory re-dispatches at every resolution — so a later file's own
 * `mock.module("../../a/b", …)` still wins through the alias. That is the
 * same mechanism `restoreModuleMocks()` installs (see the "lazy factory is
 * critical" note in `helpers/mock-cleanup.ts`): restoring a shim would
 * write back the byte-identical registration.
 *
 * So a shim is COVERED, and it does not need a MODULE_PATHS snapshot. This
 * is the reasoning the `logger` entry in `SERVER_ALIAS_TOP_LEVELS` already
 * states in prose; it is checked here instead, per call site.
 *
 * TWO PROPERTIES MAKE THIS A CHECK AND NOT AN EXCUSE, and both matter:
 *
 *  1. The factory must be `() => require("…")` and nothing else. An object
 *     literal, a spread-with-overrides, or a hoisted const is NOT a shim —
 *     those replace exports and must be snapshotted or restored in-file.
 *  2. The required path must resolve to the module the alias NAMES. Without
 *     that, `mock.module("$server/auth/extension-rbac", () =>
 *     require("../../auth/middleware"))` would pass as a shim while
 *     substituting a different module — a redirect, which is exactly the
 *     silent-ALLOW class this file exists to prevent.
 *
 * Applied to the 16-entry `SERVER_ALIAS_BACKLOG` this replaced, 12 were
 * shims. It also still REJECTS the offender that motivated the tail check:
 * `mock.module("$server/auth/extension-wire-authz", …)` was an allow-biased
 * object literal, not a shim.
 */
function extractServerAliasShims(source: string, testFile: string): Set<string> {
  const shims = new Set<string>();
  const re = /mock\.module\(\s*"(\$server\/[^"]+)"\s*,\s*\(\)\s*=>\s*require\(\s*"([^"]+)"\s*\)\s*,?\s*\)/g;
  for (const m of stripCommentLines(source).matchAll(re)) {
    const alias = m[1]!;
    const tail = stripJsTsExt(alias.slice("$server/".length));
    if (canonicalize(m[2]!, testFile) === `../../${tail}`) shims.add(alias);
  }
  return shims;
}

/**
 * A `$server/<tail>` mock is covered iff `../../<tail>` is in MODULE_PATHS,
 * or the registration is a verified pass-through alias shim.
 *
 * This used to accept any `$server/<top>/…` whose TOP-LEVEL namespace the
 * restore helper knew about (`auth`, `db`, `extensions`, …), which is far
 * weaker than what `restoreModuleMocks()` actually does: that loop walks
 * MODULE_PATHS and re-registers `$server/<rel>` per ENTRY, so an alias whose
 * relative path was never snapshotted is not restored at all. The gap let
 * `mock.module("$server/auth/extension-wire-authz", …)` — an allow-biased
 * stub of the MCP wire gate — pass this meta-test while its `afterAll`
 * restore was a silent no-op. Checking the full tail closes the class, not
 * just that instance.
 *
 * `topLevels` is still consulted first: a path under a namespace the restore
 * loop does not serve at all can never be covered, and saying so keeps the
 * failure message pointed at the right fix.
 */
function isServerPrefixed(
  path: string,
  topLevels: Set<string>,
  modulePaths: Set<string>,
  aliasShims: Set<string>,
): boolean {
  if (!path.startsWith("$server/")) return false;
  const tail = stripJsTsExt(path.slice("$server/".length));
  const top = tail.split("/")[0];
  if (top === undefined || !topLevels.has(top)) return false;
  if (modulePaths.has(`../../${tail}`)) return true;
  return aliasShims.has(path);
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
      const aliasShims = extractServerAliasShims(src, file);
      // In-file restore pattern: a file that mock.module()s the same
      // path twice snapshots the real exports before stubbing and
      // re-registers them in afterAll (used where the path cannot go
      // in MODULE_PATHS because an eager preload import of its module
      // graph hangs phase-2b-e2e — drafts-handler, author-install,
      // runtime/preview/*). Such paths are covered without a snapshot.
      const counts = new Map<string, number>();
      for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
      for (const raw of paths) {
        if ((counts.get(raw) ?? 0) >= 2) continue;
        if (isExempt(raw)) continue;
        if (modulePaths.has(raw)) continue;
        if (isServerPrefixed(raw, SERVER_ALIAS_TOP_LEVELS, modulePaths, aliasShims)) continue;
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

  test("a $server shim re-exporting the module the alias names is covered", () => {
    const src = `mock.module(${Q}$server/runtime/hub-pages${Q}, () => require(${Q}../runtime/hub-pages${Q}));`;
    const shims = extractServerAliasShims(src, FAKE);

    expect([...shims]).toEqual(["$server/runtime/hub-pages"]);
    // …and that is what makes it covered without a MODULE_PATHS snapshot.
    expect(isServerPrefixed("$server/runtime/hub-pages", SERVER_ALIAS_TOP_LEVELS, new Set(), shims)).toBe(
      true,
    );
    // The multi-line form the workflow/scan suites use scrapes identically.
    const wrapped = `mock.module(${Q}$server/routes/tool-permission${Q}, () =>\n  require(${Q}../routes/tool-permission${Q}),\n);`;
    expect([...extractServerAliasShims(wrapped, FAKE)]).toEqual(["$server/routes/tool-permission"]);
  });

  test("a $server shim pointing at a DIFFERENT module is not covered", () => {
    // The redirect case: reads like a shim, substitutes another module. This is
    // the silent-ALLOW shape (an RBAC alias answered by an unrelated module),
    // so the tail must match or the registration is not a shim.
    const src = `mock.module(${Q}$server/auth/extension-rbac${Q}, () => require(${Q}../auth/middleware${Q}));`;
    const shims = extractServerAliasShims(src, FAKE);

    expect([...shims]).toEqual([]);
    expect(isServerPrefixed("$server/auth/extension-rbac", SERVER_ALIAS_TOP_LEVELS, new Set(), shims)).toBe(
      false,
    );
  });

  test("a $server STUB is not a shim — the wire-gate offender still fails", () => {
    // Verbatim shape of the mock that motivated the tail check: an
    // allow-biased object literal behind an `$server/*` alias.
    const stub = [
      `mock.module(${Q}$server/auth/extension-wire-authz${Q}, () => ({`,
      `  partitionWirableExtensions: () => ({ allowed: candidates }),`,
      `}));`,
    ].join("\n");
    const shims = extractServerAliasShims(stub, FAKE);

    expect([...shims]).toEqual([]);
    expect(
      isServerPrefixed("$server/auth/extension-wire-authz", SERVER_ALIAS_TOP_LEVELS, new Set(), shims),
    ).toBe(false);
    // A snapshot is then the only way to cover it — which is where the real
    // helper puts it today.
    expect(
      isServerPrefixed(
        "$server/auth/extension-wire-authz",
        SERVER_ALIAS_TOP_LEVELS,
        new Set(["../../auth/extension-wire-authz"]),
        shims,
      ),
    ).toBe(true);
  });

  test("a shim under an unserved top-level namespace is still not covered", () => {
    // `restoreModuleMocks()` only derives aliases whose prefix it serves, so a
    // namespace outside SERVER_ALIAS_TOP_LEVELS can never be restored — the
    // namespace check stays necessary even for a well-formed shim.
    const src = `mock.module(${Q}$server/suggest/index${Q}, () => require(${Q}../suggest/index${Q}));`;
    const shims = extractServerAliasShims(src, FAKE);

    expect([...shims]).toEqual(["$server/suggest/index"]);
    expect(isServerPrefixed("$server/suggest/index", SERVER_ALIAS_TOP_LEVELS, new Set(), shims)).toBe(
      false,
    );
  });

  test("a commented-out shim does not count as one", () => {
    // Same hazard as issue #138 on the MODULE_PATHS side: prose naming a
    // registration must not satisfy the gate.
    const src = `// mock.module(${Q}$server/memory/chunking${Q}, () => require(${Q}../memory/chunking${Q}));`;

    expect([...extractServerAliasShims(src, FAKE)]).toEqual([]);
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
