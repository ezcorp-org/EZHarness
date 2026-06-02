#!/usr/bin/env bun
/**
 * Parse coverage/lcov.info and enforce per-glob thresholds from
 * scripts/coverage-thresholds.json. Exits 1 on any violation.
 */
import { Glob } from "bun";
import { relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const LCOV_PATH = resolve(REPO_ROOT, "coverage/lcov.info");
const THRESHOLDS_PATH = resolve(REPO_ROOT, "scripts/coverage-thresholds.json");

// Files matching any of these globs are NOT enforced (generated / vendor / markup).
const EXCLUDES = [
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
  // Web security helpers whose bun:test suites rely on per-`beforeEach`
  // `mock.module` re-registration — a bun-runtime feature with no vitest
  // equivalent (`vi.mock` is statically hoisted), so they can't run in the
  // v8/vitest coverage leg, and a bun shard run from web/ pollutes the whole
  // tree. Each is ≥95% covered behaviourally under `bun test`; same spirit as
  // the "covered, not line-measurable in this mechanism" excludes above.
  "web/src/lib/server/security/bearer-auth.ts",
  "web/src/lib/server/security/openai-extension-creds.ts",
  "web/src/lib/server/security/payload.ts",
  "web/src/lib/server/security/internal-auth.ts",
  "web/src/lib/server/security/system-user.ts",
  "web/src/lib/server/security/bundled-creds.ts",
  "web/src/lib/server/security/rate-limiter.ts",
  "web/src/lib/server/security/api-keys.ts",
  "web/src/lib/server/security/resource-quotas.ts",
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
];

type FileCov = { totalLines: number; coveredLines: number; missed: number[] };

const thresholdsText = await Bun.file(THRESHOLDS_PATH).text();
const thresholds = JSON.parse(thresholdsText) as Record<string, number>;
// Bun's `Glob` treats `[id]` as a character class — a literal SvelteKit
// route segment like `[id]` would never match itself. Escape `[` and `]`
// in the threshold key before constructing the Glob so bracketed paths
// match literally; non-bracketed keys are unaffected.
function escapeGlob(p: string): string {
  return p.replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
const thresholdGlobs = Object.keys(thresholds).map((pat) => ({
  pat,
  glob: new Glob(escapeGlob(pat)),
  specificity: pat.replace(/\*/g, "").length,
  threshold: thresholds[pat] ?? 0,
}));
// Sort most-specific first so first match wins.
thresholdGlobs.sort((a, b) => b.specificity - a.specificity);

const excludeGlobs = EXCLUDES.map((p) => new Glob(escapeGlob(p)));

const lcov = await Bun.file(LCOV_PATH).text();
const perFile = new Map<string, FileCov>();
let curRec: FileCov | null = null;

for (const line of lcov.split("\n")) {
  if (line.startsWith("SF:")) {
    const abs = line.slice(3);
    const rel = relative(REPO_ROOT, abs);
    curRec = { totalLines: 0, coveredLines: 0, missed: [] };
    perFile.set(rel, curRec);
  } else if (!curRec) {
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

const violations: string[] = [];
const matchedThresholds = new Set<string>();
let enforced = 0;
for (const [file, cov] of perFile) {
  if (excludeGlobs.some((g) => g.match(file))) continue;
  const match = thresholdGlobs.find((t) => t.glob.match(file));
  if (!match) continue;
  matchedThresholds.add(match.pat);
  enforced++;
  if (cov.totalLines === 0) {
    violations.push(
      `${file}: 0 measured lines (file in lcov but no DA records) — ` +
        `coverage script doesn't measure this path. Either add coverage ` +
        `for it, exclude it, or extend test-coverage.sh.`,
    );
    continue;
  }
  const pct = (cov.coveredLines / cov.totalLines) * 100;
  if (pct + 1e-9 < match.threshold) {
    const missedCsv = cov.missed.slice(0, 40).join(",") + (cov.missed.length > 40 ? ",..." : "");
    violations.push(
      `${file}: ${pct.toFixed(2)}% < ${match.threshold}% — missed lines: ${missedCsv}`,
    );
  }
}

// Threshold rules that no lcov file matched at all are silent gates —
// either the source file moved, the threshold key has a typo, or the
// test runner that produces this lcov never exercises that path (e.g.
// vitest-only Svelte components when only bun:test feeds lcov). Surface
// each as a failure so the silence is audible.
//
// Skip threshold patterns whose key is itself covered by an EXCLUDES
// pattern (e.g. a `web/src/lib/**` wildcard with an exclude carve-out)
// — those aren't enforced.
for (const t of thresholdGlobs) {
  if (matchedThresholds.has(t.pat)) continue;
  if (excludeGlobs.some((g) => g.match(t.pat))) continue;
  // Wildcard threshold keys (e.g. `web/src/lib/**`) are expected to
  // produce zero direct matches when more-specific keys catch every
  // file — that's not a missing gate, it's the wildcard-is-fallback
  // pattern. Only fail-loud on EXACT-file threshold keys (no `*`).
  if (t.pat.includes("*")) continue;
  violations.push(
    `${t.pat}: listed in thresholds but no lcov data — ` +
      `coverage script doesn't measure this path. Either add coverage ` +
      `for it, exclude it, or extend test-coverage.sh.`,
  );
}

if (violations.length > 0) {
  console.error(`Coverage gate FAILED (${violations.length} file(s) below threshold):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

if (enforced === 0) {
  console.error(
    "Coverage gate: no files matched any threshold rule — empty lcov or misconfigured thresholds",
  );
  process.exit(1);
}

console.log(`Coverage gate PASSED: ${enforced} enforced file(s) at or above threshold.`);
