#!/usr/bin/env bun
/**
 * Visual-evidence CAPTURE SELECTOR (WF1, `ci.yml` job `visual-evidence`).
 *
 * The capture lane used to run EVERY `@evidence` spec on every PR, so the
 * publisher posted 46–51 screenshots per PR of which ~95% were unrelated to the
 * diff. This script narrows the capture set to the specs that could plausibly
 * have changed, based purely on the PR's changed-file list:
 *
 *   - non-visual diff (no visual-surface file, no spec)  → __NONE__
 *       The capture step skips entirely → no artifact is uploaded → WF2 bails
 *       soft → NO comment. This is the DECIDED zero-shot behaviour for a PR
 *       that touches nothing user-visible (and, as an intended side effect, for
 *       `push` to main, whose base...HEAD diff is empty).
 *   - one or more specs changed                          → run the union
 *       (`some`) of the changed specs AND every @evidence spec whose covers-map
 *       globs render a changed visual file — so a component edit that ships with
 *       its own spec still re-captures the OTHER specs that render it. Output is
 *       Playwright-rootDir-relative (`e2e/x.spec.ts`, rootDir = web/) positional
 *       args, sorted + deduped. Union requires the covers map; without it (bad
 *       JSON) the set degrades to just the changed specs.
 *   - visual file(s) changed but NO spec changed         → __ALL__ (fail-open)
 *       Only reachable when the hard gate was bypassed via the maintainer-only
 *       `evidence-exempt` label (otherwise the gate would have failed the PR).
 *       We can't know which spec renders the change, so run the whole suite.
 *
 * DRY: the "what is a visual surface" / "what is a spec" / "which specs cover
 * this file" definitions all live once in `../check-visual-evidence.ts` (the
 * hard gate) and are imported here — the selector must never drift from the
 * gate's globs or covers map. `REPO_ROOT` (for the git cwd) is the same shared
 * value the gate uses.
 *
 * `main()` is fail-OPEN: on ANY git/parse error it prints `__ALL__` and exits 0.
 * A capture selector that errored must never silently skip evidence — worst
 * case we over-capture. The ci.yml wrapper independently defaults an empty /
 * failed run to __ALL__ too, so this is belt-and-suspenders.
 *
 * Pure helpers are exported for unit testing; `main()` wires git + env + the
 * covers map.
 */
import {
  type CoversMap,
  coveringSpecsForFile,
  isSpecFile,
  isVisualSurfaceFile,
  loadCoversMap,
} from "../check-visual-evidence.ts";
import { REPO_ROOT } from "../coverage-config.ts";

/** Outcome of {@link selectEvidenceSpecs}: skip all, run all, or run a subset. */
export type SelectResult =
  | { mode: "none" }
  | { mode: "all" }
  | { mode: "some"; specs: string[] };

/**
 * Convert a repo-relative spec path (`web/e2e/x.spec.ts`) to the
 * Playwright-rootDir-relative form (`e2e/x.spec.ts`, rootDir = web/) that
 * `playwright test` expects as a positional filter. Paths that don't start
 * with `web/` are returned unchanged (defensive — the caller only feeds spec
 * paths, which always do).
 */
export function toWebRelativeSpecPath(path: string): string {
  return path.startsWith("web/") ? path.slice("web/".length) : path;
}

/**
 * Pure decision: given the PR's changed files (already ACMR-filtered by the
 * caller's git diff, so deletions never appear), pick which `@evidence` specs
 * the capture lane should run. See the module header for the full contract.
 *
 * `coversMap` is optional: when supplied, the `some` set is widened to the
 * union of the changed specs AND every spec whose covers globs render a changed
 * visual file. Omitted (or a failed load) → just the changed specs, unchanged.
 */
export function selectEvidenceSpecs(
  changedFiles: readonly string[],
  coversMap?: CoversMap | null,
): SelectResult {
  const changedSpecs = changedFiles.filter(isSpecFile);
  const changedVisual = changedFiles.filter(isVisualSurfaceFile);

  if (changedSpecs.length === 0 && changedVisual.length === 0) {
    return { mode: "none" };
  }
  if (changedSpecs.length > 0) {
    const specs = new Set(changedSpecs.map(toWebRelativeSpecPath));
    if (coversMap) {
      for (const file of changedVisual) {
        for (const spec of coveringSpecsForFile(file, coversMap)) {
          specs.add(toWebRelativeSpecPath(spec));
        }
      }
    }
    return { mode: "some", specs: Array.from(specs).sort() };
  }
  // Visual surface changed but no spec did — only possible past the hard gate
  // via `evidence-exempt`. Can't attribute the change to a changed spec → run
  // everything (the covers map does not re-scope the fail-open branch).
  return { mode: "all" };
}

/**
 * Diff base...HEAD (ACMR: added/copied/modified/renamed — never deleted) and
 * return the trimmed, non-empty changed-file paths. Throws on a non-zero git
 * exit so `main()` can fail-open; a clean run with an empty diff returns `[]`
 * (→ __NONE__, the intended main-push behaviour).
 */
async function readChangedFiles(base: string): Promise<string[]> {
  const proc = Bun.spawn(
    ["git", "diff", "--diff-filter=ACMR", "--name-only", `${base}...HEAD`],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`git diff exited ${code}`);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  try {
    const base = process.env.BASE_REF || "origin/main";
    const changed = await readChangedFiles(base);
    const coversMap = await loadCoversMap();
    const result = selectEvidenceSpecs(changed, coversMap);
    if (result.mode === "none") {
      console.log("__NONE__");
    } else if (result.mode === "all") {
      console.log("__ALL__");
    } else {
      console.log(result.specs.join("\n"));
    }
  } catch {
    // Fail-open: never silently skip evidence on an internal error.
    console.log("__ALL__");
  }
}

if (import.meta.main) {
  await main();
}
