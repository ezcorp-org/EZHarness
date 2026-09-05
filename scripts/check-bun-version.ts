#!/usr/bin/env bun
/**
 * Bun version-skew detector.
 *
 * `.bun-version` is the single pin CI reads (see ci.yml's header note and
 * `.github/actions/setup/action.yml`), but nothing ever compared it against
 * the `bun` binary actually running a LOCAL test/hook invocation. That gap
 * cost real time: `src/__tests__/mock-llm-pi-ai.integration.test.ts` failed
 * deterministically on a checkout running bun 1.3.9 while `.bun-version`
 * pinned 1.3.14 and CI was green throughout — a patch-level Bun release
 * changed fetch's silent-retry-on-empty-response behaviour, and four
 * separate agents re-derived "pre-existing, ignore it" before anyone
 * thought to check which bun ran the test. This script exists so that
 * question is answered BEFORE the run, not after a mystery failure.
 *
 * ## Design
 *
 * - Pure comparison logic (`parseBunVersion`, `compareBunVersions`,
 *   `skewAction`) is exported and unit-tested in
 *   `src/__tests__/check-bun-version.test.ts` — this is exactly the kind of
 *   code that silently does nothing if the comparison is wrong (a naive
 *   string compare reads "1.3.9" as newer than "1.3.14", which is the
 *   specific bug that produced the incident above).
 * - `main()` reads the two version strings and decides warn vs. fail:
 *     - versions match, or the pin file is missing/unreadable → silent,
 *       exit 0. This is what makes the check a no-op in CI: every workflow
 *       installs bun via `oven-sh/setup-bun` with
 *       `bun-version-file: .bun-version` (see ci.yml), so the running `bun`
 *       and the pin are the same string by construction there.
 *     - PATCH-level mismatch → warn to stderr, exit 0 (non-blocking). Patch
 *       releases ship often and usually don't matter for the task at hand;
 *       blocking every run over one would train people to bypass the check
 *       rather than read it. But it can silently change behaviour (the
 *       incident above WAS a patch-level gap), so the warning names the risk
 *       explicitly instead of leaving it to be rediscovered as a mystery
 *       failure, and names the exact fix command.
 *     - MINOR/MAJOR-level mismatch → fail (non-zero exit), because a wider
 *       gap is far more likely to carry breaking runtime/API changes (new
 *       defaults, removed flags, changed test-runner semantics) that could
 *       invalidate everything the caller is about to run — worth blocking
 *       for, with an explicit escape hatch (EZ_SKIP_BUN_VERSION_CHECK=1)
 *       for the rare case someone is deliberately testing against a
 *       different bun.
 *
 * Invoked from scripts/test.sh, scripts/test-coverage.sh, scripts/test-web.sh
 * (where a wrong bun corrupts the results) and .githooks/pre-commit,
 * .githooks/pre-push (where a developer is already paying attention) — one
 * definition, five call sites, so the skew can't be checked three different
 * (or zero) ways. `bun scripts/check-bun-version.ts` also works standalone.
 */
import { resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dir, "..");

export interface BunVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse a `major.minor.patch` prefix out of a Bun version string. Tolerates
 * a leading "v" and a trailing pre-release/build suffix (e.g. a canary build
 * like "1.3.9-canary.20240101") since only the three numeric components are
 * ever compared. Returns null when no such prefix exists.
 */
export function parseBunVersion(raw: string): BunVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export type SkewLevel = "match" | "major" | "minor" | "patch" | "unparseable";

export interface SkewResult {
  level: SkewLevel;
  /** Raw (trimmed) strings, preserved for messages even when unparseable. */
  pinned: string;
  actual: string;
}

/**
 * Compare the pinned (`.bun-version`) and actual (running `bun`) version
 * strings component-by-component as NUMBERS. This is deliberately not a
 * string comparison: "1.3.9" > "1.3.14" lexically but is the OLDER version,
 * which is exactly the bug that made today's incident possible to miss.
 */
export function compareBunVersions(pinnedRaw: string, actualRaw: string): SkewResult {
  const pinned = pinnedRaw.trim();
  const actual = actualRaw.trim();
  const pinnedVer = parseBunVersion(pinned);
  const actualVer = parseBunVersion(actual);
  if (!pinnedVer || !actualVer) {
    return { level: "unparseable", pinned, actual };
  }
  if (pinnedVer.major !== actualVer.major) return { level: "major", pinned, actual };
  if (pinnedVer.minor !== actualVer.minor) return { level: "minor", pinned, actual };
  if (pinnedVer.patch !== actualVer.patch) return { level: "patch", pinned, actual };
  return { level: "match", pinned, actual };
}

export interface SkewAction {
  /** Should the caller exit non-zero (absent an explicit bypass)? */
  blocking: boolean;
  /** Message to print to stderr, or null for a fully silent match. */
  message: string | null;
}

const BYPASS_VAR = "EZ_SKIP_BUN_VERSION_CHECK";

/** Turn a comparison result into "what should the caller do about it". */
export function skewAction(result: SkewResult): SkewAction {
  const fix = `bun upgrade --to ${result.pinned}`;
  switch (result.level) {
    case "match":
      return { blocking: false, message: null };
    case "unparseable":
      return {
        blocking: false,
        message:
          `⚠ bun version check: could not parse a version to compare ` +
          `(pinned .bun-version="${result.pinned}", running bun="${result.actual}"). ` +
          `Skipping the skew check rather than blocking on a format it doesn't recognise.`,
      };
    case "patch":
      return {
        blocking: false,
        message:
          `⚠ bun version skew (patch): .bun-version pins ${result.pinned}, running bun is ${result.actual}.\n` +
          `  A patch-level Bun difference can silently change runtime behaviour (e.g. fetch's\n` +
          `  retry-on-empty-response semantics differed between 1.3.9 and 1.3.14) — a local\n` +
          `  pass/fail can disagree with CI for reasons that have nothing to do with your change.\n` +
          `  Fix: ${fix}`,
      };
    case "minor":
    case "major":
      return {
        blocking: true,
        message:
          `✗ bun version skew (${result.level}): .bun-version pins ${result.pinned}, running bun is ${result.actual}.\n` +
          `  A ${result.level}-version gap is likely to carry breaking runtime/API changes, not just an\n` +
          `  edge-case behaviour difference — results below may not be trustworthy.\n` +
          `  Fix:     ${fix}\n` +
          `  Bypass:  ${BYPASS_VAR}=1 (not recommended — CI always runs the pinned version)`,
      };
  }
}

async function main(): Promise<void> {
  const pinnedPath = resolve(REPO_ROOT, ".bun-version");
  let pinnedRaw: string;
  try {
    pinnedRaw = await Bun.file(pinnedPath).text();
  } catch {
    // No pin file to compare against — never block a run over that; this
    // script's only job is comparing two versions, not enforcing the pin
    // file's existence.
    return;
  }

  // `Bun.version` (not a spawned `bun --version`) is exactly the interpreter
  // running THIS script, which is exactly the interpreter about to run the
  // caller's tests/hooks — no subprocess, no PATH ambiguity.
  const result = compareBunVersions(pinnedRaw, Bun.version);
  const action = skewAction(result);
  if (action.message) {
    console.error(action.message);
  }
  if (action.blocking && process.env[BYPASS_VAR] !== "1") {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
