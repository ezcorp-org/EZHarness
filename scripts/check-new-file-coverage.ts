#!/usr/bin/env bun
/**
 * New-file coverage gate (diff-scoped).
 *
 * The per-file gate (scripts/check-coverage.ts) only enforces a file that
 * BOTH appears in coverage/lcov.info AND matches a threshold key — so a brand
 * new source file nobody added to coverage-thresholds.json is silently
 * un-gated (check-coverage.ts's wildcard-fallback `continue`).
 *
 * This gate closes that hole: every source file ADDED in the PR (vs
 * origin/main) must be GATEABLE —
 *   (a) present in coverage/lcov.info with ≥1 measured line (a test exercises
 *       it), AND
 *   (b) matched by a threshold key in coverage-thresholds.json (so
 *       check-coverage.ts actually enforces a percentage on it).
 * A file that legitimately can't be line-measured goes in EXCLUDES instead
 * (which gate-integrity.ts then routes through human review).
 *
 * The default policy floor for a new file is 100%; the actual value lives in
 * the (CODEOWNERS-reviewed) coverage-thresholds.json key, and check-coverage.ts
 * enforces it. This gate only guarantees the file is *gated at all*.
 *
 * Pure helper exported for unit testing; main() wires git + the filesystem.
 */
import { Glob } from "bun";
import { resolve } from "node:path";
import {
  escapeGlob,
  isExcluded,
  isSourceFile,
  parseLcov,
  REPO_ROOT,
  type FileCov,
} from "./coverage-config.ts";

/**
 * For each added source file, return a violation message unless it is both
 * measured in lcov (≥1 line) and matched by a threshold glob.
 */
export function newFileViolations(
  addedSourceFiles: readonly string[],
  perFile: Map<string, FileCov>,
  thresholdKeys: readonly string[],
): string[] {
  const globs = thresholdKeys.map((k) => new Glob(escapeGlob(k)));
  const out: string[] = [];
  for (const file of addedSourceFiles) {
    const cov = perFile.get(file);
    const matched = globs.some((g) => g.match(file));
    if (!cov || cov.totalLines === 0) {
      out.push(
        `${file}: new source file with no measured coverage — add a test that exercises it ` +
          `(or, if it genuinely can't be line-measured, add it to EXCLUDES in ` +
          `scripts/coverage-config.ts with justification).`,
      );
      continue;
    }
    if (!matched) {
      out.push(
        `${file}: new source file is not gated — add a key to scripts/coverage-thresholds.json ` +
          `(default 100) so the coverage gate enforces it.`,
      );
    }
  }
  return out;
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const added = (await git(["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => isSourceFile(f) && !isExcluded(f));

  if (added.length === 0) {
    console.log("New-file coverage gate PASSED: no new source files in this diff.");
    return;
  }

  const lcovText = await Bun.file(resolve(REPO_ROOT, "coverage/lcov.info"))
    .text()
    .catch(() => "");
  const perFile = parseLcov(lcovText);
  const thresholds = JSON.parse(
    await Bun.file(resolve(REPO_ROOT, "scripts/coverage-thresholds.json")).text(),
  ) as Record<string, number>;

  const violations = newFileViolations(added, perFile, Object.keys(thresholds));
  if (violations.length === 0) {
    console.log(`New-file coverage gate PASSED: ${added.length} new source file(s) gated.`);
    return;
  }
  console.error(`New-file coverage gate FAILED (${violations.length} file(s)):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
