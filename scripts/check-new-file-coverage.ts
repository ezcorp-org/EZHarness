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
  CATCHALL_THRESHOLD_KEYS,
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
 *
 * Catch-all ratchet-floor keys (CATCHALL_THRESHOLD_KEYS, e.g. `src/**`) do
 * NOT count as "gated": they exist to floor the pre-existing unkeyed
 * remainder, and letting them satisfy this gate would silently retire the
 * every-new-file-gets-its-own-100-key policy.
 */
export function newFileViolations(
  addedSourceFiles: readonly string[],
  perFile: Map<string, FileCov>,
  thresholdKeys: readonly string[],
): string[] {
  const catchalls = new Set<string>(CATCHALL_THRESHOLD_KEYS);
  const globs = thresholdKeys.filter((k) => !catchalls.has(k)).map((k) => new Glob(escapeGlob(k)));
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

/**
 * Parse `git diff --name-status` output into this gate's "added" list:
 * A-status paths PLUS the new path of every rename with similarity >= R50.
 * A heavy rewrite that git classifies as a rename (R50-R99) previously
 * dodged the new-file gate entirely; a pure rename (R100) must also re-pass
 * so its threshold key provably moves with it instead of silently
 * de-gating. (git only reports renames at >=50% similarity by default, so
 * in practice every R row qualifies — the explicit score parse pins the
 * spec'd >=R50 intent against a future -M threshold change.)
 */
export function addedOrRewrittenFiles(nameStatus: string): string[] {
  const out: string[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t").map((p) => p.trim());
    const status = parts[0] ?? "";
    if (status === "A" && parts[1]) {
      out.push(parts[1]);
    } else if (status.startsWith("R") && parts[2]) {
      // Number("") is 0, not NaN — a bare "R" status must fail CLOSED
      // (treated like A), so parse the empty score explicitly.
      const scoreStr = status.slice(1);
      const score = scoreStr === "" ? Number.NaN : Number(scoreStr);
      if (!Number.isFinite(score) || score >= 50) out.push(parts[2]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const nameStatus = await git([
    "diff",
    "--name-status",
    "--find-renames",
    "--diff-filter=AR",
    `${base}...HEAD`,
  ]);
  const added = addedOrRewrittenFiles(nameStatus).filter((f) => isSourceFile(f) && !isExcluded(f));

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
