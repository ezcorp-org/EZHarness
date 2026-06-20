#!/usr/bin/env bun
/**
 * Patch / diff coverage gate (Bun-native; no Python `diff-cover` dependency).
 *
 * Asserts that every NEW or CHANGED *executable* line in the PR (vs
 * origin/main) is covered. This is the pragmatic complement to the whole-repo
 * per-file gate: it catches an undertested change to an EXISTING file, which
 * the added-files-only new-file gate doesn't see.
 *
 * "Executable" = the line has a DA record in coverage/lcov.info. Added lines
 * with no DA record (comments, blanks, type-only, declarations) are ignored —
 * only executable added lines must be hit. Files with no lcov data at all are
 * skipped here (the new-file gate / per-file gate own those cases).
 *
 * Reuses the unified-diff parser from gate-integrity.ts and the lcov parser
 * from coverage-config.ts (DRY). Pure helper exported for unit testing.
 */
import { resolve } from "node:path";
import { isExcluded, isSourceFile, parseHitLines, parseLcov, REPO_ROOT } from "./coverage-config.ts";
import { parseUnifiedDiff } from "./gate-integrity.ts";

/**
 * Of the added lines, return those that are executable-but-uncovered: present
 * in `missedLines` (executable, 0 hits). Added lines in `hitLines` pass; added
 * lines in neither set are non-executable and ignored.
 */
export function uncoveredAddedLines(
  addedLines: Set<number>,
  hitLines: Set<number>,
  missedLines: Set<number>,
): number[] {
  const out: number[] = [];
  for (const ln of addedLines) {
    if (missedLines.has(ln) && !hitLines.has(ln)) out.push(ln);
  }
  return out.sort((a, b) => a - b);
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out : "";
}

async function main(): Promise<void> {
  const base = process.env.BASE_REF || "origin/main";
  const diff = await git(["diff", "--unified=0", `${base}...HEAD`, "--", "*.ts", "*.svelte"]);
  const perFileDiff = parseUnifiedDiff(diff);

  const lcovText = await Bun.file(resolve(REPO_ROOT, "coverage/lcov.info"))
    .text()
    .catch(() => "");
  const cov = parseLcov(lcovText);
  const hits = parseHitLines(lcovText);

  const violations: string[] = [];
  let checkedFiles = 0;
  for (const [file, info] of perFileDiff) {
    if (!isSourceFile(file) || isExcluded(file)) continue;
    const fileCov = cov.get(file);
    if (!fileCov) continue; // no lcov data — owned by the new-file / per-file gate
    checkedFiles++;
    const missedSet = new Set(fileCov.missed);
    const hitSet = hits.get(file) ?? new Set<number>();
    const uncovered = uncoveredAddedLines(info.addedLines, hitSet, missedSet);
    if (uncovered.length > 0) {
      const shown = uncovered.slice(0, 40).join(",") + (uncovered.length > 40 ? ",..." : "");
      violations.push(`${file}: ${uncovered.length} changed line(s) uncovered: ${shown}`);
    }
  }

  if (violations.length === 0) {
    console.log(`Patch coverage gate PASSED: all changed executable lines covered (${checkedFiles} file(s)).`);
    return;
  }
  console.error(`Patch coverage gate FAILED (${violations.length} file(s) with uncovered changes):`);
  for (const v of violations) console.error(`  ${v}`);
  console.error("\nAdd tests covering the changed lines above, then re-run the coverage pipeline.");
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
