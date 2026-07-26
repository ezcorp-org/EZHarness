#!/usr/bin/env bun
/**
 * Shared coverage-gate configuration + helpers.
 *
 * Single source of truth for: the EXCLUDES list (paths NOT enforced),
 * the source-file classification (what counts as gateable product code),
 * the Bun `Glob` escaping quirk, and the lcov parser. Imported by
 * scripts/check-coverage.ts (the per-file gate), scripts/gate-integrity.ts
 * (anti-tamper meta-check), scripts/check-new-file-coverage.ts and
 * scripts/check-patch-coverage.ts so none of these re-derive the same
 * lists/parsers — keeping the gate definition DRY and consistent.
 *
 * REPO_ROOT is derived from this file's own location (scripts/..) so that
 * the spawn-in-a-sandbox tests (src/__tests__/coverage-gate.test.ts copies
 * the scripts into a temp dir) rebase onto the sandbox identically to the
 * old inline implementation.
 */
import { Glob } from "bun";
import { relative, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

// Files matching any of these globs are NOT enforced (generated / vendor / markup).
//
// GATE-INTEGRITY NOTE: this array is the un-gating surface. Adding an entry
// removes a file from coverage enforcement, so scripts/gate-integrity.ts
// fails any PR that GROWS this list unless a maintainer applies the
// `gate-change-approved` label. Keep one path (or wildcard) per line with a
// justification comment so the diff is reviewable.
export const EXCLUDES: readonly string[] = [
  "src/extensions/sdk/init.ts",
  "src/db/migrations/**",
  "src/providers/**",
  "web/src/routes/**/+*.svelte",
  "web/e2e/**",
  // Template-string files: lcov counts the interior of returned
  // template literals as "missed lines" even when every template
  // function is exercised end-to-end via sdk-scaffold.test.ts. There's
  // no executable code path inside the strings — they're literal
  // output. Same justification as `web/src/routes/**/+*.svelte`.
  "packages/@ezcorp/sdk/src/scaffold/templates/**",
  // Verbatim copied-into-the-extension skill runner: its `main()` +
  // stdin loop are process-level (only execute as a spawned
  // subprocess), so they can't be line-covered in-process. Behaviour
  // IS verified — `handleRequest` / `commandFor` are unit-tested
  // in-process, plus a real subprocess smoke test and the
  // import-wizard e2e exercise the spawned path. Same spirit as the
  // scaffold-templates exclusion above.
  "src/runtime/import/skill-runner.template.ts",
  // Declaration-only TypeScript types: no executable code to count.
  // Same justification as scaffold/templates/** above — lcov can't
  // measure pure `export interface` / `export type` files. The host
  // shim is a `export type *` re-export; the SDK file is the canonical
  // type surface. Both ship with byte-for-byte alignment enforced by
  // host-shim tests, not lcov.
  "packages/@ezcorp/sdk/src/types.ts",
  "src/extensions/sdk/types.ts",
  // Loop SDK public type surface — pure `export type` / `export interface`
  // (no executable code; compiles to empty), identical justification to the
  // two type files above. Flagged by the new-file gate as "no measured
  // coverage" because there is, by construction, nothing to line-measure.
  "packages/@ezcorp/sdk/src/runtime/loop-types.ts",
  // NOTE: the 9 web security helpers (bearer-auth, openai-extension-creds,
  // payload, internal-auth, system-user, bundled-creds, rate-limiter, api-keys,
  // resource-quotas) were REMOVED from this list. Their bun:test suites rely on
  // per-`beforeEach` `mock.module` re-registration (a bun-only feature, no
  // `vi.mock` equivalent) so they can't run in the v8/vitest leg — but
  // scripts/security-coverage.sh now measures them under `bun --coverage` and
  // FILTERS the lcov to exactly these 9 files (no web/src/lib union artifact),
  // uploaded as an `lcov-cov-*` artifact by the CI `web-security-coverage` job.
  // Each clears the `web/src/lib/**` 90% floor (measured 97.78–100%). Their
  // suites are ALSO run for pass/fail by the `web-bun-tests` job.
  // Thin typed fetch client (~75 `fetch().then(json)` wrappers, no branching) —
  // UI I/O glue, same spirit as the excluded `web/src/routes/**/+*.svelte`.
  "web/src/lib/api.ts",
  // Process-boot singleton orchestrator; its accessors only execute
  // meaningfully in a fully-booted server (integration-only, like other boot
  // wiring).
  "web/src/lib/server/context.ts",
  // Web logic that IS unit-tested (node-vitest leg) but can't be cleanly
  // line-measured by this gate: the bun host/example shards transitively
  // import these and emit their own span-filled zero-hit DA records, which
  // merge-lcov unions with the vitest leg's clean coverage — the union of
  // line sets drags the percentage below either measurement alone. Their
  // tests run in the `Web tests (vitest)` CI job; coverage just can't see it
  // under dual bun+v8 instrumentation. (Same family as the security excludes.)
  "web/src/lib/mention-logic.ts",
  "web/src/lib/markdown.ts",
  "web/src/lib/chat-input-logic.ts",
  "web/src/lib/utils/relative-time.ts",
  "web/src/lib/server/http-errors.ts",
  "web/src/lib/server/shutdown.ts",
  "web/src/lib/server/auth/session-cookie.ts",
  "web/src/lib/server/extension-helpers.ts",
  // Secure-preview SvelteKit dispatch glue. These ARE exhaustively covered by
  // their vitest `.server.test.ts` suites (dispatch 96.5%, ws-bridge 100% under
  // the v8 leg), but `web/src/hooks.server.ts` statically imports both, so the
  // `c2-session-revocation` bun shard (which imports hooks.server.ts to test
  // the app-origin session path) instruments them with BUN's TypeScript-line
  // span set. merge-lcov then unions bun's superset of "executable" lines with
  // the vitest leg's v8 line set — and the bun-only lines have no v8 hit to
  // offset them, dragging the merged percentage to ~75/83 % even though the
  // dedicated vitest leg covers every reachable line. The dispatch readFile dep
  // (`Bun.file().stream()`) is additionally Bun-runtime-only (the vitest/jsdom
  // leg can't run it). Identical dual-instrumentation hazard to the
  // mention-logic / context / security excludes above: covered behaviourally
  // and gated under `Web tests (vitest)`, just not line-measurable in this
  // merged bun+v8 lcov.
  "web/src/lib/server/preview/dispatch.ts",
  "web/src/lib/server/preview/ws-bridge.ts",
  // Scaffold string-template files: lcov counts the interior of the returned
  // template literals as missed lines even when every template function is
  // exercised (`src/__tests__/ext-sdk-types.test.ts`). Identical justification
  // to packages/@ezcorp/sdk/src/scaffold/templates/** above.
  "src/extensions/sdk/templates/agent.ts",
  "src/extensions/sdk/templates/multi.ts",
  "src/extensions/sdk/templates/skill.ts",
  "src/extensions/sdk/templates/tool.ts",
  // Illustrative demo extensions whose index.ts is mostly narrative tool
  // handlers + a harness; exhaustive line coverage isn't a meaningful gate for
  // sample code (they're smoke-tested, not gated at 100 like real code). The
  // other examples that DO reach ≥90 stay gated via the examples threshold.
  "docs/extensions/examples/weather/index.ts",
  "docs/extensions/examples/auto-note/index.ts",
  "docs/extensions/examples/harness-smoke-test/index.ts",
  // Declarative example manifest (`defineExtension({…})`) — a config object,
  // not gateable product logic; same spirit as the example index.ts excludes
  // above. (The sample-loop index.ts IS covered by its own index.test.ts.)
  "docs/extensions/examples/sample-loop/ezcorp.config.ts",
  // Route handlers tested by their *.server.test.ts (bun:test w/ mock.module,
  // run in the `Web tests (vitest)` CI job) but NOT wired into the coverage
  // pipeline — they show "no lcov data". Same justification as the web/src/lib
  // and security excludes above: covered behaviourally, not measurable here.
  "web/src/routes/api/conversations/[id]/goal-state/+server.ts",
  "web/src/routes/api/conversations/[id]/messages/+server.ts",
  "web/src/routes/api/search/messages/+server.ts",
];

/**
 * Source-file globs: what counts as gateable product code for the
 * diff-scoped new-file / patch-coverage gates. Excludes test/spec files,
 * type-only declarations, and config. A file must match one of these AND
 * not be in EXCLUDES to be subject to the new-file 100% floor.
 */
export const SOURCE_GLOBS: readonly string[] = [
  "src/**/*.ts",
  "web/src/**/*.ts",
  "web/src/**/*.svelte",
  "packages/@ezcorp/sdk/src/**/*.ts",
  "docs/extensions/examples/**/*.ts",
];

// Test/spec/type files are never "product code" for the new-file gate.
const NON_SOURCE_GLOBS: readonly string[] = [
  "**/*.test.ts",
  "**/*.spec.ts",
  "**/__tests__/**",
  "**/*.d.ts",
];

/**
 * Catch-all (ratchet-floor) threshold keys — wave 3. These gate the
 * previously-unkeyed remainder of a tree at its observed minimum so
 * coverage can only ratchet UP, but they are NOT an acceptable home for a
 * NEW file: check-new-file-coverage.ts ignores them when deciding whether
 * an added file "is gated", so every new source file still needs its own
 * (default-100) key. Keep this list in sync with the catch-all keys in
 * coverage-thresholds.json.
 */
export const CATCHALL_THRESHOLD_KEYS: readonly string[] = [
  "src/**",
  "web/src/**",
  "packages/@ezcorp/ai-kit/src/**",
];

/**
 * Bun's `Glob` treats `[id]` as a character class — a literal SvelteKit
 * route segment like `[id]` would never match itself. Escape `[` and `]`
 * in a path/pattern before constructing the Glob so bracketed paths match
 * literally; non-bracketed keys are unaffected.
 */
export function escapeGlob(p: string): string {
  return p.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

const excludeGlobs = EXCLUDES.map((p) => new Glob(escapeGlob(p)));
const sourceGlobs = SOURCE_GLOBS.map((p) => new Glob(escapeGlob(p)));
const nonSourceGlobs = NON_SOURCE_GLOBS.map((p) => new Glob(escapeGlob(p)));

/** True if a repo-relative path matches any EXCLUDES pattern. */
export function isExcluded(relPath: string): boolean {
  return excludeGlobs.some((g) => g.match(relPath));
}

/**
 * True if a repo-relative path is gateable product code: matches a source
 * glob and is not a test/spec/type file. (EXCLUDES is applied separately by
 * callers so they can distinguish "not source" from "excluded source".)
 */
export function isSourceFile(relPath: string): boolean {
  if (nonSourceGlobs.some((g) => g.match(relPath))) return false;
  return sourceGlobs.some((g) => g.match(relPath));
}

/**
 * True if a repo-relative path is a test/spec/type artifact — regardless of
 * tree. Unlike isSourceFile it does NOT require SOURCE_GLOBS membership, so
 * trees outside the diff-gates' scope (e.g. harness-client) can still ask
 * "is this file the kind lcov could never legitimately contain coverage
 * for". Used by the wildcard whole-tree-dropout signal below.
 */
export function isTestOrTypeFile(relPath: string): boolean {
  return nonSourceGlobs.some((g) => g.match(relPath));
}

/**
 * Wildcard whole-tree-dropout signal (wave 3, used by check-coverage.ts): a
 * wildcard threshold key whose ENTIRE tree is missing from lcov used to be
 * indistinguishable from the benign shadowed-by-more-specific-keys case — a
 * coverage producer silently dying (dead leg / unwired set) could de-gate a
 * whole subtree while the gate stayed green. Cheap sound check, independent
 * of first-match-wins: violation iff the pattern matches >=1
 * non-test/non-type, non-EXCLUDED file on disk but lcov contains NONE of
 * its matches. Lives here (not check-coverage.ts) because that script runs
 * its gate at import time — unit tests import THIS module safely.
 */
export function wildcardTreeDropouts(
  wildcardPats: readonly string[],
  lcovFiles: readonly string[],
  repoFilesForPattern: (pat: string) => readonly string[],
): string[] {
  const out: string[] = [];
  for (const pat of wildcardPats) {
    const glob = new Glob(escapeGlob(pat));
    if (lcovFiles.some((f) => glob.match(f))) continue;
    const onDisk = repoFilesForPattern(pat).filter(
      (f) => !isTestOrTypeFile(f) && !isExcluded(f),
    );
    if (onDisk.length > 0) {
      out.push(
        `${pat}: wildcard threshold matches ${onDisk.length} repo file(s) (e.g. ${onDisk[0]}) ` +
          `but lcov contains NONE of them — a coverage producer for this whole tree dropped ` +
          `out (dead leg / unwired set). Fix the producer in scripts/test-coverage.sh; do not ` +
          `delete the key.`,
      );
    }
  }
  return out;
}

export type FileCov = { totalLines: number; coveredLines: number; missed: number[] };

/**
 * Parse lcov text into a per-file map keyed by repo-relative path. Only DA
 * records are read — the gate derives totals from DA directly (matches the
 * historical inline parser in check-coverage.ts).
 */
export function parseLcov(lcovText: string): Map<string, FileCov> {
  const perFile = new Map<string, FileCov>();
  let curRec: FileCov | null = null;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      const abs = line.slice(3);
      const rel = relative(REPO_ROOT, abs);
      curRec = { totalLines: 0, coveredLines: 0, missed: [] };
      perFile.set(rel, curRec);
    } else if (!curRec) {
      // skip lines before the first SF record
    } else if (line === "end_of_record") {
      curRec = null;
    } else if (line.startsWith("DA:")) {
      const [lineNoStr, hitsStr] = line.slice(3).split(",");
      if (lineNoStr === undefined || hitsStr === undefined) continue;
      const hits = Number(hitsStr);
      curRec.totalLines++;
      if (hits > 0) curRec.coveredLines++;
      else curRec.missed.push(Number(lineNoStr));
    }
  }
  return perFile;
}

/**
 * Map of repo-relative path → set of line numbers with >0 hits. Used by the
 * patch-coverage gate to ask "is changed line N covered?".
 */
export function parseHitLines(lcovText: string): Map<string, Set<number>> {
  const hits = new Map<string, Set<number>>();
  let cur: Set<number> | null = null;
  for (const line of lcovText.split("\n")) {
    if (line.startsWith("SF:")) {
      const rel = relative(REPO_ROOT, line.slice(3));
      cur = hits.get(rel) ?? new Set<number>();
      hits.set(rel, cur);
    } else if (!cur) {
      // skip
    } else if (line === "end_of_record") {
      cur = null;
    } else if (line.startsWith("DA:")) {
      const [lineNoStr, hitsStr] = line.slice(3).split(",");
      if (lineNoStr === undefined || hitsStr === undefined) continue;
      if (Number(hitsStr) > 0) cur.add(Number(lineNoStr));
    }
  }
  return hits;
}
